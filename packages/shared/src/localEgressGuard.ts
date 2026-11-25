// @effect-diagnostics nodeBuiltinImport:off extendsNativeError:off globalDate:off - Process-wide egress policy patches Node network, DNS, and child_process primitives at startup.
import * as NodeChildProcess from "node:child_process";
import * as NodeDgram from "node:dgram";
import * as NodeDns from "node:dns";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttp2 from "node:http2";
import * as NodeHttps from "node:https";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";

const cjsRequire = NodeModule.createRequire(import.meta.url);

export type LocalEgressMode = "server" | "desktop";

export class LocalEgressBlockedError extends Error {
  readonly code: string;
  readonly target: string;
  readonly reason: string;

  constructor(target: string, reason: string, code = "EACCES") {
    super(`Outbound network blocked by local-only policy (${reason}): ${target}`);
    this.name = "LocalEgressBlockedError";
    this.code = code;
    this.target = target;
    this.reason = reason;
  }
}

const DNS_LEASE_TTL_MS = 5 * 60 * 1000;
const MAX_REDIRECT_HOPS = 10;

const BLOCKED_HOST_SUFFIXES = [
  "t3.codes",
  "t3.gg",
  "ping.gg",
  "posthog.com",
  "clerk.com",
  "clerk.accounts.dev",
  "clerk.shared.lcl.dev",
  "sentry.io",
  "datadoghq.com",
  "axiom.co",
  "challenges.cloudflare.com",
  "argotunnel.com",
  "api.expo.dev",
  "open-vsx.org",
] as const;

const ALLOWED_SERVER_EXACT_HOSTS = new Set([
  // Google / Antigravity OAuth, quota, CLI release, and model endpoints
  "oauth2.googleapis.com",
  "www.googleapis.com",
  "accounts.google.com",
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "antigravity-cli-auto-updater-974169037036.us-central1.run.app",
  "storage.googleapis.com",
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
  // OpenAI / Codex official auth, models, quota, and CLI releases
  "api.openai.com",
  "auth.openai.com",
  "chatgpt.com",
  "releases.openai.com",
  // Anthropic / Claude official auth, quota, credits, and CLI releases
  "api.anthropic.com",
  "claude.ai",
  "downloads.claude.ai",
  "platform.claude.com",
  // Mistral / Vibe official endpoints
  "api.mistral.ai",
  "console.mistral.ai",
  "mistral.ai",
  "pypi.org",
  "files.pythonhosted.org",
  // Cursor / xAI / OpenRouter official provider endpoints
  "api2.cursor.sh",
  "api.cursor.com",
  "downloads.cursor.com",
  "api.x.ai",
  "openrouter.ai",
  // Official ACP Registry & LiteLLM pricing / official agent release assets
  "cdn.agentclientprotocol.com",
  "agentclientprotocol.com",
  "raw.githubusercontent.com",
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "codeload.github.com",
  "registry.npmjs.org",
]);

const ALLOWED_DESKTOP_EXACT_HOSTS = new Set(["cdn.agentclientprotocol.com"]);

function stripBracketsAndZone(rawHost: string): string {
  const trimmed = rawHost
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  const zoneIndex = trimmed.indexOf("%");
  return (zoneIndex === -1 ? trimmed : trimmed.slice(0, zoneIndex)).toLowerCase();
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

export function isStrictLoopbackIp(rawAddress: string): boolean {
  const host = stripBracketsAndZone(rawAddress);
  if (!host) return false;

  const v4 = parseIpv4Octets(host);
  if (v4 !== null) {
    return v4[0] === 127;
  }

  if (NodeNet.isIPv6(host)) {
    if (host === "::1" || host === "0:0:0:0:0:0:0:1") {
      return true;
    }
    if (host.startsWith("::ffff:")) {
      const tail = host.slice("::ffff:".length);
      const mappedV4 = parseIpv4Octets(tail);
      if (mappedV4 !== null) {
        return mappedV4[0] === 127;
      }
      // Hex form ::ffff:7f00:0001
      const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
      if (hexMatch) {
        const hi = Number.parseInt(hexMatch[1]!, 16);
        return hi >> 8 === 127;
      }
    }
  }

  return false;
}

export function isLoopbackHostname(rawHost: string): boolean {
  const host = stripBracketsAndZone(rawHost);
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }
  return isStrictLoopbackIp(host);
}

export function isSafeUnixSocketPath(socketPath: unknown): socketPath is string {
  return (
    typeof socketPath === "string" &&
    socketPath.length > 0 &&
    !socketPath.startsWith("\\\\") &&
    !socketPath.startsWith("//")
  );
}

export function isBlockedT3OrTelemetryHost(rawHost: string): boolean {
  const host = stripBracketsAndZone(rawHost);
  if (!host) return false;
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      return true;
    }
  }
  return false;
}

