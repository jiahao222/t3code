import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageSummary,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "./server";
import { useUsage } from "./usage";

vi.mock("react", () => ({
  useState: <A>(initial: A | (() => A)) => [
    typeof initial === "function" ? (initial as () => A)() : initial,
    vi.fn(),
  ],
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: AtomRegistry.make() }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: <A>(atom: Atom.Atom<A>) => appAtomRegistry.get(atom),
}));
vi.mock("./presentation", () => ({
  environmentPresentations: {
    presentationsAtom: Atom.make(
      new Map([
        [
          EnvironmentId.make("local"),
          {
            connection: { phase: "connected" },
            entry: { target: { label: "Local" } },
          },
        ],
      ]),
    ),
  },
}));
vi.mock("./session", () => ({
  environmentSession: {
    sessionStateAtom: () =>
      Atom.make(
        AsyncResult.success({
          authenticated: true,
          scopes: ["diagnostics:read"],
        }),
      ),
  },
  readEnvironmentScope: () => true,
}));
vi.mock("./server", () => ({
  serverEnvironment: {
    usageModelFilterAtom: () => Atom.make(undefined),
    usageSummary: vi.fn(),
  },
}));
vi.mock("../i18n/messages", () => ({ m: (value: string) => value }));

it("requests details on initial page load even when the same window already has a summary", () => {
  const query = vi.mocked(serverEnvironment.usageSummary).mockReset();
  query.mockImplementation(({ input }) =>
    Atom.make(
      AsyncResult.success({
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: "2026-11-20T12:00:00Z",
        ...input,
        buckets: [],
        sources: [],
        pricing: { status: "unavailable", source: "test", fetchedAt: null, knownModels: 0 },
        scanDurationMs: 0,
        ...(input.includeRequests ? { requests: [], requestCount: 0 } : {}),
      } satisfies UsageSummary),
    ),
  );
  const window = {
    sinceDay: UsageDay.make("2026-11-01"),
    untilDay: UsageDay.make("2026-11-20"),
    timeZone: "Asia/Shanghai",
  };
  try {
    expect(useUsage(window).environments[0]?.summary?.requests).toBeUndefined();
    const detailed = useUsage({ ...window, includeRequests: true });
    expect(query).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: { ...window, includeRequests: true },
    });
    expect(detailed.environments[0]?.summary?.requests).toEqual([]);
    expect(detailed.environments[0]?.summary?.requestCount).toBe(0);
  } finally {
    appAtomRegistry.dispose();
  }
});
