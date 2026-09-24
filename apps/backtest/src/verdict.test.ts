import { createRng } from "@trader/core";
import { describe, expect, it } from "vitest";
import { clusteredMean } from "./metrics.js";
import {
  type VariantVerdict,
  type VerdictThresholds,
  type VerdictTrade,
  VerdictError,
  chooseFrozen,
  dayClusteredBootstrap,
  holdoutVerdict,
  holm,
  inSampleVerdict,
  meanR,
} from "./verdict.js";

/** Section 11's gates, with a trade minimum a test can reach and fewer resamples. */
const THRESHOLDS: VerdictThresholds = {
  inSample: { from: "2016-01-04", to: "2023-12-29" },
  minTrades: 200,
  minPositiveYears: 5,
  years: 8,
  leaveOneYearOutPositive: true,
  excludedRegimeYears: [2020, 2021],
  excludedRegimeMeanPositive: true,
  resamples: 2_000,
  seed: 20260922,
  familyAlpha: 0.05,
  notWorseZ: 1.96,
  topNChoices: [10, 20],
};

const YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];

/**
 * `perDay` trades on each of `days` sessions a year, drawn from a skewed ORB-like distribution: a stop
 * at -1.1R most of the time, a winner of 1R to 5R otherwise, shifted so the year's true mean is `edge`.
 */
function market(edgeByYear: (year: number) => number, days = 60, perDay = 3, seed = 1): VerdictTrade[] {
  const rng = createRng(seed);
  const trades: VerdictTrade[] = [];
  for (const year of YEARS) {
    for (let d = 0; d < days; d += 1) {
      const session = `${String(year)}-${String(3 + Math.floor(d / 28)).padStart(2, "0")}-${String((d % 28) + 1).padStart(2, "0")}`;
      const common = rng.normal() * 0.3;
      for (let t = 0; t < perDay; t += 1) {
        const raw = rng.next() < 0.3 ? 1 + rng.next() * 4 : -1.1;
        const r = raw - 0.14 + common + edgeByYear(year);
        trades.push({ session, netR: Math.round(r * 10_000), rank: 1 + ((d + t) % 20) });
      }
    }
  }
  return trades;
}

describe("the day-clustered bootstrap", () => {
  const trades = market(() => 0.05);

  it("is the trades' mean, over sessions that traded, and repeats exactly from its seed", () => {
    const boot = dayClusteredBootstrap(trades, 2_000, 7);
    expect(boot?.mean).toBeCloseTo(meanR(trades) ?? 0, 12);
    expect(boot?.trades).toBe(trades.length);
    expect(boot?.days).toBe(8 * 60);
    expect(dayClusteredBootstrap(trades, 2_000, 7)).toEqual(boot);
    expect(dayClusteredBootstrap([...trades].reverse(), 2_000, 7)).toEqual(boot);
    expect(dayClusteredBootstrap(trades, 2_000, 8)?.pValue).not.toBe(boot?.pValue);
  });

  it("agrees with the analytic clustered standard error, and its bounds with its p-value", () => {
    const boot = dayClusteredBootstrap(trades, 20_000, 20260922);
    const byDay = new Map<string, number[]>();
    for (const t of trades) {
      (byDay.get(t.session) ?? byDay.set(t.session, []).get(t.session))?.push(t.netR / 10_000);
    }
    const analytic = clusteredMean(byDay);
    const analyticSe = ((analytic?.upper ?? 0) - (analytic?.mean ?? 0)) / 1.96;
    expect(boot?.standardError).toBeGreaterThan(analyticSe * 0.9);
    expect(boot?.standardError).toBeLessThan(analyticSe * 1.1);
    // A lower bound above zero means fewer than 5% of resamples at or below it.
    expect((boot?.lower ?? 0) > 0).toBe((boot?.pValue ?? 1) < 0.05);
  });

  it("gives p 0 when every trade wins and 1 when every trade loses, and nothing from no trades", () => {
    const wins = trades.map((t) => ({ ...t, netR: Math.abs(t.netR) + 100 }));
    expect(dayClusteredBootstrap(wins, 500, 1)?.pValue).toBe(0);
    expect(
      dayClusteredBootstrap(
        wins.map((t) => ({ ...t, netR: -t.netR })),
        500,
        1,
      )?.pValue,
    ).toBe(1);
    expect(dayClusteredBootstrap([], 500, 1)).toBeNull();
    expect(() => dayClusteredBootstrap(trades, 1, 1)).toThrow(VerdictError);
  });

  it("resamples days, not trades: a common daily shock widens the interval", () => {
    const independent = market(() => 0, 40, 1, 3).map((t, i) => ({ ...t, session: `x${String(i)}` }));
    const clustered = independent.map((t, i) => ({ ...t, session: `d${String(Math.floor(i / 8))}` }));
    const wide = dayClusteredBootstrap(
      clustered.map((t) => ({ ...t, netR: t.netR + (Number(t.session.slice(1)) % 3) * 10_000 })),
      2_000,
      1,
    );
    const narrow = dayClusteredBootstrap(
      independent.map((t, i) => ({ ...t, netR: t.netR + (Math.floor(i / 8) % 3) * 10_000 })),
      2_000,
      1,
    );
    expect(wide?.standardError).toBeGreaterThan((narrow?.standardError ?? 0) * 1.5);
  });
});

