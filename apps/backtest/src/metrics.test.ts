import type { Fixed, Ratio } from "@trader/contracts";
import { describe, expect, it } from "vitest";
import { type MetricTrade, clusteredMean, computeMetrics, percentile } from "./metrics.js";

/**
 * Ten trades over four of five sessions, across a year end. Net dollars are ten times net R, so every
 * dollar figure below is its R figure times ten. Every expected number here was worked out by hand
 * first; the arithmetic is written out where it is more than one step.
 */
const trade = (
  session: string,
  symbol: string,
  entryMinute: number,
  exitMinute: number,
  r: number,
): MetricTrade => ({
  session,
  symbol,
  entryMinute,
  exitMinute,
  netR: Math.round(r * 10_000) as Ratio,
  netPnl: Math.round(r * 10 * 10_000) as Fixed,
});

const TRADES: MetricTrade[] = [
  trade("2023-12-28", "AAA", 10, 20, -1),
  trade("2023-12-28", "BBB", 15, 380, 2),
  trade("2023-12-28", "CCC", 16, 16, -1.2),
  trade("2023-12-29", "AAA", 30, 100, 0.5),
  trade("2023-12-29", "DDD", 40, 60, -1),
  trade("2024-01-02", "AAA", 6, 7, -1),
  trade("2024-01-02", "BBB", 6, 200, 3),
  trade("2024-01-02", "CCC", 50, 380, 0),
  trade("2024-01-03", "AAA", 5, 9, -1.1),
  trade("2024-01-03", "EEE", 8, 380, 0.8),
];
const SESSIONS = ["2023-12-28", "2023-12-29", "2024-01-02", "2024-01-03", "2024-01-04"];
const ROOT_252 = Math.sqrt(252);

describe("results metrics against a hand calculation (L.4)", () => {
  // Shuffled, so nothing depends on the order trades arrive in.
  const perSignal = computeMetrics([...TRADES].reverse(), SESSIONS, null);

  it("counts trades, sessions, wins, and totals", () => {
    expect(perSignal.trades).toBe(10);
    expect(perSignal.sessions).toBe(5);
    // Winners: 2, 0.5, 3, 0.8. The scratch at 0 is not a win.
    expect(perSignal.winRate).toBe(0.4);
    // -1 + 2 - 1.2 + 0.5 - 1 - 1 + 3 + 0 - 1.1 + 0.8
    expect(perSignal.totalR).toBeCloseTo(1, 12);
    expect(perSignal.totalDollars).toBeCloseTo(10, 12);
    // Gross profit 6.3 over gross loss 5.3.
    expect(perSignal.profitFactor).toBeCloseTo(6.3 / 5.3, 12);
  });

  it("gives expectancy with a day-clustered interval", () => {
    // Mean 0.1. Day totals -0.2, -0.5, 2, -0.3 over 3, 2, 3, 2 trades; less count times mean:
    // -0.5, -0.7, 1.7, -0.5; squares sum to 3.88. Variance 3.88 / 10^2 * 4/3.
    const half = 1.96 * Math.sqrt((3.88 / 100) * (4 / 3));
    expect(perSignal.expectancyR?.mean).toBeCloseTo(0.1, 12);
    expect(perSignal.expectancyR?.lower).toBeCloseTo(0.1 - half, 12);
    expect(perSignal.expectancyR?.upper).toBeCloseTo(0.1 + half, 12);
    expect(half).toBeCloseTo(0.4458, 4);
    expect(perSignal.expectancyDollars?.mean).toBeCloseTo(1, 12);
    expect(perSignal.expectancyDollars?.upper).toBeCloseTo(1 + 10 * half, 10);
  });

  it("describes the R distribution by nearest-rank percentiles and buckets", () => {
    // Sorted: -1.2, -1.1, -1, -1, -1, 0, 0.5, 0.8, 2, 3.
    expect(perSignal.distribution).toMatchObject({
      min: -1.2,
      p5: -1.2,
      p25: -1,
      median: -1,
      p75: 0.8,
      p95: 3,
      max: 3,
    });
    expect(perSignal.distribution?.buckets.map((b) => [b.above, b.upTo, b.count])).toEqual([
      [null, -1.5, 0],
      [-1.5, -1, 5],
      [-1, -0.5, 0],
      [-0.5, 0, 1],
      [0, 0.5, 1],
      [0.5, 1, 1],
      [1, 2, 1],
      [2, 3, 1],
      [3, 5, 0],
      [5, null, 0],
    ]);
  });

  it("builds closed-trade equity in exit order and finds the deepest drawdown", () => {
    // Exit order: CCC 16, AAA 20, BBB 380 | DDD 60, AAA 100 | AAA 7, BBB 200, CCC 380 | AAA 9, EEE 380.
    // Equity: -1.2, -2.2, -0.2 | -1.2, -0.7 | -1.7, 1.3, 1.3 | 0.2, 1.0. Deepest: 0 down to -2.2.
    expect(perSignal.equity.dailyR.map((d) => [d.session, Number(d.r.toFixed(10))])).toEqual([
      ["2023-12-28", -0.2],
      ["2023-12-29", -0.7],
      ["2024-01-02", 1.3],
      ["2024-01-03", 1],
      ["2024-01-04", 1],
    ]);
    expect(perSignal.equity.maxDrawdownR).toBeCloseTo(2.2, 12);
    expect(perSignal.equity.dailyDollars).toBeNull();
    expect(perSignal.equity.maxDrawdownPct).toBeNull();
  });

  it("annualizes the daily Sharpe and Sortino on each session's total R, a quiet session as zero", () => {
    // Daily R: -0.2, -0.5, 2, -0.3, 0. Mean 0.2. Squared deviations sum 4.18, sample SD sqrt(4.18/4).
    // Downside: 0.04 + 0.25 + 0.09 = 0.38 over 5 sessions.
    expect(perSignal.sharpe).toBeCloseTo((0.2 / Math.sqrt(4.18 / 4)) * ROOT_252, 10);
    expect(perSignal.sortino).toBeCloseTo((0.2 / Math.sqrt(0.38 / 5)) * ROOT_252, 10);
    expect(perSignal.sharpe).toBeCloseTo(3.1058, 3);
  });

  it("measures exposure: holding time, the most positions at once, and position-minutes a session", () => {
    // Holds: 10, 365, 1 (in and out on one bar), 70, 20, 1, 194, 330, 4, 372: 1,367 minutes.
    expect(perSignal.exposure.meanHoldMinutes).toBeCloseTo(136.7, 12);
    expect(perSignal.exposure.positionMinutesPerSession).toBeCloseTo(1367 / 5, 12);
    // Minute 16 of 2023-12-28 holds AAA, BBB, and CCC.
    expect(perSignal.exposure.peakConcurrent).toBe(3);
  });

  it("breaks the trades down by calendar year", () => {
    expect(perSignal.byYear.map((y) => [y.year, y.trades, y.winRate])).toEqual([
      [2023, 5, 0.4],
      [2024, 5, 0.4],
    ]);
    // 2023: -1 + 2 - 1.2 + 0.5 - 1. 2024: -1 + 3 + 0 - 1.1 + 0.8.
    expect(perSignal.byYear[0]?.totalR).toBeCloseTo(-0.7, 12);
    expect(perSignal.byYear[0]?.meanR).toBeCloseTo(-0.14, 12);
    expect(perSignal.byYear[1]?.totalR).toBeCloseTo(1.7, 12);
    expect(perSignal.byYear[1]?.meanR).toBeCloseTo(0.34, 12);
  });
});

