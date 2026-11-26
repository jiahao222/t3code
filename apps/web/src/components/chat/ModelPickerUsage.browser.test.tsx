import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ confirm: vi.fn(), refresh: vi.fn() }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { refreshProviders: "refresh" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.refresh }));
vi.mock("gt-react", () => ({
  useGT: () => (key: string) => key,
  useMessages: () => ({}),
  T: ({ children }: { children: React.ReactNode }) => children,
}));
import { ModelPickerUsage } from "./ModelPickerUsage";

it("opens AGY usage without querying and refreshes immediately on one click", async () => {
  state.confirm.mockReset();
  state.refresh.mockReset().mockResolvedValue(undefined);
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("agy-test"),
    driver: ProviderDriverKind.make("antigravity"),
    enabled: true,
    installed: true,
    version: "1.5.16",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-26T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  await using screen = await render(
    <ModelPickerUsage environmentId={EnvironmentId.make("local")} provider={provider} />,
  );
  await screen.getByRole("button", { name: "View usage" }).click();
  await expect.element(screen.getByRole("button", { name: "Refresh", exact: true })).toBeVisible();
  expect(state.confirm).not.toHaveBeenCalled();
  expect(state.refresh).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Refresh", exact: true }).click();
  await vi.waitFor(() =>
    expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { instanceId: "agy-test", fresh: true, antigravityUsageConfirmed: true },
    }),
  );
  expect(state.confirm).not.toHaveBeenCalled();
});