function isBlockedSharedHostPath(host: string, pathname: string): boolean {
  const lowerPath = pathname.toLowerCase();
  if (
    host === "github.com" ||
    host === "raw.githubusercontent.com" ||
    host === "codeload.github.com"
  ) {
    if (lowerPath === "/pingdotgg" || lowerPath.startsWith("/pingdotgg/")) {
      return true;
    }
  }
  if (host === "api.github.com") {
    if (
      lowerPath === "/repos/pingdotgg" ||
      lowerPath.startsWith("/repos/pingdotgg/") ||
      lowerPath.startsWith("/orgs/pingdotgg")
    ) {
      return true;
    }
  }
  if (host === "registry.npmjs.org") {
    const decodedPath = decodeURIComponent(lowerPath);
    if (
      decodedPath === "/t3" ||
      decodedPath.startsWith("/t3/") ||
      decodedPath.startsWith("/@t3tools/")
    ) {
      return true;
    }
  }
  return false;
}

function isAllowedSharedHostPath(host: string, pathname: string): boolean {
  const lowerPath = pathname.toLowerCase();
  if (isBlockedSharedHostPath(host, lowerPath)) {
    return false;
  }
  if (host === "storage.googleapis.com") {
    return lowerPath.startsWith("/antigravity-public/");
  }
  if (host === "raw.githubusercontent.com") {
    return lowerPath.startsWith("/berriai/litellm/");
  }
  if (host === "api.github.com") {
    return (
      lowerPath.startsWith("/repos/berriai/litellm/") ||
      lowerPath.startsWith("/repos/openai/") ||
      lowerPath.startsWith("/repos/anthropics/") ||
      lowerPath.startsWith("/repos/mistralai/") ||
      lowerPath.startsWith("/repos/agentclientprotocol/")
    );
  }
  if (host === "github.com" || host === "codeload.github.com") {
    return (
      lowerPath.startsWith("/openai/") ||
      lowerPath.startsWith("/anthropics/") ||
      lowerPath.startsWith("/mistralai/") ||
      lowerPath.startsWith("/agentclientprotocol/")
    );
  }
  if (host === "registry.npmjs.org") {
    const decodedPath = decodeURIComponent(lowerPath);
    return (
      !decodedPath.startsWith("/t3/") &&
      decodedPath !== "/t3" &&
      !decodedPath.startsWith("/@t3tools/")
    );
  }
  return true;
}

export function isAllowedOfficialVendorHost(rawHost: string, mode: LocalEgressMode): boolean {
  const host = stripBracketsAndZone(rawHost);
  if (!host || NodeNet.isIP(host) !== 0) return false;
  if (isBlockedT3OrTelemetryHost(host)) return false;

  if (mode === "desktop") {
    return ALLOWED_DESKTOP_EXACT_HOSTS.has(host);
  }

  if (ALLOWED_SERVER_EXACT_HOSTS.has(host)) {
    return true;
  }
  if (host.endsWith(".aiplatform.googleapis.com")) {
    return true;
  }
  return false;
}

export function checkOutboundUrlPolicy(
  rawUrl: string | URL,
  mode: LocalEgressMode,
  method = "GET",
): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
  let parsed: URL;
  try {
    parsed = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
  } catch {
    return { allowed: false, reason: "invalid-url" };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (
    protocol === "t3code:" ||
    protocol === "t3code-dev:" ||
    protocol === "blob:" ||
    protocol === "data:" ||
    protocol === "about:" ||
    protocol === "devtools:"
  ) {
    return { allowed: true };
  }

  const host = stripBracketsAndZone(parsed.hostname);
  if (!host) {
    return { allowed: false, reason: "missing-host" };
  }

  if (isBlockedT3OrTelemetryHost(host)) {
    return { allowed: false, reason: "blocked-t3-or-telemetry-domain" };
  }

  if (isLoopbackHostname(host)) {
    if (
      protocol === "http:" ||
      protocol === "https:" ||
      protocol === "ws:" ||
      protocol === "wss:"
    ) {
      return { allowed: true };
    }
    return { allowed: false, reason: `unsupported-loopback-protocol:${protocol}` };
  }

  // Non-loopback raw IPs (LAN 172.16.*, 192.168.*, 10.*, Tailscale 100.64.*, Fake-IP 198.18.*, public IPs, IPv6) are denied at URL level
  if (NodeNet.isIP(host) !== 0) {
    return { allowed: false, reason: "non-loopback-ip-literal" };
  }

  if (isBlockedSharedHostPath(host, parsed.pathname)) {
    return { allowed: false, reason: "blocked-t3-shared-host-path" };
  }

  // External official vendor endpoints must use HTTPS (no plaintext HTTP or WebSockets from T3 itself)
  if (protocol !== "https:") {
    return { allowed: false, reason: `external-protocol-not-https:${protocol}` };
  }
  if (parsed.port !== "" && parsed.port !== "443") {
    return { allowed: false, reason: `external-port-not-443:${parsed.port}` };
  }

  if (!isAllowedOfficialVendorHost(host, mode)) {
    return { allowed: false, reason: "unlisted-external-domain" };
  }

  if (!isAllowedSharedHostPath(host, parsed.pathname)) {
    return { allowed: false, reason: "unlisted-shared-host-path" };
  }

  if (mode === "desktop") {
    const upperMethod = method.toUpperCase();
    if (upperMethod !== "GET" && upperMethod !== "HEAD") {
      return { allowed: false, reason: `desktop-method-not-readonly:${upperMethod}` };
    }
    if (!parsed.pathname.startsWith("/registry/")) {
      return { allowed: false, reason: "desktop-path-not-acp-registry" };
    }
  }

  return { allowed: true };
}

