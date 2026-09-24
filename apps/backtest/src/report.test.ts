import type { Fixed, Ratio } from "@trader/contracts";
import { describe, expect, it } from "vitest";
import type { TradeRecord } from "./records.js";
import { countedTrades, metricsReport, renderMetricsReport } from "./report.js";
import type { RunRow } from "./store.js";
import { testConfig } from "./testing.js";

const base: TradeRecord = {
  variant: "A",
  symbol: "AAA",
  session: "2026-02-02",
  direction: "long",
  rank: 1,
  openingRvol: 30_000 as Ratio,
  dailyAtr: 10_000 as Fixed,
  priorClose: 200_000 as Fixed,
  signalMinute: 4,
  entry: 202_000 as Fixed,
  stop: 199_500 as Fixed,
  target: null,
  costPerShare: 400 as Fixed,
  costToRisk: 1_600 as Ratio,
  gatePassed: true,
  refusal: null,
  shares: 1,
  entryOutcome: "filled",
  entryMinute: 6,
  entryReference: 202_000 as Fixed,
  entryFill: 202_300 as Fixed,
  exitMinute: 20,
  exitReason: "stop",
  exitReference: 199_500 as Fixed,
  exitFill: 199_200 as Fixed,
  grossPnl: -2_500 as Fixed,
  netPnl: -3_100 as Fixed,
  grossR: -10_000 as Ratio,
  netR: -12_400 as Ratio,
};

const run = (overrides: Partial<RunRow> = {}): RunRow => ({
  id: "r1",
  name: "report test",
  status: "completed",
  blind: false,
  config: testConfig(),
  gitCommit: null,
  gitDirty: null,
  registrationVersion: null,
  registrationSha256: null,
  dataSnapshot: null,
  progress: null,
  summary: null,
  error: null,
  createdAt: new Date(0),
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

describe("the metrics report (L.4)", () => {
  const trades: TradeRecord[] = [
    base,
    { ...base, symbol: "BBB", netR: 20_000 as Ratio, netPnl: 5_000 as Fixed, exitMinute: 300 },
    // Rejected by the gate: simulated for H3, not a trade.
    { ...base, symbol: "CCC", gatePassed: false, netR: 30_000 as Ratio },
    // Never triggered.
    { ...base, symbol: "DDD", entryOutcome: "canceled", netR: null, netPnl: null, exitMinute: null },
    { ...base, variant: "B", symbol: "AAA", netR: 5_000 as Ratio },
    { ...base, variant: "A", direction: "short", symbol: "EEE", netR: -10_000 as Ratio },
  ];

  it("counts a trade only when its entry filled and the gate passed it", () => {
    expect(countedTrades(trades.slice(0, 4)).map((t) => t.symbol)).toEqual(["AAA", "BBB"]);
  });

  it("measures every variant and direction apart, over the run's sessions", () => {
    const report = metricsReport(run(), trades, ["2026-02-02", "2026-02-03"]);
    expect(report.account).toBe("perSignal");
    expect(report.variants.map((v) => [v.variant, v.direction, v.metrics.trades, v.metrics.totalR])).toEqual([
      ["A", "long", 2, 0.76],
      ["A", "short", 1, -1],
      ["B", "long", 1, 0.5],
    ]);
    expect(report.variants[0]?.metrics.sessions).toBe(2);
    expect(report.variants[0]?.metrics.equity.dailyDollars).toBeNull();
  });

  it("measures an as-deployed run in dollars on its starting cash", () => {
    const config = testConfig({
      variants: [{ id: "A", stop: { kind: "openingRange" }, exit: { kind: "eod" } }],
      account: {
        kind: "asDeployed",
        startingCash: 2_500,
        riskPerTrade: 0.015,
        maxPositionPct: 0.25,
        maxGrossExposure: 1,
        maxConcurrentPositions: 4,
        maxOpenRisk: 0.02,
        dailyLossLimit: 0.05,
        flattenOnBreaker: false,
        micro: null,
      },
    });
    const report = metricsReport(run({ config }), trades.slice(0, 2), ["2026-02-02"]);
    expect(report.account).toBe("asDeployed");
    expect(report.variants[0]?.metrics.equity.dailyDollars).toEqual([
      { session: "2026-02-02", equity: 2_500.19 },
    ]);
  });

  it("refuses a blind run, which kept nothing to measure", () => {
    expect(() => metricsReport(run({ blind: true }), [], [])).toThrow(/blind/);
  });

  it("renders a section per variant with its table, distribution, and years", () => {
    const text = renderMetricsReport(metricsReport(run(), trades, ["2026-02-02", "2026-02-03"]));
    expect(text).toContain("# Metrics: report test");
    expect(text).toContain("## A long");
    expect(text).toContain("| Trades | 2 over 2 sessions |");
    expect(text).toContain("| Win rate | 50.0% |");
    expect(text).toContain("| Total | +0.7600R, $0.19 |");
    expect(text).toContain("| 2026 | 2 | 50.0% | +0.3800R | +0.7600R |");
    expect(text).toContain("| -1.5 to -1 | 1 |");
    expect(text).toContain("## B long");
    expect(text).not.toMatch(/[–—]/);
    const empty = renderMetricsReport(metricsReport(run(), [{ ...base, gatePassed: false }], ["2026-02-02"]));
    expect(empty).toContain("No trades over 1 sessions.");
  });
});
