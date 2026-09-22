import { describe, expect, it } from "vitest";
import type { Bar } from "./bars.js";
import { DEFAULT_COST_TO_RISK } from "./costToRisk.js";
import { DEFAULT_COST_MODEL } from "./costs.js";
import { fixed, ratio } from "./money.js";
import {
  MIN_TRADES,
  NullModelError,
  formatNullModelReport,
  runNullModel,
  statistics,
  verdictFor,
  type NullModelConfig,
  type RStatistics,
} from "./nullModel.js";
import { DEFAULT_PATH_CONFIG } from "./paths.js";
import { DEFAULT_RISK_CONFIG } from "./riskRules.js";
import type { TradePlan } from "./setup.js";
import { simulateTrade } from "./tradeSim.js";

/** Paths per run: a few thousand on every push, far more nightly. About one second per thousand. */
export const NULL_MODEL_PATHS = Number(process.env["NULL_MODEL_PATHS"] ?? 5_000);

/**
 * The standing configuration. A volatile $20 name, one price move a second, the range-low stop
 * because the published 10% ATR stop never clears the cost gate on any path, and the production
 * cost model and gate. Every session decides alone against $100,000.
 */
export const NULL_MODEL_CONFIG: NullModelConfig = {
  paths: NULL_MODEL_PATHS,
  firstSeed: 1,
  path: { ...DEFAULT_PATH_CONFIG, startPrice: fixed(200_000), volatilityBps: 70, stepsPerBar: 60 },
  setupParams: { stop: { kind: "openingRange" } },
  decision: {
    costModel: DEFAULT_COST_MODEL,
    costToRisk: DEFAULT_COST_TO_RISK,
    sizing: { riskPerTrade: ratio(100), maxPositionPct: ratio(2_500), regime: { kind: "proven" } },
    risk: DEFAULT_RISK_CONFIG,
  },
  equity: fixed(1_000_000_000),
  dailyAtrOfPrice: ratio(500),
  openingRvol: ratio(20_000),
  flattenMinute: 380,
  // Correct code lands within a hundredth of an R of zero gross. Two hundredths leaves room for that
  // and still catches a leak worth a tenth of an R once the nightly run has the power to see it.
  grossToleranceR: 0.02,
};

const stats = (count: number, meanR: number, halfWidth: number): RStatistics => ({
  count,
  meanR,
  sdR: 1,
  lowerR: meanR - halfWidth,
  upperR: meanR + halfWidth,
});

describe("the null-model tripwire on correct code", () => {
  const report = runNullModel(NULL_MODEL_CONFIG);

  it("passes: no established gross edge, and every fill charged", () => {
    expect(report.verdict, formatNullModelReport(report)).toBe("pass");
    expect(report.reasons).toEqual([]);
    expect(report.leakInjected).toBe(false);
    expect(report.trades).toBeGreaterThanOrEqual(MIN_TRADES);
  });

  it("lands at about zero gross: the interval contains zero", () => {
    expect(report.gross.lowerR, formatNullModelReport(report)).toBeLessThanOrEqual(0);
    expect(report.gross.upperR, formatNullModelReport(report)).toBeGreaterThanOrEqual(0);
  });

  it("nets exactly gross minus the drag, and the drag is what the cost model charges", () => {
    expect(report.net.meanR).toBeCloseTo(report.gross.meanR - report.dragR, 10);
    // A $0.36 range on a $20 name against a 30 bps round trip is on the order of a tenth of an R.
    expect(report.dragR).toBeGreaterThan(0.05);
    expect(report.dragR).toBeLessThan(0.25);
    expect(report.net.upperR).toBeLessThan(report.gross.upperR);
  });

  it("exercises the mechanics: signals, gate refusals, fills, stop-outs, and EOD exits", () => {
    expect(report.signals).toBeGreaterThan(report.paths * 0.4);
    expect(report.refused.costToRisk).toBeGreaterThan(0);
    expect(report.exits.stop).toBeGreaterThan(report.exits.eod);
    expect(report.exits.eod).toBeGreaterThan(0);
    expect(report.exits.target + report.exits.breakevenStop).toBe(0);
    expect(report.unfilled).toBeGreaterThan(0);
  });

  it("is reproducible from its first seed", () => {
    const again = runNullModel({ ...NULL_MODEL_CONFIG, paths: 300 });
    expect(runNullModel({ ...NULL_MODEL_CONFIG, paths: 300 })).toEqual(again);
    expect(runNullModel({ ...NULL_MODEL_CONFIG, paths: 300, firstSeed: 7 }).gross).not.toEqual(again.gross);
  });
});

