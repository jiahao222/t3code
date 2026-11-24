import { relayClerkTokenOptions } from "@t3tools/shared/relayAuth";
import * as Schema from "effect/Schema";

export class CloudPublicConfigMissingError extends Schema.TaggedError<CloudPublicConfigMissingError>()(
  "CloudPublicConfigMissingError",
  {
    key: Schema.Literal("T3CODE_CLERK_JWT_TEMPLATE"),
  },
) {
  override get message(): string {
    return `${this.key} is not configured (disabled in local-only mode).`;
  }
}

export interface CloudPublicConfig {
  readonly clerkPublishableKey: string | null;
  readonly clerkJwtTemplate: string | null;
  readonly relayUrl: string | null;
  readonly relayTracing: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

export function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  return {
    clerkPublishableKey: null,
    clerkJwtTemplate: null,
    relayUrl: null,
    relayTracing: {
      tracesUrl: null,
      tracesDataset: null,
      tracesToken: null,
    },
  };
}

export function relayTelemetryEnabled(): boolean | null {
  return false;
}

export function resolveRelayTracingConfig(): {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
} | null {
  return null;
}

export function hasCloudPublicConfig(): boolean {
  return false;
}

export function resolveRelayClerkTokenOptions() {
  if (hasCloudPublicConfig()) {
    return relayClerkTokenOptions("local-only-disabled");
  }
  throw new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" });
}