export function assertAllowedOutboundUrl(
  rawUrl: string | URL,
  mode: LocalEgressMode,
  method = "GET",
): URL {
  const parsed = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
  const verdict = checkOutboundUrlPolicy(parsed, mode, method);
  if (!verdict.allowed) {
    throw new LocalEgressBlockedError(parsed.href, verdict.reason);
  }
  return parsed;
}

interface AuthorizedDnsEntry {
  readonly hostname: string;
  readonly expiresAt: number;
}

interface GuardState {
  installed: boolean;
  mode: LocalEgressMode;
  readonly authorizedResolvedIps: Map<string, AuthorizedDnsEntry>;
  readonly capturedUserProxyEnv: Readonly<Record<string, string>>;
}

const GLOBAL_GUARD_KEY = Symbol.for("@t3tools/shared/localEgressGuard/state");

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

function getGuardState(): GuardState {
  const globalObj = globalThis as Record<symbol, GuardState | undefined>;
  if (!globalObj[GLOBAL_GUARD_KEY]) {
    const captured: Record<string, string> = {};
    for (const key of PROXY_ENV_KEYS) {
      const value = process.env[key];
      if (typeof value === "string" && value.length > 0) {
        captured[key] = value;
      }
    }
    globalObj[GLOBAL_GUARD_KEY] = {
      installed: false,
      mode: "desktop",
      authorizedResolvedIps: new Map(),
      capturedUserProxyEnv: captured,
    };
  }
  return globalObj[GLOBAL_GUARD_KEY]!;
}

/** Returns original user proxy env vars if ACP agent subprocesses need them. */
export function getCapturedUserProxyEnv(): Readonly<Record<string, string>> {
  return getGuardState().capturedUserProxyEnv;
}

function recordAuthorizedIp(ip: string, hostname: string): void {
  const normalizedIp = stripBracketsAndZone(ip);
  if (!normalizedIp) return;
  const state = getGuardState();
  const now = performance.now();
  if (state.authorizedResolvedIps.size > 512) {
    for (const [key, entry] of state.authorizedResolvedIps) {
      if (entry.expiresAt <= now) state.authorizedResolvedIps.delete(key);
    }
  }
  state.authorizedResolvedIps.set(normalizedIp, {
    hostname,
    expiresAt: now + DNS_LEASE_TTL_MS,
  });
  const auditFile = process.env.T3CODE_EGRESS_AUDIT_LOG;
  if (auditFile) {
    try {
      NodeFS.appendFileSync(
        auditFile,
        `${JSON.stringify({ event: "dns_authorized", hostname, ip: normalizedIp })}\n`,
      );
    } catch {}
  }
}

function isAuthorizedResolvedIp(rawIp: string, mode: LocalEgressMode): boolean {
  const normalizedIp = stripBracketsAndZone(rawIp);
  const entry = getGuardState().authorizedResolvedIps.get(normalizedIp);
  if (!entry) return false;
  if (entry.expiresAt <= performance.now()) {
    getGuardState().authorizedResolvedIps.delete(normalizedIp);
    return false;
  }
  return isAllowedOfficialVendorHost(entry.hostname, mode);
}

function makeDnsNotFoundError(hostname: string): NodeJS.ErrnoException {
  const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as NodeJS.ErrnoException;
  err.code = "ENOTFOUND";
  err.errno = -3008;
  err.syscall = "getaddrinfo";
  return err;
}

const BLOCKED_SUBPROCESS_BINARIES = new Set(["cloudflared", "tailscale"]);

function checkSubprocessCommandAllowed(
  file: string,
  args: ReadonlyArray<string>,
): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
  const base = NodePath.basename(file)
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (BLOCKED_SUBPROCESS_BINARIES.has(base)) {
    return { allowed: false, reason: `blocked-binary:${base}` };
  }
  const joined = [file, ...args].join(" ").toLowerCase();
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (joined.includes(suffix)) {
      return { allowed: false, reason: `blocked-domain-arg:${suffix}` };
    }
  }
  if (joined.includes("pingdotgg/t3code")) {
    return { allowed: false, reason: "blocked-repo:pingdotgg/t3code" };
  }
  return { allowed: true };
}

