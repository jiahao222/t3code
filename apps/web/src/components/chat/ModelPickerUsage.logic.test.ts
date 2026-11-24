import { describe, expect, it } from "vite-plus/test";
import { groupPickerQuota, quotaRemaining } from "./ModelPickerUsage.logic";

describe("picker quota", () => {
  it("keeps model-specific pools separate and places weekly limits before sessions", () => {
    const groups = groupPickerQuota([
      { id: "gemini-5h", kind: "session", label: "Gemini · 5-hour", usedPercent: 14 },
      { id: "3p-5h", kind: "session", label: "Claude & GPT (shared) · 5-hour", usedPercent: 0 },
      { id: "gemini-argon-wtu-weekly", kind: "weekly", label: "Gemini 4 Argon · Weekly", usedPercent: 2 },
      { id: "gemini-weekly", kind: "weekly", label: "Gemini · Weekly", usedPercent: 4 },
      { id: "3p-weekly", kind: "weekly", label: "Claude & GPT (shared) · Weekly", usedPercent: 0 },
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Gemini", "Claude & GPT", "Gemini 4 Argon"]);
    expect(groups[0]?.windows.map((w) => w.id)).toEqual(["gemini-weekly", "gemini-5h"]);
    expect(groups[2]?.windows).toHaveLength(1);
    expect(groupPickerQuota([])).toEqual([]);
  });
  it("shows remaining rather than consumed percentage including boundary values", () => {
    expect([0, 4, 14, 100, 103, -3].map(quotaRemaining)).toEqual([100, 96, 86, 0, 0, 100]);
  });
});
