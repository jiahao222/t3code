import { ensureLocalApi } from "../../localApi";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import { useGT, useMessages, T } from "gt-react";
import { ChevronRightIcon, GaugeIcon } from "lucide-react";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { groupPickerQuota, quotaRemaining } from "./ModelPickerUsage.logic";
import styles from "./modelPickerUsage.module.css";

export function ModelPickerUsage({
  environmentId,
  provider,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly provider: ServerProvider;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const refreshProvider = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const limits = provider.usageLimits;
  const groups = groupPickerQuota(limits?.windows ?? []);
  const refresh = async (force: boolean) => {
    if (environmentId === null || busy) return;
    if (provider.driver === "antigravity" && !force) return;
    if (!force && limits && Date.now() - Date.parse(limits.checkedAt) < 60_000) return;
    setBusy(true);
    setFailed(false);
    try {
      if (
        provider.driver === "antigravity" &&
        !(await ensureLocalApi().dialogs.confirm(gt("Refresh limits")))
      )
        return;
      await refreshProvider({
        environmentId,
        input: {
          instanceId: provider.instanceId,
          fresh: true,
          ...(provider.driver === "antigravity" ? { antigravityUsageConfirmed: true } : {}),
        },
      });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
      setNow(Date.now());
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) {
          setNow(Date.now());
          refresh(false);
        }
      }}
    >
      <PopoverTrigger render={<button className={styles.trigger} type="button" />} openOnHover>
        <GaugeIcon size={14} aria-hidden />
        <span>
          <T>View usage</T>
        </span>
        <ChevronRightIcon size={13} aria-hidden />
      </PopoverTrigger>
      <PopoverPopup
        side="right"
        align="end"
        width="md"
        padding="compact"
        data-model-picker-option-menu
      >
        <section className={styles.panel} aria-label={gt("Remaining subscription allowance")}>
          <div className={styles.heading}>
            <span>
              <T>Usage</T>
            </span>
            <button disabled={busy || environmentId === null} onClick={() => refresh(true)}>
              {busy ? gt("Refreshing…") : gt("Refresh")}
            </button>
          </div>
          <p className={styles.account}>
            {provider.displayName?.replace(/^AGY · /, "") || provider.instanceId}
          </p>
          {groups.map((group) => (
            <div key={group.label} className={styles.group}>
              <h3>
                {group.label === "Gemini"
                  ? gt("Gemini models")
                  : group.label === "Claude & GPT"
                    ? gt("Claude and GPT models")
                    : group.label}
              </h3>
              {group.windows.map((window) => {
                const remaining = quotaRemaining(window.usedPercent);
                const reset = formatResetsIn(window, now, messages);
                const label =
                  window.kind === "weekly"
                    ? gt("Weekly limit")
                    : window.windowDurationMins === 300
                      ? gt("5-hour limit")
                      : window.kind === "monthly"
                        ? gt("Monthly limit")
                        : window.label;
                return (
                  <div key={window.id} className={styles.row}>
                    <div>
                      <span>{label}</span>
                      {reset && <small>{reset}</small>}
                    </div>
                    <span className={styles.percent}>
                      {gt("{percent}% left", { percent: Math.round(remaining) })}
                    </span>
                    <svg
                      viewBox="0 0 20 20"
                      width="17"
                      height="17"
                      aria-hidden
                      className={styles.ring}
                      data-level={remaining <= 10 ? "low" : remaining <= 25 ? "medium" : "high"}
                    >
                      <circle
                        cx="10"
                        cy="10"
                        r="7.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        opacity="0.18"
                      />
                      <circle
                        cx="10"
                        cy="10"
                        r="7.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        pathLength="100"
                        strokeDasharray={`${remaining} 100`}
                        transform="rotate(-90 10 10)"
                      />
                    </svg>
                  </div>
                );
              })}
            </div>
          ))}
          {groups.length === 0 && (
            <p className={styles.note}>
              {busy ? gt("Loading allowance…") : gt("No allowance data reported for this account.")}
            </p>
          )}
          {(failed || limits?.unavailable) && (
            <p className={styles.note}>
              <T>Could not refresh. Any values shown are the last reported allowance.</T>
            </p>
          )}
          {limits && (
            <p className={styles.updated}>
              {gt("Updated {time}", { time: new Date(limits.checkedAt).toLocaleTimeString() })}
            </p>
          )}
        </section>
      </PopoverPopup>
    </Popover>
  );
}