export function guardLocalEgressFetch(
  originalFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const state = getGuardState();
  type FetchInput = Parameters<typeof globalThis.fetch>[0];
  return async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    // Node's proxy dispatcher is not retained by new Request(input, init).
    const dispatcher = (init as (RequestInit & { readonly dispatcher?: unknown }) | undefined)
      ?.dispatcher;
    const baseRequest = new Request(input, init);
    const callerRedirect = init?.redirect ?? baseRequest.redirect ?? "follow";
    let currentUrl = assertAllowedOutboundUrl(baseRequest.url, state.mode, baseRequest.method);
    let currentMethod = baseRequest.method;
    let currentBody: ArrayBuffer | null =
      currentMethod !== "GET" && currentMethod !== "HEAD" ? await baseRequest.arrayBuffer() : null;
    const currentHeaders = new Headers(baseRequest.headers);

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      assertAllowedOutboundUrl(currentUrl, state.mode, currentMethod);
      const signal = init?.signal ?? baseRequest.signal;
      const hopResponse = await originalFetch(currentUrl, {
        ...(dispatcher === undefined ? {} : { dispatcher }),
        method: currentMethod,
        headers: currentHeaders,
        ...(currentBody !== null ? { body: currentBody } : {}),
        redirect: "manual",
        ...(signal ? { signal } : {}),
      });

      const isRedirect =
        hopResponse.status === 301 ||
        hopResponse.status === 302 ||
        hopResponse.status === 303 ||
        hopResponse.status === 307 ||
        hopResponse.status === 308;

      if (!isRedirect) {
        return hopResponse;
      }

      const location = hopResponse.headers.get("location");
      if (!location) {
        return hopResponse;
      }

      const nextUrl = new URL(location, currentUrl);
      // Validate redirect target immediately even if callerRedirect === "manual" so blocked redirects cannot leak!
      assertAllowedOutboundUrl(nextUrl, state.mode, currentMethod);

      if (callerRedirect === "manual") {
        return hopResponse;
      }
      if (callerRedirect === "error") {
        throw new TypeError(`Redirect not allowed for ${currentUrl.href}`);
      }
      if (hop === MAX_REDIRECT_HOPS) {
        throw new TypeError(`Too many redirects while fetching ${baseRequest.url}`);
      }

      if (
        hopResponse.status === 303 ||
        ((hopResponse.status === 301 || hopResponse.status === 302) && currentMethod === "POST")
      ) {
        currentMethod = "GET";
        currentBody = null;
        currentHeaders.delete("content-length");
        currentHeaders.delete("content-type");
      }
      if (nextUrl.origin !== currentUrl.origin) {
        currentHeaders.delete("authorization");
        currentHeaders.delete("cookie");
      }
      currentUrl = nextUrl;
    }

    throw new TypeError(`Unexpected redirect loop for ${baseRequest.url}`);
  };
}