describe("the null-model tripwire with a leak injected", () => {
  it("fails when losing trades are skipped, which needs the whole day", () => {
    // Blatant, so a modest run sees it. About one trade in six wins, so 8,000 paths leave enough.
    const leak = (plan: TradePlan, session: readonly Bar[]): boolean => {
      const outcome = simulateTrade(plan, session, {
        shares: 1,
        costModel: DEFAULT_COST_MODEL,
        lastEntryMinute: 360,
        flattenMinute: 380,
      });
      return outcome.filled && outcome.netR > 0;
    };
    const report = runNullModel({ ...NULL_MODEL_CONFIG, paths: 8_000, leak });
    expect(report.leakInjected).toBe(true);
    expect(report.trades).toBeGreaterThanOrEqual(MIN_TRADES);
    expect(report.verdict, formatNullModelReport(report)).toBe("fail");
    expect(report.gross.lowerR).toBeGreaterThan(1);
    expect(report.exits.stop).toBe(0);
    expect(report.reasons.join(" ")).toContain("edge on random data");
  });

  // Deciding the trigger from the bar's own close is worth about a tenth of an R here, a quarter of
  // the width a 5,000-path interval can resolve. The nightly run, at 100,000 paths, has the power.
  it.skipIf(NULL_MODEL_PATHS < 100_000)(
    "fails when the trigger is decided from the bar's close, at nightly scale",
    () => {
      const leak = (plan: TradePlan, session: readonly Bar[]): boolean =>
        (session[5] as Bar).close > plan.signal.entry;
      const report = runNullModel({ ...NULL_MODEL_CONFIG, leak });
      expect(report.verdict, formatNullModelReport(report)).toBe("fail");
    },
  );
});

describe("statistics", () => {
  it("gives a mean, a sample standard deviation, and a 95% interval", () => {
    const s = statistics([1, 2, 3, 4]);
    expect(s.count).toBe(4);
    expect(s.meanR).toBe(2.5);
    expect(s.sdR).toBeCloseTo(1.290994, 5);
    expect(s.upperR - s.meanR).toBeCloseTo((1.96 * s.sdR) / 2, 10);
    expect(s.meanR - s.lowerR).toBeCloseTo((1.96 * s.sdR) / 2, 10);
  });

  it("has no spread to measure under two values", () => {
    expect(statistics([])).toEqual({ count: 0, meanR: 0, sdR: 0, lowerR: 0, upperR: 0 });
    expect(statistics([0.7])).toEqual({ count: 1, meanR: 0.7, sdR: 0, lowerR: 0.7, upperR: 0.7 });
  });
});

