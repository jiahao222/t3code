import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export const resolveAntigravityProxyEnvironment = Effect.fn("resolveAntigravityProxyEnvironment")(
  function* (environment: NodeJS.ProcessEnv) {
    if ((yield* HostProcess.Platform) !== "darwin") return environment;
    // Go's OAuth client does not read macOS system proxy settings.
    if (
      ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].some(
        (key) => environment[key] !== undefined,
      )
    )
      return environment;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = yield* spawner
      .string(
        ChildProcess.make("/usr/sbin/scutil", ["--proxy"], { stdin: "ignore", stderr: "ignore" }),
      )
      .pipe(
        Effect.timeout("2 seconds"),
        Effect.orElseSucceed(() => ""),
      );
    const value = (key: string) =>
      output.match(new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, "m"))?.[1];
    const proxy = (prefix: string) => {
      if (value(`${prefix}Enable`) !== "1") return undefined;
      const host = value(`${prefix}Proxy`);
      const port = Number(value(`${prefix}Port`));
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || /[\s/@?#]/.test(host))
        return undefined;
      const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      try {
        return new URL(`http://${authority}:${port}`).origin;
      } catch {
        return undefined;
      }
    };
    const httpProxy = proxy("HTTP");
    const httpsProxy = proxy("HTTPS");
    if (!httpProxy && !httpsProxy) return environment;
    return {
      ...environment,
      ...(httpProxy ? { HTTP_PROXY: httpProxy } : {}),
      ...(httpsProxy ? { HTTPS_PROXY: httpsProxy } : {}),
      NO_PROXY: [environment.NO_PROXY ?? environment.no_proxy, "localhost", "127.0.0.1", "::1"]
        .filter(Boolean)
        .join(","),
    };
  },
);
