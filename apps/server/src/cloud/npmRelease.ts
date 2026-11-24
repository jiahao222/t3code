// @effect-diagnostics effectFnOpportunity:off
import {
  ServerNpmReleaseError,
  type ServerNpmRelease,
  type ServerNpmReleaseInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class NpmRelease extends Context.Service<
  NpmRelease,
  {
    readonly get: (
      input: ServerNpmReleaseInput,
    ) => Effect.Effect<ServerNpmRelease | null, ServerNpmReleaseError>;
  }
>()("t3/cloud/npmRelease") {}

export const make = Effect.fn("NpmRelease.make")(function* () {
  return NpmRelease.of({
    get: () =>
      Effect.fail(
        new ServerNpmReleaseError({
          reason: "Online release lookups are disabled in local-only mode.",
        }),
      ),
  });
});

export const layer = Layer.effect(NpmRelease, make());