describe("verdictFor", () => {
  it("is insufficient below the minimum trade count, whatever the numbers say", () => {
    expect(verdictFor(stats(MIN_TRADES - 1, 5, 0.1), 0.1, 0.05).verdict).toBe("insufficient");
    expect(verdictFor(stats(0, 0, 0), 0, 0.05).reasons[0]).toContain("0 trades");
  });

  it("passes when the gross interval contains zero or lies below it, and the drag is positive", () => {
    expect(verdictFor(stats(MIN_TRADES, 0.02, 0.1), 0.12, 0.05)).toEqual({ verdict: "pass", reasons: [] });
    expect(verdictFor(stats(1_000, -0.3, 0.1), 0.12, 0.05).verdict).toBe("pass");
    expect(verdictFor(stats(1_000, 0.1, 0.05), 0.12, 0.05).verdict).toBe("pass");
  });

  it("fails on an established edge: the lower bound above the tolerance", () => {
    const { verdict, reasons } = verdictFor(stats(1_000, 0.2, 0.1), 0.12, 0.05);
    expect(verdict).toBe("fail");
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("lower bound 0.1000R");
  });

  it("fails when fills were not charged: a drag of zero, negative, or NaN", () => {
    for (const dragR of [0, -0.01, Number.NaN]) {
      const { verdict, reasons } = verdictFor(stats(1_000, 0, 0.1), dragR, 0.05);
      expect(verdict, String(dragR)).toBe("fail");
      expect(reasons[0]).toContain("not being charged");
    }
  });

  it("lists both reasons when both apply", () => {
    expect(verdictFor(stats(1_000, 0.5, 0.1), 0, 0.05).reasons).toHaveLength(2);
  });
});

describe("runNullModel configuration", () => {
  it("throws on a path count, seed, or tolerance it cannot run with", () => {
    expect(() => runNullModel({ ...NULL_MODEL_CONFIG, paths: 0 })).toThrow(NullModelError);
    expect(() => runNullModel({ ...NULL_MODEL_CONFIG, paths: 1.5 })).toThrow(NullModelError);
    expect(() => runNullModel({ ...NULL_MODEL_CONFIG, firstSeed: 0.5 })).toThrow(NullModelError);
    expect(() => runNullModel({ ...NULL_MODEL_CONFIG, grossToleranceR: -0.01 })).toThrow(NullModelError);
    expect(() => runNullModel({ ...NULL_MODEL_CONFIG, grossToleranceR: Number.NaN })).toThrow(NullModelError);
  });

  it("reports insufficient, not pass, on too few paths", () => {
    const report = runNullModel({ ...NULL_MODEL_CONFIG, paths: 40 });
    expect(report.verdict).toBe("insufficient");
    expect(report.trades).toBeLessThan(MIN_TRADES);
  });

  it("refuses every signal at the cost gate with the published stop and a realistic ATR", () => {
    const report = runNullModel({ ...NULL_MODEL_CONFIG, paths: 200, setupParams: {} });
    expect(report.signals).toBeGreaterThan(50);
    expect(report.refused.costToRisk).toBe(report.signals);
    expect(report.verdict).toBe("insufficient");
  });

  it("floors a vanishing ATR at a penny, which the setup then refuses as below its own floor", () => {
    const report = runNullModel({
      ...NULL_MODEL_CONFIG,
      paths: 50,
      setupParams: {},
      dailyAtrOfPrice: ratio(1),
    });
    expect(report.signals).toBe(0);
    expect(report.verdict).toBe("insufficient");
  });
});

describe("formatNullModelReport", () => {
  it("prints the verdict, the counts, both intervals, the drag, and every reason", () => {
    const report = runNullModel({ ...NULL_MODEL_CONFIG, paths: 40 });
    const text = formatNullModelReport(report);
    expect(text).toContain("null model: INSUFFICIENT");
    expect(text).toContain("paths 40 from seed 1");
    expect(text).toMatch(
      /gross [+-]\d\.\d{4}R \[[+-]\d\.\d{4}R, [+-]\d\.\d{4}R\] sd \d\.\d{3} \(tolerance \+0\.0200R\)/,
    );
    expect(text).toMatch(/net {3}[+-]/);
    expect(text).toMatch(/drag {2}[+-]\d\.\d{4}R per trade/);
    expect(text).toContain("trades is below");
    const leaked = runNullModel({ ...NULL_MODEL_CONFIG, paths: 40, leak: () => true });
    expect(formatNullModelReport(leaked)).toContain("(leak injected)");
  });
});
