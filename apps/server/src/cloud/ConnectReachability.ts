import {
  connectReachabilityHelpUrl,
  type EnvironmentConnectReachability,
} from "@t3tools/contracts";
import type { TailscaleExitNode } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

export type EndpointProbe =
  | { readonly kind: "status"; readonly status: number; readonly cloudflareError?: string }
  | {
      readonly kind: "dns_failed";
      readonly existsPublicly?: boolean;
    }
  | { readonly kind: "timeout" | "network_error" };

export interface ReachabilityFacts {
  readonly managedTunnelConfigured: boolean;
  readonly connector: ManagedEndpointRuntime.ConnectorFacts | null;
  readonly endpoint: EndpointProbe | null;
  readonly edgeReachable: boolean | null;
  readonly exitNode: TailscaleExitNode | null;
}

type Unreachable = Extract<EnvironmentConnectReachability, { status: "unreachable" }>;

export function classifyReachability(
  _facts: ReachabilityFacts,
  checkedAt: string,
): EnvironmentConnectReachability {
  return {
    status: "unreachable",
    checkedAt,
    cause: "not_linked",
    reason: "T3 Connect is disabled in local-only mode.",
    hint: null,
    fix: "T3 Connect and remote relay tunnels are disabled in this local-only build.",
  };
}

export function formatReachabilityFailure(result: Unreachable): string {
  return [
    "✕ T3 Connect is disabled in local-only mode",
    `  ${result.reason}`,
    ...(result.hint ? [`  ${result.hint}`] : []),
    `  Fix: ${result.fix}`,
    `  More info: ${connectReachabilityHelpUrl(result.cause)}`,
  ].join("\n");
}

export class ConnectReachability extends Context.Service<
  ConnectReachability,
  {
    readonly check: Effect.Effect<EnvironmentConnectReachability>;
    readonly latest: Effect.Effect<Option.Option<EnvironmentConnectReachability>>;
  }
>()("t3/cloud/ConnectReachability") {}

const make = Effect.succeed(
  ConnectReachability.of({
    check: DateTime.now.pipe(
      Effect.map((now) =>
        classifyReachability(
          {
            managedTunnelConfigured: false,
            connector: null,
            endpoint: null,
            edgeReachable: null,
            exitNode: null,
          },
          DateTime.formatIso(now),
        ),
      ),
    ),
    latest: Effect.succeed(Option.none<EnvironmentConnectReachability>()),
  }),
);

export const layer = Layer.effect(ConnectReachability, make);
