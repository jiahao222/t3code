import * as SharedObservability from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redactable from "effect/Redactable";
import * as References from "effect/References";

import * as ServerConfig from "./config.ts";

const redactingCredentials = <Output>(logger: Logger.Logger<unknown, Output>) =>
  Logger.make<unknown, Output>((options) =>
    logger.log({ ...options, cause: SharedObservability.redactCauseCredentials(options.cause) }),
  );

const consolePretty = (): Logger.Logger<unknown, void> => {
  const pretty = redactingCredentials(Logger.consolePretty());
  return Logger.make((options) =>
    pretty.log({
      ...options,
      message: Array.isArray(options.message)
        ? options.message.map(prettyCauseFields)
        : prettyCauseFields(options.message),
    }),
  );
};

function prettyCauseFields(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  if (Redactable.isRedactable(value)) return value;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  let changed = false;
  for (const descriptor of Object.values(descriptors)) {
    if ("value" in descriptor && Cause.isCause(descriptor.value)) {
      descriptor.value = Cause.pretty(descriptor.value);
      changed = true;
    }
  }
  return changed ? Object.create(prototype, descriptors) : value;
}

export const layer = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const layerMinimumLogLevel = Layer.succeed(References.MinimumLogLevel, config.logLevel);
  const layerLogger = Logger.layer([consolePretty(), Logger.tracerLogger], {
    mergeWithExisting: false,
  });
  return Layer.mergeAll(layerLogger, layerMinimumLogLevel);
}).pipe(Layer.unwrap);
