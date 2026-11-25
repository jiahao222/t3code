// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Direct runtime tests for Node network, DNS, redirect, proxy, and subprocess guards.
import * as NodeChildProcess from "node:child_process";
import * as NodeDgram from "node:dgram";
import * as NodeDns from "node:dns";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  checkOutboundUrlPolicy,
  installLocalEgressGuard,
  isAllowedOfficialVendorHost,
  isBlockedT3OrTelemetryHost,
  isLoopbackHostname,
  isStrictLoopbackIp,
} from "./localEgressGuard.ts";

describe("localEgressGuard policy & runtime enforcement", () => {
  let localServer: NodeHttp.Server;
  let localPort = 0;
  let proxyHits = 0;
  let proxyServer: NodeHttp.Server;
  let proxyPort = 0;

  beforeAll(async () => {
    proxyServer = NodeHttp.createServer((_req, res) => {
      proxyHits += 1;
      res.writeHead(200);
      res.end("proxy-reached");
    });
    await new Promise<void>((resolve) => {
      proxyServer.listen(0, "127.0.0.1", () => {
        const addr = proxyServer.address() as NodeNet.AddressInfo;
        proxyPort = addr.port;
        resolve();
      });
    });

    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    process.env.T3CODE_TELEMETRY_ENABLED = "true";
    process.env.T3CODE_POSTHOG_HOST = "https://ingest.t3.codes";
    process.env.T3CODE_OTLP_TRACES_URL = "https://otel.t3.codes/v1/traces";

    installLocalEgressGuard("server");

    localServer = NodeHttp.createServer((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/redirect-t3") {
        res.writeHead(302, { location: "https://ingest.t3.codes/batch/" });
        res.end();
        return;
      }
      if (req.url === "/redirect-lan") {
        res.writeHead(302, { location: "http://172.16.42.45:8787/secret" });
        res.end();
        return;
      }
      if (req.url === "/redirect-local") {
        res.writeHead(302, { location: `http://127.0.0.1:${localPort}/ok` });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      localServer.listen(0, "127.0.0.1", () => {
        const addr = localServer.address() as NodeNet.AddressInfo;
        localPort = addr.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => localServer.close(() => resolve()));
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
  });

  it("classifies strict loopback IPs and rejects LAN / mapped-LAN / unspecified IPs", () => {
    expect(isStrictLoopbackIp("127.0.0.1")).toBe(true);
    expect(isStrictLoopbackIp("127.255.255.254")).toBe(true);
    expect(isStrictLoopbackIp("::1")).toBe(true);
    expect(isStrictLoopbackIp("[::1]")).toBe(true);
    expect(isStrictLoopbackIp("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("preview.localhost")).toBe(true);

    expect(isStrictLoopbackIp("0.0.0.0")).toBe(false);
    expect(isStrictLoopbackIp("::")).toBe(false);
    expect(isStrictLoopbackIp("172.16.42.45")).toBe(false);
    expect(isStrictLoopbackIp("::ffff:172.16.42.45")).toBe(false);
    expect(isStrictLoopbackIp("198.18.0.19")).toBe(false);
    expect(isStrictLoopbackIp("100.64.0.1")).toBe(false);
    expect(isStrictLoopbackIp("2606:4700:4700::1111")).toBe(false);
  });

  it("blocks all T3-owned, telemetry, Clerk, PostHog, and pingdotgg URLs while allowing official agent/quota endpoints", () => {
    // Blocked T3 / telemetry / cloud / repo endpoints
    expect(isBlockedT3OrTelemetryHost("t3.codes")).toBe(true);
    expect(isBlockedT3OrTelemetryHost("ingest.t3.codes")).toBe(true);
    expect(isBlockedT3OrTelemetryHost("relay.t3.codes")).toBe(true);
    expect(isBlockedT3OrTelemetryHost("nightly.app.t3.codes")).toBe(true);
    expect(isBlockedT3OrTelemetryHost("clerk.t3.codes")).toBe(true);
    expect(isBlockedT3OrTelemetryHost("us.i.posthog.com")).toBe(true);
    expect(isBlockedT3OrTelemetryHost("foo.clerk.accounts.dev")).toBe(true);
    expect(checkOutboundUrlPolicy("https://ingest.t3.codes/batch/", "server", "POST").allowed).toBe(
      false,
    );
    expect(
      checkOutboundUrlPolicy(
        "https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/server/src/provider/model-manifest.json",
        "server",
      ).allowed,
    ).toBe(false);
    expect(checkOutboundUrlPolicy("https://registry.npmjs.org/t3/latest", "server").allowed).toBe(
      false,
    );
    expect(
      checkOutboundUrlPolicy("https://registry.npmjs.org/@t3tools/desktop", "server").allowed,
    ).toBe(false);
    expect(checkOutboundUrlPolicy("https://open-vsx.org/api/-/search", "server").allowed).toBe(
      false,
    );

    // Allowed official vendor quota, auth, pricing, and ACP registry endpoints in server mode
    expect(isAllowedOfficialVendorHost("oauth2.googleapis.com", "server")).toBe(true);
    expect(isAllowedOfficialVendorHost("cloudcode-pa.googleapis.com", "server")).toBe(true);
    expect(isAllowedOfficialVendorHost("daily-cloudcode-pa.googleapis.com", "server")).toBe(true);
    expect(
      checkOutboundUrlPolicy("https://oauth2.googleapis.com/token", "server", "POST").allowed,
    ).toBe(true);
    expect(
      checkOutboundUrlPolicy(
        "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
        "server",
        "POST",
      ).allowed,
    ).toBe(true);
    expect(
      checkOutboundUrlPolicy("https://api.anthropic.com/api/oauth/usage", "server", "GET").allowed,
    ).toBe(true);
    expect(
      checkOutboundUrlPolicy("https://api.openai.com/v1/models", "server", "GET").allowed,
    ).toBe(true);
    expect(
      checkOutboundUrlPolicy(
        "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
        "server",
        "GET",
      ).allowed,
    ).toBe(true);
    expect(
      checkOutboundUrlPolicy(
        "https://cdn.agentclientprotocol.com/registry/v1/latest/index.json",
        "server",
        "GET",
      ).allowed,
    ).toBe(true);

    // Desktop renderer/webview mode blocks POSTs and general external sites
    expect(
      checkOutboundUrlPolicy("https://oauth2.googleapis.com/token", "desktop", "POST").allowed,
    ).toBe(false);
    expect(checkOutboundUrlPolicy("https://example.com/", "desktop", "GET").allowed).toBe(false);
    expect(checkOutboundUrlPolicy("http://172.16.42.45:8080/", "desktop", "GET").allowed).toBe(
      false,
    );
  });

  it("allows loopback fetch and local->local redirect, while blocking T3, LAN, IPv6, proxy bypass, and local->external redirects", async () => {
    const okRes = await fetch(`http://127.0.0.1:${localPort}/ok`);
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ ok: true });

    const localRedirectRes = await fetch(`http://127.0.0.1:${localPort}/redirect-local`);
    expect(localRedirectRes.status).toBe(200);

    // Blocked T3 ingest even when HTTP_PROXY was set before guard installation
    await expect(
      fetch("https://ingest.t3.codes/batch/", { method: "POST", body: "{}" }),
    ).rejects.toThrow(/blocked by local-only policy/i);
    expect(proxyHits).toBe(0);

    // Blocked redirect from 127.0.0.1 -> T3 ingest
    await expect(fetch(`http://127.0.0.1:${localPort}/redirect-t3`)).rejects.toThrow(
      /blocked by local-only policy/i,
    );

    // Blocked redirect from 127.0.0.1 -> LAN IP
    await expect(fetch(`http://127.0.0.1:${localPort}/redirect-lan`)).rejects.toThrow(
      /blocked by local-only policy/i,
    );

    // Blocked direct LAN, mapped-IPv6 LAN, Fake-IP literal, and public IPv6
    await expect(fetch("http://172.16.42.45:8787/")).rejects.toThrow(
      /blocked by local-only policy/i,
    );
    await expect(fetch("http://[::ffff:172.16.42.45]:8787/")).rejects.toThrow(
      /blocked by local-only policy/i,
    );
    await expect(fetch("https://[2606:4700:4700::1111]/")).rejects.toThrow(
      /blocked by local-only policy/i,
    );

    // Blocked external WebSocket
    expect(() => new WebSocket("wss://relay.t3.codes/ws")).toThrow(/blocked by local-only policy/i);
  });

  it("preserves an explicit proxy dispatcher across allowed redirects without allowing blocked targets", () => {
    const output = NodeChildProcess.execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { installLocalEgressGuard } from ${JSON.stringify(new URL("./localEgressGuard.ts", import.meta.url).href)};
        const dispatcher = {};
        const requests = [];
        globalThis.fetch = async (url, init) => {
          requests.push({ url: String(url), proxied: init.dispatcher === dispatcher });
          if (String(url).endsWith("/blocked")) {
            return new Response(null, { status: 302, headers: { location: "https://example.com/" } });
          }
          if (String(url).endsWith("/token")) {
            return new Response(null, { status: 302, headers: { location: "https://www.googleapis.com/oauth2/v2/userinfo" } });
          }
          return new Response("ok");
        };
        installLocalEgressGuard("server");
        const response = await fetch("https://oauth2.googleapis.com/token", { dispatcher });
        let blocked = false;
        try {
          await fetch("https://oauth2.googleapis.com/blocked", { dispatcher });
        } catch (error) {
          blocked = error.name === "LocalEgressBlockedError";
        }
        console.log(JSON.stringify({ body: await response.text(), blocked, requests }));
      `,
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({
      body: "ok",
      blocked: true,
      requests: [
        { url: "https://oauth2.googleapis.com/token", proxied: true },
        { url: "https://www.googleapis.com/oauth2/v2/userinfo", proxied: true },
        { url: "https://oauth2.googleapis.com/blocked", proxied: true },
      ],
    });
  });

  it("blocks DNS lookup for T3/unlisted domains, UDP send to external IPs, non-loopback server listen, and cloudflared/tailscale subprocesses", async () => {
    // DNS lookup blocked for ingest.t3.codes
    await expect(NodeDns.promises.lookup("ingest.t3.codes")).rejects.toThrow(/ENOTFOUND/);

    // Synthetic localhost lookup succeeds without external DNS
    const lo = await NodeDns.promises.lookup("localhost");
    expect(lo.address).toBe("127.0.0.1");

    // UDP send to external IP blocked
    await new Promise<void>((resolve, reject) => {
      const udp = NodeDgram.createSocket("udp4");
      udp.send(Buffer.from("ping"), 53, "1.1.1.1", (err) => {
        udp.close();
        try {
          expect(err).toBeTruthy();
          expect(err?.message).toMatch(/blocked by local-only policy/i);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    // Non-loopback TCP listen rejected
    await new Promise<void>((resolve, reject) => {
      const srv = NodeNet.createServer();
      srv.once("error", (err) => {
        try {
          expect((err as NodeJS.ErrnoException).code).toBe("EADDRNOTAVAIL");
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      srv.listen(0, "172.16.42.45");
    });

    // Blocked subprocesses
    expect(() => NodeChildProcess.spawn("cloudflared", ["tunnel", "run"])).toThrow(
      /blocked by local-only policy/i,
    );
    expect(() => NodeChildProcess.spawn("tailscale", ["serve", "status"])).toThrow(
      /blocked by local-only policy/i,
    );
    expect(() =>
      NodeChildProcess.spawn("git", ["ls-remote", "https://github.com/pingdotgg/t3code"]),
    ).toThrow(/blocked by local-only policy/i);

    // Normal subprocesses (like ACP agents) remain allowed
    const out = NodeChildProcess.execFileSync(process.execPath, [
      "-e",
      "process.stdout.write('acp-ok')",
    ]);
    expect(out.toString()).toBe("acp-ok");
  });
});