describe("Holm over the confirmatory exits", () => {
  it("tests the smaller p-value at alpha over two, then the larger at alpha", () => {
    expect(
      Object.fromEntries(
        holm(
          new Map([
            ["A", 0.01],
            ["B", 0.04],
          ]),
          0.05,
        ),
      ),
    ).toEqual({
      A: { p: 0.01, threshold: 0.025, significant: true },
      B: { p: 0.04, threshold: 0.05, significant: true },
    });
    const one = holm(
      new Map([
        ["A", 0.02],
        ["B", 0.06],
      ]),
      0.05,
    );
    expect([one.get("A")?.significant, one.get("B")?.significant]).toEqual([true, false]);
  });

  it("stops at the first that fails: a larger p-value cannot pass after a smaller one failed", () => {
    const none = holm(
      new Map([
        ["A", 0.03],
        ["B", 0.04],
      ]),
      0.05,
    );
    expect([none.get("A")?.significant, none.get("B")?.significant]).toEqual([false, false]);
    expect(none.get("B")?.threshold).toBe(0.05);
  });

  it("breaks a tie by id, whatever order the p-values came in", () => {
    expect(
      holm(
        new Map([
          ["B", 0.02],
          ["A", 0.02],
        ]),
        0.05,
      ).get("A")?.threshold,
    ).toBe(0.025);
  });
});

describe("the in-sample gates", () => {
  const verdict = (edge: (year: number) => number, edgeB = edge, thresholds = THRESHOLDS) =>
    inSampleVerdict(
      new Map([
        ["A", market(edge, 60, 3, 11)],
        ["B", market(edgeB, 60, 3, 12)],
      ]),
      thresholds,
    );

  it("passes a steady edge on every gate, with the year table beside it", () => {
    const a = verdict(() => 0.4).get("A") as VariantVerdict;
    expect(a.outcome).toBe("pass");
    expect(Object.values(a.gates).every((gate) => gate.passed)).toBe(true);
    expect(a.years.map((y) => [y.year, y.trades])).toEqual(YEARS.map((year) => [year, 180]));
    expect(a.years.reduce((n, y) => n + y.totalR, 0)).toBeCloseTo((a.meanR as number) * a.trades, 8);
  });

  it("fails no edge on significance", () => {
    const a = verdict(() => -0.05).get("A") as VariantVerdict;
    expect(a.outcome).toBe("fail");
    expect(a.gates.significance.passed).toBe(false);
  });

  it("fails an edge that lives in 2020 and 2021", () => {
    const a = verdict((year) => (year === 2020 || year === 2021 ? 1.5 : -0.1)).get("A") as VariantVerdict;
    expect(a.gates.significance.passed).toBe(true);
    expect(a.gates.excludedRegime.passed).toBe(false);
    expect(a.gates.yearsPositive.passed).toBe(false);
    expect(a.outcome).toBe("fail");
  });

  it("fails an edge one year carries", () => {
    const a = verdict((year) => (year === 2017 ? 3 : -0.05)).get("A") as VariantVerdict;
    expect(a.gates.leaveOneYearOut.passed).toBe(false);
    expect(a.gates.leaveOneYearOut.detail).toContain("without 2017");
    expect(a.outcome).toBe("fail");
  });

  it("is insufficient under the trade minimum, whatever else holds", () => {
    const a = verdict(
      () => 0.4,
      () => 0.4,
      { ...THRESHOLDS, minTrades: 5_000 },
    ).get("A") as VariantVerdict;
    expect(a.outcome).toBe("insufficient");
    expect(a.gates.significance.passed).toBe(true);
  });

  it("does not count a year with no trades as positive, and refuses trades outside the window", () => {
    const missing = market(() => 0.4).filter(
      (t) => !t.session.startsWith("2019") && !t.session.startsWith("2018"),
    );
    const a = inSampleVerdict(new Map([["A", missing]]), { ...THRESHOLDS, minPositiveYears: 7 }).get("A");
    expect(a?.gates.yearsPositive.detail).toBe("6 of 8 years positive, at least 7");
    expect(a?.years.find((y) => y.year === 2018)).toEqual({ year: 2018, trades: 0, meanR: null, totalR: 0 });
    expect(() =>
      inSampleVerdict(new Map([["A", [{ session: "2024-01-02", netR: 10_000, rank: 1 }]]]), THRESHOLDS),
    ).toThrow(/outside the in-sample window/);
    expect(() => inSampleVerdict(new Map(), { ...THRESHOLDS, years: 9 })).toThrow(/8 calendar years/);
  });

  it("applies Holm across the exits, so a weaker second exit faces alpha only if the first passed", () => {
    const both = verdict(
      () => 0.4,
      () => 0.12,
    );
    const [a, b] = [both.get("A"), both.get("B")];
    expect(a?.holm?.threshold).toBe(0.025);
    expect(b?.holm?.threshold).toBe(0.05);
  });
});