describe("as deployed, on $100", () => {
  const deployed = computeMetrics(TRADES, SESSIONS, 1_000_000 as Fixed);

  it("tracks dollar equity and the drawdown as a share of its peak", () => {
    // 100 + 10 times the R path: 88, 78, 98 | 88, 93 | 83, 113, 113 | 102, 110. Deepest: 100 to 78.
    expect(deployed.equity.dailyDollars?.map((d) => Number(d.equity.toFixed(8)))).toEqual([
      98, 93, 113, 110, 110,
    ]);
    expect(deployed.equity.maxDrawdownDollars).toBeCloseTo(22, 10);
    expect(deployed.equity.maxDrawdownPct).toBeCloseTo(0.22, 12);
    // In R the path is the same as per signal.
    expect(deployed.equity.maxDrawdownR).toBeCloseTo(2.2, 12);
  });

  it("takes the daily ratios on the account's returns", () => {
    // Opening equity 100, 98, 93, 113, 110; the day's P&L -2, -5, 20, -3, 0.
    const returns = [-2 / 100, -5 / 98, 20 / 93, -3 / 113, 0];
    const mean = returns.reduce((a, b) => a + b, 0) / 5;
    const sd = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / 4);
    const downside = Math.sqrt(returns.reduce((a, b) => a + Math.min(b, 0) ** 2, 0) / 5);
    expect(deployed.sharpe).toBeCloseTo((mean / sd) * ROOT_252, 10);
    expect(deployed.sortino).toBeCloseTo((mean / downside) * ROOT_252, 10);
  });
});

describe("edge cases", () => {
  it("has nothing to say about no trades, and does not divide by zero", () => {
    const none = computeMetrics([], SESSIONS, null);
    expect(none).toMatchObject({
      trades: 0,
      winRate: null,
      expectancyR: null,
      profitFactor: null,
      distribution: null,
      sharpe: null,
      sortino: null,
      exposure: { meanHoldMinutes: null, peakConcurrent: 0, positionMinutesPerSession: 0 },
      byYear: [],
    });
    expect(none.equity.maxDrawdownR).toBe(0);
    expect(computeMetrics([], [], 1_000_000 as Fixed).equity.maxDrawdownPct).toBe(0);
  });

  it("has no profit factor without a loss, and no interval from a single day", () => {
    const one = computeMetrics(
      [trade("2024-01-02", "A", 5, 9, 1), trade("2024-01-02", "B", 5, 9, 3)],
      ["2024-01-02"],
      null,
    );
    expect(one.profitFactor).toBeNull();
    expect(one.expectancyR).toEqual({ mean: 2, lower: 2, upper: 2 });
    expect(one.sharpe).toBeNull();
    expect(clusteredMean(new Map([["d", []]]))).toBeNull();
  });

  it("takes the smallest value with at least p of the sample at or below it", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.51)).toBe(3);
    expect(percentile([7], 0.05)).toBe(7);
  });
});
