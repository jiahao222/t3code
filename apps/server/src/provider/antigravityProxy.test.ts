import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { resolveAntigravityProxyEnvironment } from "./antigravityProxy.ts";

const systemProxy = `
<dictionary> {
 HTTPEnable : 1
 HTTPProxy : 127.0.0.1
 HTTPPort : 7897
 HTTPSEnable : 1
 HTTPSProxy : 127.0.0.1
 HTTPSPort : 7897
}`;

it.effect("passes the macOS proxy to OAuth subprocesses without overriding explicit settings", () =>
  Effect.gen(function* () {
    let calls = 0;
    let output = systemProxy;
    const spawner = ChildProcessSpawner.make(() => {
      calls++;
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(output)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
    const base = { PATH: "/usr/bin", no_proxy: "internal.example" };
    const result = yield* resolveAntigravityProxyEnvironment(base).pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    assert.equal(result.HTTP_PROXY, "http://127.0.0.1:7897");
    assert.equal(result.HTTPS_PROXY, "http://127.0.0.1:7897");
    assert.equal(result.NO_PROXY, "internal.example,localhost,127.0.0.1,::1");
    assert.deepEqual(base, { PATH: "/usr/bin", no_proxy: "internal.example" });
    for (const explicit of [
      { HTTPS_PROXY: "http://custom:8080" },
      { https_proxy: "" },
      { ALL_PROXY: "socks5://custom:1080" },
    ]) {
      const result = yield* resolveAntigravityProxyEnvironment(explicit).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.strictEqual(result, explicit);
    }
    const linux = yield* resolveAntigravityProxyEnvironment(base).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    assert.strictEqual(linux, base);
    assert.equal(calls, 1);
    for (const invalid of [
      "",
      systemProxy.replaceAll("Enable : 1", "Enable : 0"),
      systemProxy.replaceAll("7897", "70000"),
      systemProxy.replaceAll("127.0.0.1", "bad/path"),
    ]) {
      output = invalid;
      const result = yield* resolveAntigravityProxyEnvironment(base).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.strictEqual(result, base);
    }
  }),
);
