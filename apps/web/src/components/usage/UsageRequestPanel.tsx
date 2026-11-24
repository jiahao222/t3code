import type { UsageProviderKind, UsageRequest } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { Fragment, useState } from "react";
import type { EnvironmentUsageStatus } from "../../state/usage";
import styles from "./usageRequests.module.css";

const count = (value: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
const compact = (value: number) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
const inputTokens = (r: UsageRequest) =>
  r.totals.uncachedInputTokens + r.totals.cachedInputTokens + r.totals.cacheCreationTokens;

export function UsageRequestPanel({
  environments,
  hiddenProviders,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
}) {
  const gt = useGT();
  const [account, setAccount] = useState("");
  const [model, setModel] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<
    (UsageRequest & { environment: string; key: string }) | null
  >(null);
  const [tab, setTab] = useState<"overview" | "requests">("requests");
  const supported = environments.some((e) => e.summary?.requests !== undefined);
  const rows = environments
    .flatMap((env) =>
      (env.summary?.requests ?? [])
        .filter((r) => !hiddenProviders.has(r.provider))
        .map((r) => ({ ...r, environment: env.label, key: `${env.environmentId}:${r.id}` })),
    )
    .sort((a, b) => b.timestampMs - a.timestampMs || a.key.localeCompare(b.key));
  const accounts = [...new Set(rows.map((r) => r.account))].sort();
  const models = [...new Set(rows.map((r) => r.model))].sort();
  const query = search.trim().toLowerCase();
  const filtered = rows.filter(
    (r) =>
      (!account || r.account === account) &&
      (!model || r.model === model) &&
      (!query || `${r.account} ${r.model} ${r.sessionId} ${r.id}`.toLowerCase().includes(query)),
  );
  const totals = filtered.reduce(
    (s, r) => ({
      input: s.input + inputTokens(r),
      output: s.output + r.totals.outputTokens,
      cached: s.cached + r.totals.cachedInputTokens,
      writes: s.writes + r.totals.cacheCreationTokens,
    }),
    { input: 0, output: 0, cached: 0, writes: 0 },
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 25));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * 25, (currentPage + 1) * 25);
  const reported = environments.reduce((n, e) => n + (e.summary?.requestCount ?? 0), 0);
  const cacheRatio = totals.input ? totals.cached / totals.input : null;
  const averageCache = filtered.length ? totals.cached / filtered.length : null;
  const ranked = (key: "account" | "model") => {
    const groups = new Map<string, { name: string; tokens: number; requests: number }>();
    for (const row of filtered) {
      const item = groups.get(row[key]) ?? { name: row[key], tokens: 0, requests: 0 };
      item.tokens += inputTokens(row) + row.totals.outputTokens;
      item.requests += 1;
      groups.set(row[key], item);
    }
    return [...groups.values()].sort((a, b) => b.tokens - a.tokens);
  };
  const daily = new Map<string, { date: string; input: number; output: number; cached: number }>();
  for (const row of filtered) {
    const date = new Date(row.timestampMs).toLocaleDateString();
    const day = daily.get(date) ?? { date, input: 0, output: 0, cached: 0 };
    day.input += row.totals.uncachedInputTokens + row.totals.cacheCreationTokens;
    day.output += row.totals.outputTokens;
    day.cached += row.totals.cachedInputTokens;
    daily.set(date, day);
  }
  const days = [...daily.values()].reverse();
  const peak = Math.max(1, ...days.map((d) => d.input + d.output + d.cached));
  if (expanded !== null) {
    const r = expanded;
    return (
      <section className={styles["usage-requests"]}>
        <button className={styles["ur-back"]} onClick={() => setExpanded(null)}>
          {gt("Back to requests")}
        </button>
        <div className={styles["ur-detail-heading"]}>
          <h2>{r.model}</h2>
          <span className={styles["ur-badge"]}>
            <T>Recorded generation</T>
          </span>
        </div>
        <p className={styles["ur-subtitle"]}>
          {new Date(r.timestampMs).toLocaleString()} · {r.account.replace(/^AGY · /, "")}
        </p>
        <div className={styles["ur-detail-tokens"]}>
          <div>
            <span>
              <T>Input</T>
            </span>
            <strong>{count(inputTokens(r))}</strong>
          </div>
          <div>
            <span>
              <T>Cache read</T>
            </span>
            <strong>{count(r.totals.cachedInputTokens)}</strong>
          </div>
          <div>
            <span>
              <T>Cache write</T>
            </span>
            <strong>{count(r.totals.cacheCreationTokens)}</strong>
          </div>
          <div>
            <span>
              <T>Output</T>
            </span>
            <strong>{count(r.totals.outputTokens)}</strong>
          </div>
        </div>
        <div className={styles["ur-expanded"]}>
          <dl>
            <div>
              <dt>
                <T>Request ID</T>
              </dt>
              <dd>{r.id}</dd>
            </div>
            <div>
              <dt>
                <T>Session ID</T>
              </dt>
              <dd>{r.sessionId}</dd>
            </div>
            <div>
              <dt>
                <T>Environment</T>
              </dt>
              <dd>{r.environment}</dd>
            </div>
            <div>
              <dt>
                <T>Uncached input</T>
              </dt>
              <dd>{count(r.totals.uncachedInputTokens)}</dd>
            </div>
            <div>
              <dt>
                <T>Reasoning tokens</T>
              </dt>
              <dd>
                {count(r.totals.reasoningTokens)} · <T>Already included in output</T>
              </dd>
            </div>
            <div>
              <dt>
                <T>Duration / HTTP status</T>
              </dt>
              <dd>
                <T>Not recorded in this data source</T>
              </dd>
            </div>
          </dl>
          <p>
            <T>
              This record contains token metadata. Full prompts, responses and cached text are not
              included.
            </T>
          </p>
        </div>
      </section>
    );
  }
  return (
    <section className={styles["usage-requests"]} aria-label={gt("Request activity")}>
      <div className={styles["ur-heading"]}>
        <div className={styles["ur-tabs"]} role="group" aria-label={gt("Usage views")}>
          <button aria-pressed={tab === "overview"} onClick={() => setTab("overview")}>
            <T>Overview</T>
          </button>
          <button aria-pressed={tab === "requests"} onClick={() => setTab("requests")}>
            <T>Requests</T>
          </button>
        </div>
        <span className={styles["ur-badge"]}>
          <T>Local history</T>
        </span>
      </div>
      <div className={styles["ur-metrics"]}>
        <div className={styles["ur-metric"]}>
          <span>
            <T>Recorded requests</T>
          </span>
          <strong>{count(filtered.length)}</strong>
          <small>
            <T>Matching loaded records</T>
          </small>
        </div>
        <div className={styles["ur-metric"]}>
          <span>
            <T>Input tokens</T>
          </span>
          <strong>{compact(totals.input)}</strong>
          <small>
            <T>Includes cache reads and writes</T>
          </small>
        </div>
        <div className={styles["ur-metric"]}>
          <span>
            <T>Output tokens</T>
          </span>
          <strong>{compact(totals.output)}</strong>
          <small>
            <T>Includes reasoning tokens</T>
          </small>
        </div>
        <div className={[styles["ur-metric"], styles["ur-cache"]].join(" ")}>
          <span>
            <T>Cache hit rate</T>
          </span>
          <strong>
            {cacheRatio === null ? gt("Not available") : `${(cacheRatio * 100).toFixed(1)}%`}
          </strong>
          <small>
            {compact(totals.cached)} <T>tokens read from cache</T>
          </small>
          <div className={styles["ur-track"]}>
            <div style={{ width: `${(cacheRatio ?? 0) * 100}%` }} />
          </div>
        </div>
        <div className={[styles["ur-metric"], styles["ur-cache"]].join(" ")}>
          <span>
            <T>Average cache per request</T>
          </span>
          <strong>{averageCache === null ? gt("Not available") : count(averageCache)}</strong>
          <small>
            <T>Cache-read tokens / matching requests</T>
          </small>
        </div>
      </div>
      <p className={styles["ur-metric-note"]}>
        <T>Statistics cover matching loaded records, up to 500 per environment.</T>
      </p>
      <div className={styles["ur-toolbar"]}>
        <label>
          <span>
            <T>Account</T>
          </span>
          <select
            value={account}
            onChange={(e) => {
              setAccount(e.target.value);
              setPage(0);
            }}
          >
            <option value="">{gt("All accounts")}</option>
            {accounts.map((a) => (
              <option key={a} value={a}>
                {a.replace(/^AGY · /, "")}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>
            <T>Model</T>
          </span>
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setPage(0);
            }}
          >
            <option value="">{gt("All models")}</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className={styles["ur-search"]}>
          <span>
            <T>Search</T>
          </span>
          <input
            value={search}
            placeholder={gt("Account, model or session ID…")}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </label>
      </div>
      {tab === "overview" ? (
        <>
          <section className={styles["ur-trend"]}>
            <div className={styles["ur-list-heading"]}>
              <h3>
                <T>Token trend</T>
              </h3>
              <span>
                <T>Matching loaded records</T>
              </span>
            </div>
            <div
              className={styles["ur-chart"]}
              role="group"
              aria-label={gt("Daily input, output and cached tokens")}
            >
              {days.map((d) => (
                <div
                  className={styles["ur-day"]}
                  key={d.date}
                  role="img"
                  aria-label={`${d.date}: ${count(d.input + d.output + d.cached)}`}
                >
                  <div className={styles["ur-bar"]}>
                    <i
                      className={styles["ur-output-segment"]}
                      style={{ height: `${(d.output / peak) * 100}%` }}
                    />
                    <i
                      className={styles["ur-input-segment"]}
                      style={{ height: `${(d.input / peak) * 100}%` }}
                    />
                    <i
                      className={styles["ur-cache-segment"]}
                      style={{ height: `${(d.cached / peak) * 100}%` }}
                    />
                  </div>
                  <small>{d.date}</small>
                </div>
              ))}
            </div>
            <div className={styles["ur-legend"]}>
              <span>
                <i className={styles["ur-input-segment"]} />
                <T>Uncached input and cache write</T>
              </span>
              <span>
                <i className={styles["ur-cache-segment"]} />
                <T>Cache read</T>
              </span>
              <span>
                <i className={styles["ur-output-segment"]} />
                <T>Output</T>
              </span>
            </div>
          </section>
          <div className={styles["ur-ranks"]}>
            {(["account", "model"] as const).map((kind) => {
              const ranking = ranked(kind);
              const total = ranking.reduce((n, x) => n + x.tokens, 0);
              return (
                <section key={kind}>
                  <h3>{kind === "account" ? gt("Accounts") : gt("Models")}</h3>
                  {ranking.slice(0, 12).map((item) => (
                    <button
                      key={item.name}
                      onClick={() => {
                        if (kind === "account") setAccount(item.name);
                        else setModel(item.name);
                        setPage(0);
                        setTab("requests");
                      }}
                    >
                      <div>
                        <span>{item.name.replace(/^AGY · /, "")}</span>
                        <b>{compact(item.tokens)}</b>
                      </div>
                      <div className={styles["ur-track"]}>
                        <i style={{ width: `${total ? (item.tokens / total) * 100 : 0}%` }} />
                      </div>
                      <small>
                        {item.requests} <T>records</T>
                      </small>
                    </button>
                  ))}
                </section>
              );
            })}
          </div>
          {filtered.length === 0 && (
            <p className={styles["ur-empty"]}>
              <T>No matching requests</T>
            </p>
          )}
        </>
      ) : (
        <>
          <div className={styles["ur-list-heading"]}>
            <h3>
              <T>Request ledger</T>
            </h3>
            <span>
              {count(filtered.length)} <T>records</T>
            </span>
          </div>
          <div className={styles["ur-table-wrap"]}>
            <table>
              <thead>
                <tr>
                  <th>
                    <T>Time / account</T>
                  </th>
                  <th>
                    <T>Model</T>
                  </th>
                  <th className={styles["ur-number"]}>
                    <T>Input</T>
                  </th>
                  <th className={styles["ur-number"]}>
                    <T>Cache read</T>
                  </th>
                  <th className={styles["ur-number"]}>
                    <T>Cache write</T>
                  </th>
                  <th className={styles["ur-number"]}>
                    <T>Output</T>
                  </th>
                  <th>
                    <T>Details</T>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <Fragment key={r.key}>
                    <tr>
                      <td>
                        <time dateTime={new Date(r.timestampMs).toISOString()}>
                          {new Date(r.timestampMs).toLocaleString()}
                        </time>
                        <small className={styles["ur-account"]}>
                          {r.account.replace(/^AGY · /, "")}
                        </small>
                      </td>
                      <td>
                        <span className={styles["ur-model"]}>{r.model}</span>
                      </td>
                      <td className={styles["ur-number"]}>{count(inputTokens(r))}</td>
                      <td className={[styles["ur-number"], styles["ur-cached"]].join(" ")}>
                        {count(r.totals.cachedInputTokens)}
                      </td>
                      <td className={styles["ur-number"]}>{count(r.totals.cacheCreationTokens)}</td>
                      <td className={styles["ur-number"]}>{count(r.totals.outputTokens)}</td>
                      <td>
                        <button
                          className={styles["ur-detail-button"]}
                          aria-label={gt("View request details")}
                          onClick={() => setExpanded(r)}
                        >
                          {gt("View")}
                        </button>
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
            {visible.length === 0 && (
              <div className={styles["ur-empty"]}>
                <strong>
                  {supported ? gt("No matching requests") : gt("Request details unavailable")}
                </strong>
                <p>
                  {supported
                    ? gt("Try a different time range, account or search.")
                    : gt("This environment needs a server with request-history support.")}
                </p>
              </div>
            )}
          </div>
          <footer className={styles["ur-footer"]}>
            <span>
              {reported > rows.length
                ? gt(
                    "Showing the latest 500 records per environment. Narrow the time range to inspect older records.",
                  )
                : gt("Recorded generations only; this is not an HTTP traffic log.")}
            </span>
            <div>
              <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
                {gt("Previous")}
              </button>
              <span>
                {currentPage + 1} / {pages}
              </span>
              <button disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>
                {gt("Next")}
              </button>
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
