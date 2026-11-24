// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import * as CloudLink from "../cloud/CloudLink.ts";
import * as OtlpEndpointCheck from "../observability/OtlpEndpointCheck.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import { getServerOwnersForHome, getTelemetryIdentityForHome } from "./Identify.ts";

describe("local-only Layer 1 privacy & cloud disconnection", () => {
  it("never reads ~/.codex/auth.json or ~/.claude.json and never writes anonymous-id", async () => {
    const tempHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-privacy-home-"));
    try {
      const codexDir = NodePath.join(tempHome, ".codex");
      NodeFS.mkdirSync(codexDir, { recursive: true });
      const codexAuth = NodePath.join(codexDir, "auth.json");
      const claudeJson = NodePath.join(tempHome, ".claude.json");
      NodeFS.writeFileSync(
        codexAuth,
        JSON.stringify({ tokens: { account_id: "acct_secret", id_token: "a.b.c" } }),
      );
      NodeFS.writeFileSync(
        claudeJson,
        JSON.stringify({ userID: "claude_secret", oauthAccount: { accountUuid: "uuid_secret" } }),
      );

      const identity = await Effect.runPromise(getTelemetryIdentityForHome(tempHome));
      const owners = await Effect.runPromise(getServerOwnersForHome(tempHome));

      expect(identity).toEqual({ distinctId: null, installId: null });
      expect(owners).toEqual([]);
      expect(NodeFS.existsSync(NodePath.join(tempHome, "anonymous-id"))).toBe(false);
    } finally {
      NodeFS.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("never exports analytics, OTLP probes, or CloudLink requests even with override env vars", async () => {
    let trapHits = 0;
    const trapServer = NodeHttp.createServer((_req, res) => {
      trapHits += 1;
      res.writeHead(200);
      res.end("{}");
    });
    const trapPort = await new Promise<number>((resolve) => {
      trapServer.listen(0, "127.0.0.1", () => {
        resolve((trapServer.address() as NodeNet.AddressInfo).port);
      });
    });

    try {
      process.env.T3CODE_TELEMETRY_ENABLED = "true";
      process.env.T3CODE_POSTHOG_HOST = `http://127.0.0.1:${trapPort}`;

      await Effect.runPromise(
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          yield* analytics.record("server.boot.heartbeat", { threadCount: 5 });
          yield* analytics.recordOwners([{ source: "openai", ownerId: "test" }], "server");
          yield* analytics.flush;

          const otlpCheck = yield* OtlpEndpointCheck.OtlpEndpointCheck;
          const otlpRes = yield* otlpCheck.check({
            signal: "traces",
            url: `http://127.0.0.1:${trapPort}/v1/traces`,
          });
          expect(otlpRes).toEqual({ _tag: "Unreachable", timedOut: false });

          const cloudLink = yield* CloudLink.CloudLink;
          const state = yield* cloudLink.linkState();
          expect(state.linked).toBe(false);
          expect(state.relayUrl).toBeNull();

          const unlinked = yield* cloudLink.unlink();
          expect(unlinked).toEqual({
            ok: true,
            endpointRuntimeStatus: { status: "disabled" },
          });

          const reconciled = yield* cloudLink.reconcileDesiredLinkIfStillDesired(
            `http://127.0.0.1:${trapPort}`,
          );
          expect(reconciled).toBeNull();

          const released = yield* cloudLink.releaseManagedTunnelOnShutdown();
          expect(released).toBe(false);

          const linkProofExit = yield* Effect.exit(
            cloudLink.linkProof({ challengeId: "c1", userId: "u1" } as never),
          );
          expect(Exit.isFailure(linkProofExit)).toBe(true);
        }).pipe(
          Effect.provide(AnalyticsService.layer),
          Effect.provide(OtlpEndpointCheck.layer),
          Effect.provide(CloudLink.layer),
        ),
      );

      expect(trapHits).toBe(0);
    } finally {
      await new Promise<void>((resolve) => trapServer.close(() => resolve()));
    }
  });
});
