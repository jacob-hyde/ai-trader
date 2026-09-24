/**
 * The metrics report on a run (L.4): computed from its persisted trades, kept with the run as JSON and
 * as markdown.
 *
 * A trade counts when its entry filled and the cost gate passed it. Per signal, a rejected signal is
 * still simulated and recorded for the gate's own diagnostic (L.2, H3), but it is not a trade the
 * strategy would have made, so it is left out here.
 */

import type { Fixed } from "@trader/contracts";
import { fromNumber } from "@trader/core";
import { type RunConfig, parseRunConfig } from "./config.js";
import { type MetricTrade, type Metrics, R_BUCKET_EDGES, computeMetrics } from "./metrics.js";
import type { TradeRecord } from "./records.js";
import type { RunRow } from "./store.js";

export const METRICS_REPORT = "metrics";

export interface VariantMetrics {
  readonly variant: string;
  readonly direction: string;
  readonly metrics: Metrics;
}

export interface MetricsReport {
  readonly runId: string;
  readonly name: string;
  readonly account: RunConfig["account"]["kind"];
  readonly variants: readonly VariantMetrics[];
}

/** The trades a run made: entry filled, gate passed. */
export function countedTrades(trades: readonly TradeRecord[]): MetricTrade[] {
  return trades.flatMap((t) =>
    t.gatePassed &&
    t.entryOutcome === "filled" &&
    t.netR !== null &&
    t.netPnl !== null &&
    t.entryMinute !== null &&
    t.exitMinute !== null
      ? [
          {
            session: t.session,
            symbol: t.symbol,
            entryMinute: t.entryMinute,
            exitMinute: t.exitMinute,
            netR: t.netR,
            netPnl: t.netPnl,
          },
        ]
      : [],
  );
}

/** Throws on a blind run, which keeps no trades to measure. */
export function metricsReport(
  run: RunRow,
  trades: readonly TradeRecord[],
  sessions: readonly string[],
): MetricsReport {
  if (run.blind) {
    throw new Error(`run ${run.id} is blind: it kept no trades to measure`);
  }
  const config = parseRunConfig(run.config);
  const cash: Fixed | null =
    config.account.kind === "asDeployed" ? fromNumber(config.account.startingCash) : null;
  const groups = new Map<string, TradeRecord[]>();
  for (const trade of trades) {
    const key = `${trade.variant}|${trade.direction}`;
    (groups.get(key) ?? groups.set(key, []).get(key))?.push(trade);
  }
  return {
    runId: run.id,
    name: run.name,
    account: config.account.kind,
    variants: [...groups]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, group]) => {
        const [variant = "", direction = ""] = key.split("|");
        return { variant, direction, metrics: computeMetrics(countedTrades(group), sessions, cash) };
      }),
  };
}

const r = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(4)}R`;
const dollars = (value: number) => `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const plain = (value: number | null, digits = 2) => (value === null ? "n/a" : value.toFixed(digits));

function renderVariant({ variant, direction, metrics: m }: VariantMetrics): string[] {
  const lines = [`## ${variant} ${direction}`, ""];
  if (m.trades === 0) {
    return [...lines, `No trades over ${String(m.sessions)} sessions.`, ""];
  }
  const e = m.expectancyR;
  const d = m.expectancyDollars;
  const drawdown = [
    r(m.equity.maxDrawdownR),
    ...(m.equity.dailyDollars === null
      ? []
      : [dollars(m.equity.maxDrawdownDollars), pct(m.equity.maxDrawdownPct)]),
  ].join(", ");
  lines.push(
    "| | |",
    "|---|---|",
    `| Trades | ${m.trades.toLocaleString("en-US")} over ${m.sessions.toLocaleString("en-US")} sessions |`,
    `| Win rate | ${pct(m.winRate)} |`,
    `| Expectancy | ${e === null ? "n/a" : `${r(e.mean)} [${r(e.lower)}, ${r(e.upper)}]`} |`,
    `| Expectancy, dollars | ${d === null ? "n/a" : `${dollars(d.mean)} [${dollars(d.lower)}, ${dollars(d.upper)}]`} |`,
    `| Profit factor | ${plain(m.profitFactor)} |`,
    `| Total | ${r(m.totalR)}, ${dollars(m.totalDollars)} |`,
    `| Max drawdown | ${drawdown} |`,
    `| Daily Sharpe, Sortino | ${plain(m.sharpe)}, ${plain(m.sortino)} |`,
    `| Holding | ${plain(m.exposure.meanHoldMinutes, 0)} minutes on average, at most ${String(m.exposure.peakConcurrent)} at once, ${plain(m.exposure.positionMinutesPerSession, 0)} position-minutes a session |`,
    "",
    "Expectancy intervals are day-clustered 95%. Dollars are at the run's size.",
    "",
  );
  if (m.distribution !== null) {
    const dist = m.distribution;
    lines.push(
      `R distribution: min ${r(dist.min)}, p5 ${r(dist.p5)}, p25 ${r(dist.p25)}, median ${r(dist.median)}, p75 ${r(dist.p75)}, p95 ${r(dist.p95)}, max ${r(dist.max)}.`,
      "",
      "| Net R | Trades |",
      "|---|---|",
      ...dist.buckets.map(
        (b) =>
          `| ${b.above === null ? `up to ${String(b.upTo)}` : b.upTo === null ? `above ${String(b.above)}` : `${String(b.above)} to ${String(b.upTo)}`} | ${b.count.toLocaleString("en-US")} |`,
      ),
      "",
    );
  }
  lines.push(
    "| Year | Trades | Win rate | Mean net R | Total net R |",
    "|---|---|---|---|---|",
    ...m.byYear.map(
      (y) =>
        `| ${String(y.year)} | ${y.trades.toLocaleString("en-US")} | ${pct(y.winRate)} | ${r(y.meanR)} | ${r(y.totalR)} |`,
    ),
    "",
  );
  return lines;
}

export function renderMetricsReport(report: MetricsReport): string {
  return [
    `# Metrics: ${report.name}`,
    "",
    `Run ${report.runId}, ${report.account === "perSignal" ? "per signal" : "as deployed"}. Counts filled trades the cost gate passed. R buckets are upper-inclusive at ${R_BUCKET_EDGES.join(", ")}.`,
    "",
    ...report.variants.flatMap(renderVariant),
  ].join("\n");
}