export function installLocalEgressGuard(mode: LocalEgressMode): void {
  const state = getGuardState();
  // Server mode is slightly more permissive than desktop mode (allows official quota/vendor APIs);
  // never downgrade desktop -> server accidentally, only set on first install or explicit server entry.
  if (state.installed) {
    if (mode === "server" && state.mode === "desktop") {
      state.mode = "server";
    }
    return;
  }
  state.installed = true;
  state.mode = mode;

  // Strip proxy environment variables from T3's own process so Node/undici cannot tunnel blocked URLs via HTTP_PROXY.
  for (const key of PROXY_ENV_KEYS) {
    delete process.env[key];
  }
  delete process.env.NODE_USE_ENV_PROXY;
  delete process.env.T3CODE_TELEMETRY_ENABLED;
  delete process.env.T3CODE_POSTHOG_HOST;
  delete process.env.T3CODE_POSTHOG_KEY;
  delete process.env.T3CODE_RELAY_URL;
  delete process.env.T3CODE_OTLP_TRACES_URL;
  delete process.env.T3CODE_OTLP_METRICS_URL;
  delete process.env.T3CODE_OTLP_LOGS_URL;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;

  // 1. Patch node:dns (synthetic localhost + official vendor allowlist only)
  const originalLookup = NodeDns.lookup.bind(NodeDns);
  const guardedLookup = ((
    hostname: string,
    optionsOrCallback: unknown,
    maybeCallback?: unknown,
  ) => {
    const callback = (
      typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback
    ) as (
      err: NodeJS.ErrnoException | null,
      address?: string | NodeDns.LookupAddress[],
      family?: number,
    ) => void;
    const options: NodeDns.LookupOptions =
      typeof optionsOrCallback === "object" && optionsOrCallback !== null
        ? (optionsOrCallback as NodeDns.LookupOptions)
        : typeof optionsOrCallback === "number"
          ? { family: optionsOrCallback }
          : {};

    const normalized = stripBracketsAndZone(String(hostname ?? ""));
    if (!normalized || isLoopbackHostname(normalized)) {
      const wantV6 = options.family === 6 || normalized === "::1";
      const addr = wantV6 ? "::1" : "127.0.0.1";
      const fam = wantV6 ? 6 : 4;
      queueMicrotask(() => {
        if (options.all) {
          callback(null, [{ address: addr, family: fam }]);
        } else {
          callback(null, addr, fam);
        }
      });
      return;
    }

    if (!isAllowedOfficialVendorHost(normalized, state.mode)) {
      queueMicrotask(() => {
        callback(makeDnsNotFoundError(normalized));
      });
      return;
    }

    return originalLookup(normalized, options, (err, address, family) => {
      if (!err && address) {
        if (Array.isArray(address)) {
          for (const item of address) {
            recordAuthorizedIp(item.address, normalized);
          }
        } else if (typeof address === "string") {
          recordAuthorizedIp(address, normalized);
        }
      }
      callback(err, address, family);
    });
  }) as typeof NodeDns.lookup;

  const cjsDns = cjsRequire("node:dns") as typeof NodeDns;
  const cjsTls = cjsRequire("node:tls") as typeof NodeTls;
  const cjsHttp = cjsRequire("node:http") as typeof NodeHttp;
  const cjsHttps = cjsRequire("node:https") as typeof NodeHttps;
  const cjsHttp2 = cjsRequire("node:http2") as typeof NodeHttp2;
  const cjsChildProcess = cjsRequire("node:child_process") as typeof NodeChildProcess;

  try {
    cjsDns.lookup = guardedLookup;
    if (cjsDns.promises) {
      (cjsDns.promises as { lookup: unknown }).lookup = async (
        hostname: string,
        options?: NodeDns.LookupOptions | number,
      ): Promise<NodeDns.LookupAddress | NodeDns.LookupAddress[]> =>
        new Promise((resolve, reject) => {
          const opts: NodeDns.LookupOptions =
            typeof options === "number" ? { family: options } : (options ?? {});
          guardedLookup(hostname, opts, (err, address, family) => {
            if (err) reject(err);
            else if (opts.all) resolve(address as NodeDns.LookupAddress[]);
            else resolve({ address: address as string, family: family ?? 4 });
          });
        });
    }
  } catch {}

  const blockResolverMethod =
    (methodName: string) =>
    (hostname: string, ...rest: unknown[]) => {
      const cb = rest.at(-1);
      const normalized = stripBracketsAndZone(String(hostname ?? ""));
      if (typeof cb === "function") {
        queueMicrotask(() => {
          (cb as (err: Error) => void)(
            new LocalEgressBlockedError(normalized, `dns-${methodName}-blocked`, "ENOTFOUND"),
          );
        });
      }
    };

  for (const method of [
    "resolve",
    "resolve4",
    "resolve6",
    "resolveAny",
    "resolveCname",
    "resolveMx",
    "resolveNaptr",
    "resolveNs",
    "resolvePtr",
    "resolveSoa",
    "resolveSrv",
    "resolveTxt",
  ] as const) {
    try {
      (NodeDns.Resolver.prototype as unknown as Record<string, unknown>)[method] =
        blockResolverMethod(method);
    } catch {}
  }

  // 2. Patch node:net Socket.prototype.connect & Server.prototype.listen
  const originalSocketConnect = NodeNet.Socket.prototype.connect;
  NodeNet.Socket.prototype.connect = function (
    this: NodeNet.Socket,
    ...args: unknown[]
  ): NodeNet.Socket {
    const first = args[0];

    // Unix domain socket: connect("/path/to.sock", cb) or connect({ path: "/path/to.sock" }, cb)
    if (typeof first === "string" && Number.isNaN(Number(first))) {
      if (!isSafeUnixSocketPath(first)) {
        const err = new LocalEgressBlockedError(first, "unsafe-ipc-path");
        queueMicrotask(() => this.destroy(err));
        return this;
      }
      return originalSocketConnect.apply(this, args as Parameters<typeof originalSocketConnect>);
    }

    if (Array.isArray(first) && typeof first[0] === "object" && first[0] !== null) {
      // Node internal normalized [options, cb] signature!
      const opts = first[0] as NodeNet.SocketConnectOpts;
      const cb = first[1] as (() => void) | undefined;
      return (
        NodeNet.Socket.prototype.connect as unknown as (
          this: NodeNet.Socket,
          options: NodeNet.SocketConnectOpts,
          connectionListener?: () => void,
        ) => NodeNet.Socket
      ).call(this, opts, cb);
    }

    if (typeof first === "object" && first !== null) {
      const opts = first as NodeNet.TcpSocketConnectOpts & NodeNet.IpcSocketConnectOpts;
      if ("path" in opts && opts.path !== undefined) {
        if (!isSafeUnixSocketPath(opts.path)) {
          const err = new LocalEgressBlockedError(String(opts.path), "unsafe-ipc-path");
          queueMicrotask(() => this.destroy(err));
          return this;
        }
        return originalSocketConnect.apply(this, args as Parameters<typeof originalSocketConnect>);
      }

      const rawHost = opts.host ?? "127.0.0.1";
      const normalizedHost = stripBracketsAndZone(rawHost);
      const port = Number(opts.port);

      if (isLoopbackHostname(normalizedHost)) {
        const patchedOpts: NodeNet.TcpSocketConnectOpts = {
          ...opts,
          host:
            normalizedHost === "localhost" || normalizedHost.endsWith(".localhost")
              ? "127.0.0.1"
              : (opts.host ?? "127.0.0.1"),
          lookup: guardedLookup,
        };
        const nextArgs = [patchedOpts, ...args.slice(1)];
        return originalSocketConnect.apply(
          this,
          nextArgs as Parameters<typeof originalSocketConnect>,
        );
      }

      const allowedExternal =
        port === 443 &&
        (isAllowedOfficialVendorHost(normalizedHost, state.mode) ||
          isAuthorizedResolvedIp(normalizedHost, state.mode));

      if (!allowedExternal) {
        const err = new LocalEgressBlockedError(
          `${normalizedHost}:${port}`,
          isBlockedT3OrTelemetryHost(normalizedHost)
            ? "blocked-t3-or-telemetry-socket"
            : "unauthorized-tcp-connect",
        );
        queueMicrotask(() => this.destroy(err));
        return this;
      }

      const patchedOpts: NodeNet.TcpSocketConnectOpts = {
        ...opts,
        lookup: guardedLookup,
      };
      const nextArgs = [patchedOpts, ...args.slice(1)];
      return originalSocketConnect.apply(
        this,
        nextArgs as Parameters<typeof originalSocketConnect>,
      );
    }

    // Positional connect(port, host?, cb?)
    if (typeof first === "number" || (typeof first === "string" && !Number.isNaN(Number(first)))) {
      const port = Number(first);
      const second = args[1];
      const host = typeof second === "string" ? second : "127.0.0.1";
      const cb =
        typeof second === "function"
          ? (second as () => void)
          : typeof args[2] === "function"
            ? (args[2] as () => void)
            : undefined;
      return (
        NodeNet.Socket.prototype.connect as unknown as (
          this: NodeNet.Socket,
          options: NodeNet.TcpSocketConnectOpts,
          connectionListener?: () => void,
        ) => NodeNet.Socket
      ).call(this, { port, host }, cb);
    }

    return originalSocketConnect.apply(this, args as Parameters<typeof originalSocketConnect>);
  };

  const originalServerListen = NodeNet.Server.prototype.listen;
  NodeNet.Server.prototype.listen = function (
    this: NodeNet.Server,
    ...args: unknown[]
  ): NodeNet.Server {
    const first = args[0];
    if (typeof first === "object" && first !== null && !("fd" in first)) {
      const opts = first as NodeNet.ListenOptions;
      if (!opts.path) {
        const rawHost = opts.host;
        if (rawHost === undefined || rawHost === "" || rawHost === "0.0.0.0" || rawHost === "::") {
          args[0] = { ...opts, host: "127.0.0.1" };
        } else if (!isLoopbackHostname(rawHost)) {
          const err = new LocalEgressBlockedError(
            `${rawHost}:${opts.port ?? 0}`,
            "non-loopback-listen-forbidden",
            "EADDRNOTAVAIL",
          );
          queueMicrotask(() => this.emit("error", err));
          return this;
        }
      }
    } else if (typeof first === "number") {
      const second = args[1];
      if (second === undefined || typeof second === "function") {
        const rest = second === undefined ? args.slice(2) : args.slice(1);
        return (originalServerListen as unknown as (...a: unknown[]) => NodeNet.Server).call(
          this,
          first,
          "127.0.0.1",
          ...rest,
        );
      }
      if (typeof second === "string") {
        if (second === "" || second === "0.0.0.0" || second === "::") {
          args[1] = "127.0.0.1";
        } else if (!isLoopbackHostname(second)) {
          const err = new LocalEgressBlockedError(
            `${second}:${first}`,
            "non-loopback-listen-forbidden",
            "EADDRNOTAVAIL",
          );
          queueMicrotask(() => this.emit("error", err));
          return this;
        }
      }
    }
    return originalServerListen.apply(this, args as Parameters<typeof originalServerListen>);
  };

  // 3. Patch node:tls connect (enforce SNI servername for external port 443)
  const originalTlsConnect = cjsTls.connect.bind(cjsTls);
  try {
    cjsTls.connect = ((...args: unknown[]) => {
      const first = args[0];
      if (typeof first === "object" && first !== null) {
        const opts = first as NodeTls.ConnectionOptions;
        if (!opts.path) {
          const candidateHost = stripBracketsAndZone(opts.servername || opts.host || "127.0.0.1");
          if (
            !isLoopbackHostname(candidateHost) &&
            !isAllowedOfficialVendorHost(candidateHost, state.mode)
          ) {
            const sock = new NodeTls.TLSSocket(new NodeNet.Socket());
            const err = new LocalEgressBlockedError(candidateHost, "unauthorized-tls-servername");
            queueMicrotask(() => sock.destroy(err));
            return sock;
          }
          args[0] = { ...opts, lookup: guardedLookup };
        }
      }
      return (originalTlsConnect as (...a: unknown[]) => NodeTls.TLSSocket)(...args);
    }) as typeof NodeTls.connect;
  } catch {}

  // 4. Patch node:dgram (block non-loopback UDP)
  const originalUdpSend = NodeDgram.Socket.prototype.send;
  NodeDgram.Socket.prototype.send = function (this: NodeDgram.Socket, ...args: unknown[]): void {
    // Signatures: send(msg, port?, address?, cb?) or send(msg, offset, length, port?, address?, cb?)
    let address: string | undefined;
    let cb: ((err: Error | null) => void) | undefined;
    for (let i = 1; i < args.length; i += 1) {
      if (typeof args[i] === "string") address = args[i] as string;
      if (typeof args[i] === "function") cb = args[i] as (err: Error | null) => void;
    }
    const targetHost = address ?? "127.0.0.1";
    if (!isLoopbackHostname(targetHost)) {
      const err = new LocalEgressBlockedError(targetHost, "udp-egress-blocked");
      if (cb) queueMicrotask(() => cb(err));
      else queueMicrotask(() => this.emit("error", err));
      return;
    }
    return originalUdpSend.apply(this, args as Parameters<typeof originalUdpSend>);
  };

  // 5. Patch node:http, node:https, and node:http2 request boundaries
  const wrapHttpRequest = <T extends typeof NodeHttp.request>(
    originalFn: T,
    defaultProtocol: "http:" | "https:",
  ): T =>
    ((...args: unknown[]) => {
      const first = args[0];
      const second = args[1];
      let targetUrl: URL | null = null;
      let method = "GET";
      let socketPath: string | undefined;

      if (typeof first === "string" || first instanceof URL) {
        targetUrl = typeof first === "string" ? new URL(first) : first;
        if (typeof second === "object" && second !== null) {
          const opts = second as NodeHttp.RequestOptions;
          if (opts.method) method = opts.method;
          if (opts.socketPath) socketPath = opts.socketPath;
        }
      } else if (typeof first === "object" && first !== null) {
        const opts = first as NodeHttp.RequestOptions;
        if (opts.method) method = opts.method;
        if (opts.socketPath) {
          socketPath = opts.socketPath;
        } else {
          const protocol = (opts.protocol ?? defaultProtocol) as string;
          const host = opts.hostname || opts.host || "127.0.0.1";
          const hostWithBrackets =
            NodeNet.isIPv6(host) && !host.startsWith("[") ? `[${host}]` : host;
          const portPart =
            opts.port && !hostWithBrackets.includes(`:${opts.port}`) ? `:${opts.port}` : "";
          const rawPath = opts.path || "/";
          if (/^https?:\/\//i.test(rawPath)) {
            targetUrl = new URL(rawPath);
          } else {
            targetUrl = new URL(
              `${protocol}//${hostWithBrackets}${portPart}${rawPath.startsWith("/") ? rawPath : `/${rawPath}`}`,
            );
          }
        }
      }

      if (method.toUpperCase() === "CONNECT") {
        throw new LocalEgressBlockedError(
          String(targetUrl ?? "CONNECT"),
          "http-connect-tunnel-blocked",
        );
      }

      if (socketPath !== undefined) {
        if (!isSafeUnixSocketPath(socketPath)) {
          throw new LocalEgressBlockedError(socketPath, "unsafe-ipc-socket-path");
        }
      } else if (targetUrl !== null) {
        assertAllowedOutboundUrl(targetUrl, state.mode, method);
      }

      return (originalFn as (...a: unknown[]) => NodeHttp.ClientRequest)(...args);
    }) as T;

  try {
    cjsHttp.request = wrapHttpRequest(cjsHttp.request.bind(cjsHttp), "http:");
    cjsHttp.get = ((...args: unknown[]) => {
      const req = (cjsHttp.request as (...a: unknown[]) => NodeHttp.ClientRequest)(...args);
      req.end();
      return req;
    }) as typeof NodeHttp.get;

    cjsHttps.request = wrapHttpRequest(cjsHttps.request.bind(cjsHttps), "https:");
    cjsHttps.get = ((...args: unknown[]) => {
      const req = (cjsHttps.request as (...a: unknown[]) => NodeHttp.ClientRequest)(...args);
      req.end();
      return req;
    }) as typeof NodeHttps.get;

    const originalHttp2Connect = cjsHttp2.connect.bind(cjsHttp2);
    cjsHttp2.connect = ((authority: string | URL, ...rest: unknown[]) => {
      assertAllowedOutboundUrl(authority, state.mode, "GET");
      return (
        originalHttp2Connect as (a: string | URL, ...r: unknown[]) => NodeHttp2.ClientHttp2Session
      )(authority, ...rest);
    }) as typeof NodeHttp2.connect;
  } catch {}

  // 6. Patch globalThis.fetch with strict per-hop URL + redirect validation
  if (typeof globalThis.fetch === "function") {
    globalThis.fetch = guardLocalEgressFetch(globalThis.fetch.bind(globalThis));
  }

  // 7. Patch globalThis.WebSocket (allow loopback ws/wss only)
  if (typeof globalThis.WebSocket === "function") {
    const OriginalWebSocket = globalThis.WebSocket;
    class GuardedWebSocket extends OriginalWebSocket {
      constructor(...args: ConstructorParameters<typeof OriginalWebSocket>) {
        const url = args[0];
        const parsed = typeof url === "string" ? new URL(url) : url;
        if (!isLoopbackHostname(parsed.hostname)) {
          throw new LocalEgressBlockedError(parsed.href, "external-websocket-blocked");
        }
        super(...args);
      }
    }
    (globalThis as { WebSocket: unknown }).WebSocket = GuardedWebSocket;
  }

  // 8. Patch node:child_process to block cloudflared, tailscale, and T3 telemetry/repo CLI commands
  // while leaving ACP coding agent subprocesses completely unrestricted in their own processes.
  const originalSpawn = cjsChildProcess.spawn.bind(cjsChildProcess);
  const originalSpawnSync = cjsChildProcess.spawnSync.bind(cjsChildProcess);
  const originalExecFile = cjsChildProcess.execFile.bind(cjsChildProcess);
  const originalExecFileSync = cjsChildProcess.execFileSync.bind(cjsChildProcess);

  const withRestoredChildEnv = <T>(opts: T): T => {
    if (Object.keys(state.capturedUserProxyEnv).length === 0) return opts;
    if (opts === undefined || opts === null) {
      return { env: { ...process.env, ...state.capturedUserProxyEnv } } as unknown as T;
    }
    if (typeof opts === "object" && !Array.isArray(opts)) {
      const record = opts as { env?: NodeJS.ProcessEnv };
      if (record.env === undefined) {
        return { ...record, env: { ...process.env, ...state.capturedUserProxyEnv } } as T;
      }
    }
    return opts;
  };

  try {
    cjsChildProcess.spawn = ((command: string, argsOrOpts?: unknown, maybeOpts?: unknown) => {
      const hasArgs = Array.isArray(argsOrOpts);
      const args = hasArgs ? (argsOrOpts as string[]) : [];
      const check = checkSubprocessCommandAllowed(command, args);
      if (!check.allowed) {
        throw new LocalEgressBlockedError(`${command} ${args.join(" ")}`.trim(), check.reason);
      }
      if (hasArgs) {
        return (originalSpawn as (...a: unknown[]) => NodeChildProcess.ChildProcess)(
          command,
          argsOrOpts,
          withRestoredChildEnv(maybeOpts),
        );
      }
      return (originalSpawn as (...a: unknown[]) => NodeChildProcess.ChildProcess)(
        command,
        withRestoredChildEnv(argsOrOpts),
      );
    }) as typeof NodeChildProcess.spawn;

    cjsChildProcess.spawnSync = ((command: string, argsOrOpts?: unknown, maybeOpts?: unknown) => {
      const hasArgs = Array.isArray(argsOrOpts);
      const args = hasArgs ? (argsOrOpts as string[]) : [];
      const check = checkSubprocessCommandAllowed(command, args);
      if (!check.allowed) {
        throw new LocalEgressBlockedError(`${command} ${args.join(" ")}`.trim(), check.reason);
      }
      if (hasArgs) {
        return (
          originalSpawnSync as (...a: unknown[]) => NodeChildProcess.SpawnSyncReturns<Buffer>
        )(command, argsOrOpts, withRestoredChildEnv(maybeOpts));
      }
      return (originalSpawnSync as (...a: unknown[]) => NodeChildProcess.SpawnSyncReturns<Buffer>)(
        command,
        withRestoredChildEnv(argsOrOpts),
      );
    }) as typeof NodeChildProcess.spawnSync;

    cjsChildProcess.execFile = ((
      file: string,
      argsOrOptsOrCb?: unknown,
      optsOrCb?: unknown,
      maybeCb?: unknown,
    ) => {
      const args = Array.isArray(argsOrOptsOrCb) ? (argsOrOptsOrCb as string[]) : [];
      const check = checkSubprocessCommandAllowed(file, args);
      if (!check.allowed) {
        throw new LocalEgressBlockedError(`${file} ${args.join(" ")}`.trim(), check.reason);
      }
      return (originalExecFile as (...a: unknown[]) => NodeChildProcess.ChildProcess)(
        file,
        argsOrOptsOrCb,
        optsOrCb,
        maybeCb,
      );
    }) as typeof NodeChildProcess.execFile;

    cjsChildProcess.execFileSync = ((file: string, argsOrOpts?: unknown, maybeOpts?: unknown) => {
      const args = Array.isArray(argsOrOpts) ? (argsOrOpts as string[]) : [];
      const check = checkSubprocessCommandAllowed(file, args);
      if (!check.allowed) {
        throw new LocalEgressBlockedError(`${file} ${args.join(" ")}`.trim(), check.reason);
      }
      return (originalExecFileSync as (...a: unknown[]) => Buffer | string)(
        file,
        argsOrOpts,
        maybeOpts,
      );
    }) as typeof NodeChildProcess.execFileSync;
  } catch {}

  try {
    NodeModule.syncBuiltinESMExports();
  } catch {}
}
