import {
  connectLoopbackRedirectUri,
  CONNECT_OAUTH_SCOPES,
} from "@t3tools/shared/connectAuth";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const CLOUD_CLI_OAUTH_LOOPBACK_PORT = 34338;
const CLOUD_CLI_OAUTH_SCOPES = CONNECT_OAUTH_SCOPES;

function localOnlyDisabledConfigError(feature: string) {
  return new Config.ConfigError(
    new Schema.SchemaError(
      new SchemaIssue.InvalidValue({
        message: `${feature} is disabled in local-only mode.`,
      }),
    ),
  );
}

export function resolveRelayClientTracingConfig(
  _env?: Readonly<Record<string, string | undefined>>,
  _fallback?: {
    readonly tracesUrl: string;
    readonly tracesDataset: string;
    readonly tracesToken: string;
  },
): {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
} | null {
  return null;
}

export function makeRelayUrlConfig(_fallback = ""): Config.Config<string> {
  return Config.succeed("").pipe(
    Config.mapEffect(() => Effect.fail(localOnlyDisabledConfigError("T3 Relay"))),
  );
}

export const relayUrlConfig = makeRelayUrlConfig();

export const hostedAppUrlConfig = Config.succeed("http://127.0.0.1:1");

export const agentApprovalAppUrlConfig = Config.succeed("http://127.0.0.1:1");

export interface CloudCliOAuthConfig {
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly clientId: string;
  readonly loopbackPort: number;
  readonly redirectUri: string;
  readonly scopes: typeof CLOUD_CLI_OAUTH_SCOPES;
}

export function makeCloudCliOAuthConfig(_options?: {
  readonly clerkPublishableKeyFallback?: string;
  readonly clerkCliOAuthClientIdFallback?: string;
}): Config.Config<CloudCliOAuthConfig> {
  return Config.succeed(null).pipe(
    Config.mapEffect(
      (): Effect.Effect<CloudCliOAuthConfig, Config.ConfigError> =>
        Effect.fail(localOnlyDisabledConfigError("T3 Connect Clerk OAuth")),
    ),
  );
}

export const cloudCliOAuthConfig = makeCloudCliOAuthConfig();

export const hasCloudPublicConfig = false;

// Keep helper reference alive if needed for type compatibility
void connectLoopbackRedirectUri;
void CLOUD_CLI_OAUTH_LOOPBACK_PORT;
