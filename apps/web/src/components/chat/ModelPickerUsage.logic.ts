import type { ServerProviderUsageWindow } from "@t3tools/contracts";

export function groupPickerQuota(windows: readonly ServerProviderUsageWindow[]) {
  const groups = new Map<string, ServerProviderUsageWindow[]>();
  for (const window of windows) {
    const label = window.label.split(" · ")[0] ?? window.label;
    const key = window.id.startsWith("3p-") ? "Claude & GPT" : label;
    const group = groups.get(key) ?? [];
    group.push(window);
    groups.set(key, group);
  }
  const rank = (kind: ServerProviderUsageWindow["kind"]) => kind === "weekly" ? 0 : kind === "session" ? 1 : 2;
  return [...groups].sort(([a], [b]) => (a === "Gemini" ? -1 : b === "Gemini" ? 1 : a.localeCompare(b)))
    .map(([label, windows]) => ({ label, windows: [...windows].sort((a, b) => rank(a.kind) - rank(b.kind)) }));
}

export function quotaRemaining(usedPercent: number) {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}
