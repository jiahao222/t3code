// @effect-diagnostics effectFnOpportunity:off
import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

export const RELAY_CLIENT_LOG_FILE = "relay-client.ndjson";

export function classifyRelayClientOutput(
  line: string,
): "connected" | "unregistered" | "warning" | "debug" {
  if (/\bRegistered tunnel connection\b/iu.test(line)) {
    return "connected";
  }
  if (
    /\bERR\s+(?:Request failed\s+)?error="Incoming request ended abruptly: context canceled"(?:\s|$)/u.test(
      line,
    )
  ) {
    return "debug";
  }
  if (/\b(?:ERR|WRN|FTL|PNC)\b/u.test(line)) {
    return "warning";
  }
  return /\bINF\b.*\bUnregistered tunnel connection\b/u.test(line) ? "unregistered" : "debug";
}

export function isRejectedRelayClientTunnelOutput(line: string): boolean {
  return (
    /\bRegister tunnel error from server side\b/iu.test(line) &&
    /error="(?:Unauthorized:[^"]*|Failed to get tunnel|Tunnel not found|Record for tunnel not found|Invalid tunnel secret)"/iu.test(
      line,
    )
  );
}

export function isRetryableManagedEndpointRuntimeStatus(status: unknown): boolean {
  if (typeof status !== "object" || status === null || !("status" in status)) {
    return false;
  }
  if (status.status !== "failed" || !("failure" in status)) {
    return false;
  }
  return status.failure === "not-installed" || status.failure === "spawn-failed";
}

export type CloudManagedEndpointRuntimeStatus =
  | {
      readonly status: "disabled";
    }
  | {
      readonly status: "failed";
      readonly providerKind: RelayManagedEndpointRuntimeConfig["providerKind"];
      readonly failure: "unsupported-platform" | "not-installed" | "spawn-failed";
      readonly reason: string;
      readonly tunnelId?: string;
      readonly tunnelName?: string;
    }
  | {
      readonly status: "running";
      readonly providerKind: "cloudflare_tunnel";
      readonly pid: number;
      readonly tunnelId?: string;
      readonly tunnelName?: string;
    }
  | {
      readonly status: "unsupported";
      readonly providerKind: RelayManagedEndpointRuntimeConfig["providerKind"];
    };

export interface ConnectorFacts {
  readonly pid: number;
  readonly readyConnections: number | null;
  readonly hostname: string | null;
  readonly origin: string | null;
  readonly protocol: string | null;
}

export class CloudManagedEndpointRuntime extends Context.Service<
  CloudManagedEndpointRuntime,
  {
    readonly applyConfig: (
      config: RelayManagedEndpointRuntimeConfig | null,
    ) => Effect.Effect<CloudManagedEndpointRuntimeStatus>;
    readonly inspectConnector: Effect.Effect<ConnectorFacts | null>;
    readonly readinessChanged: Stream.Stream<void>;
    readonly recoveryRequests: Stream.Stream<RelayManagedEndpointRuntimeConfig>;
    readonly requestRecovery: (config: RelayManagedEndpointRuntimeConfig) => Effect.Effect<void>;
    readonly restartConnector: (
      pid: number,
      stillDead: Effect.Effect<boolean>,
    ) => Effect.Effect<boolean>;
    readonly tunnelConnected: Stream.Stream<void>;
    readonly withLinkStateLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/cloud/ManagedEndpointRuntime/CloudManagedEndpointRuntime") {}

const make = Effect.gen(function* () {
  const linkStateLock = yield* Semaphore.make(1);
  return CloudManagedEndpointRuntime.of({
    applyConfig: () => Effect.succeed({ status: "disabled" as const }),
    inspectConnector: Effect.succeed(null),
    readinessChanged: Stream.empty,
    recoveryRequests: Stream.empty,
    requestRecovery: () => Effect.void,
    restartConnector: () => Effect.succeed(false),
    tunnelConnected: Stream.empty,
    withLinkStateLock: (effect) => linkStateLock.withPermits(1)(effect),
  });
});

export const layer = Layer.effect(CloudManagedEndpointRuntime, make);