describe("the frozen configuration's rule", () => {
  const passing = (id: string, lower: number, outcome: VariantVerdict["outcome"] = "pass"): VariantVerdict =>
    ({ id, outcome, bootstrap: { lower } }) as VariantVerdict;
  const map = (...verdicts: VariantVerdict[]) => new Map(verdicts.map((v) => [v.id, v]));

  it("takes the passing exit with the higher lower bound, and the first on a tie", () => {
    expect(chooseFrozen(map(passing("A", 0.01), passing("B", 0.02)), map(), THRESHOLDS)?.exit).toBe("B");
    expect(chooseFrozen(map(passing("A", 0.02), passing("B", 0.02)), map(), THRESHOLDS)?.exit).toBe("A");
    expect(chooseFrozen(map(passing("A", 0.5, "fail"), passing("B", 0.01)), map(), THRESHOLDS)?.exit).toBe(
      "B",
    );
    expect(
      chooseFrozen(map(passing("A", 0.5, "fail"), passing("B", 0.5, "insufficient")), map(), THRESHOLDS),
    ).toBeNull();
  });

  it("takes top 10 only when it passes alone with a higher lower bound", () => {
    const full = map(passing("A", 0.02), passing("B", 0.01, "fail"));
    expect(chooseFrozen(full, map(passing("A", 0.03)), THRESHOLDS)).toMatchObject({ exit: "A", topN: 10 });
    expect(chooseFrozen(full, map(passing("A", 0.015)), THRESHOLDS)).toMatchObject({ exit: "A", topN: 20 });
    expect(chooseFrozen(full, map(passing("A", 0.9, "fail")), THRESHOLDS)).toMatchObject({
      exit: "A",
      topN: 20,
    });
    expect(chooseFrozen(full, map(), THRESHOLDS)?.reason).toContain("does not pass alone");
  });
});

describe("the holdout gates", () => {
  const trades = market(() => 0.3, 60, 3, 5).map((t) => ({ ...t, session: `2024${t.session.slice(4)}` }));

  it("passes a positive holdout the in-sample mean does not tower over", () => {
    const v = holdoutVerdict(trades, 0.2, THRESHOLDS);
    expect(v.outcome).toBe("pass");
    expect(v.gates.notWorse.passed).toBe(true);
  });

  it("fails when the in-sample mean sits above the holdout's reach, or the holdout is not positive", () => {
    const boot = holdoutVerdict(trades, 0, THRESHOLDS).bootstrap;
    const reach = (boot?.mean ?? 0) + 1.96 * (boot?.standardError ?? 0);
    expect(holdoutVerdict(trades, reach + 0.001, THRESHOLDS).gates.notWorse.passed).toBe(false);
    expect(holdoutVerdict(trades, reach - 0.001, THRESHOLDS).gates.notWorse.passed).toBe(true);
    const flat = holdoutVerdict(
      trades.map((t) => ({ ...t, netR: t.netR - 10_000 })),
      0,
      THRESHOLDS,
    );
    expect(flat.gates.positive.passed).toBe(false);
    expect(flat.outcome).toBe("fail");
    expect(holdoutVerdict([], 0, THRESHOLDS).outcome).toBe("fail");
  });
});
