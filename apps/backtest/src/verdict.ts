/**
 * The pre-registered verdict (L.2): Pre-Registration sections 4 to 6, computed from trades.
 *
 * Every number that decides anything comes from section 11 (the `VerdictThresholds` passed in), never
 * from here. What this file fixes is how they are applied, as Amendment 6 records:
 *
 * - A trade is a filled entry the cost gate passed. Its value is net R per trade as recorded, whole
 *   basis points of R, so every sum is exact and no result depends on the order trades are added in.
 * - The bootstrap resamples the sessions that have at least one trade, with replacement, as many as
 *   there are, all of a session's trades together, `resamples` times from core's mulberry32 seeded with
 *   `seed`. Each resample's statistic is its trades' mean: total R over total trades. The one-sided
 *   p-value is the share of resampled means at or below zero. The one-sided 95% lower bound is their
 *   5th percentile by nearest rank. The day-clustered standard error is their sample standard deviation.
 *   Every variant is resampled from the same seed, so two variants with the same sessions draw the same
 *   sessions in the same order.
 * - Holm runs over the confirmatory exits at the family alpha: the smallest p-value against alpha over
 *   the number of exits, the next against alpha over one fewer, stopping at the first that fails.
 * - A year is a calendar year of the in-sample window. A year with no trade is not a positive year, and
 *   leaving out a year with no trade leaves the whole.
 * - Top N of 10 is the confirmatory test run again, both exits and Holm, on the trades ranked 10 or
 *   better (section 4, step 2).
 */

import { createRng } from "@trader/core";

/** One trade, as the verdict sees it. */
export interface VerdictTrade {
  readonly session: string;
  /** Net R in whole basis points of R, as the run recorded it. */
  readonly netR: number;
  /** Opening-RVOL rank that session, 1 is the highest. */
  readonly rank: number;
}

export interface VerdictThresholds {
  readonly inSample: { readonly from: string; readonly to: string };
  readonly minTrades: number;
  readonly minPositiveYears: number;
  readonly years: number;
  readonly leaveOneYearOutPositive: boolean;
  readonly excludedRegimeYears: readonly number[];
  readonly excludedRegimeMeanPositive: boolean;
  readonly resamples: number;
  readonly seed: number;
  readonly familyAlpha: number;
  readonly notWorseZ: number;
  readonly topNChoices: readonly number[];
}

export interface Bootstrap {
  readonly trades: number;
  /** Sessions with at least one trade: the clusters. */
  readonly days: number;
  readonly mean: number;
  /** Share of resampled means at or below zero. */
  readonly pValue: number;
  /** One-sided 95% lower bound: the 5th percentile of the resampled means. */
  readonly lower: number;
  /** Day-clustered standard error: the resampled means' standard deviation. */
  readonly standardError: number;
}

export class VerdictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerdictError";
  }
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

/** Mean net R of the trades, in R. Null with none. */
export function meanR(trades: readonly VerdictTrade[]): number | null {
  return trades.length === 0 ? null : sum(trades.map((t) => t.netR)) / trades.length / 10_000;
}

/** The day-clustered bootstrap of section 5. Null with no trades. */
export function dayClusteredBootstrap(
  trades: readonly VerdictTrade[],
  resamples: number,
  seed: number,
): Bootstrap | null {
  if (!Number.isSafeInteger(resamples) || resamples < 2) {
    throw new VerdictError(`resamples must be a whole number of at least 2, got ${String(resamples)}`);
  }
  const days = new Map<string, { total: number; count: number }>();
  for (const trade of trades) {
    const day = days.get(trade.session) ?? days.set(trade.session, { total: 0, count: 0 }).get(trade.session);
    if (day !== undefined) {
      day.total += trade.netR;
      day.count += 1;
    }
  }
  if (days.size === 0) {
    return null;
  }
  // Sessions in date order, so the draws do not depend on the order trades arrived in.
  const ordered = [...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, day]) => day);
  const totals = Float64Array.from(ordered, (day) => day.total);
  const counts = Float64Array.from(ordered, (day) => day.count);
  const g = ordered.length;
  const rng = createRng(seed);
  const means = new Float64Array(resamples);
  for (let b = 0; b < resamples; b += 1) {
    let total = 0;
    let count = 0;
    for (let i = 0; i < g; i += 1) {
      const day = rng.int(0, g - 1);
      total += totals[day] as number;
      count += counts[day] as number;
    }
    means[b] = total / count / 10_000;
  }
  const sorted = Float64Array.from(means).sort();
  const average = sum([...means]) / resamples;
  const variance = sum([...means].map((m) => (m - average) ** 2)) / (resamples - 1);
  return {
    trades: trades.length,
    days: g,
    mean: sum([...totals]) / sum([...counts]) / 10_000,
    pValue: means.filter((m) => m <= 0).length / resamples,
    lower: sorted[Math.max(1, Math.ceil(0.05 * resamples)) - 1] as number,
    standardError: Math.sqrt(variance),
  };
}

export interface HolmStep {
  readonly p: number;
  readonly threshold: number;
  readonly significant: boolean;
}

/**
 * Holm's step-down over the family. The smallest p-value is tested against alpha over the family's size,
 * the next against alpha over one fewer, and so on; once one fails, every larger one fails too. Ties
 * break by id, so the result does not depend on insertion order.
 */
export function holm(pValues: ReadonlyMap<string, number>, alpha: number): Map<string, HolmStep> {
  const ordered = [...pValues].sort(([a, p], [b, q]) => (p !== q ? p - q : a < b ? -1 : 1));
  const m = ordered.length;
  let stillRejecting = true;
  return new Map(
    ordered.map(([id, p], k) => {
      const threshold = alpha / (m - k);
      stillRejecting = stillRejecting && p <= threshold;
      return [id, { p, threshold, significant: stillRejecting }];
    }),
  );
}

export interface YearRow {
  readonly year: number;
  readonly trades: number;
  readonly meanR: number | null;
  readonly totalR: number;
}

export interface Gate {
  readonly passed: boolean;
  readonly detail: string;
}

export type VariantOutcome = "pass" | "fail" | "insufficient";

export interface VariantVerdict {
  readonly id: string;
  readonly trades: number;
  readonly meanR: number | null;
  readonly bootstrap: Bootstrap | null;
  readonly holm: HolmStep | null;
  readonly years: readonly YearRow[];
  readonly gates: {
    readonly trades: Gate;
    readonly significance: Gate;
    readonly yearsPositive: Gate;
    readonly leaveOneYearOut: Gate;
    readonly excludedRegime: Gate;
  };
  readonly outcome: VariantOutcome;
}

const r4 = (value: number | null) =>
  value === null ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(4)}R`;

/** The in-sample calendar years, oldest first. Throws when they are not the number section 11 says. */
export function inSampleYears(thresholds: VerdictThresholds): number[] {
  const first = Number(thresholds.inSample.from.slice(0, 4));
  const last = Number(thresholds.inSample.to.slice(0, 4));
  const years = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  if (years.length !== thresholds.years) {
    throw new VerdictError(
      `the in-sample window covers ${String(years.length)} calendar years, section 11 says ${String(thresholds.years)}`,
    );
  }
  return years;
}

/** Section 6's in-sample gates for every confirmatory exit, Holm over them. Keyed by exit id. */
export function inSampleVerdict(
  byExit: ReadonlyMap<string, readonly VerdictTrade[]>,
  thresholds: VerdictThresholds,
): Map<string, VariantVerdict> {
  const years = inSampleYears(thresholds);
  const yearOf = (t: VerdictTrade) => Number(t.session.slice(0, 4));
  const outside = (trades: readonly VerdictTrade[], window: { from: string; to: string }) =>
    trades.filter((t) => t.session < window.from || t.session > window.to);
  for (const [id, trades] of byExit) {
    const stray = outside(trades, thresholds.inSample);
    if (stray.length > 0) {
      throw new VerdictError(
        `exit ${id} has trades outside the in-sample window, e.g. ${stray[0]?.session ?? ""}`,
      );
    }
  }
  const boots = new Map(
    [...byExit].map(([id, trades]) => [
      id,
      dayClusteredBootstrap(trades, thresholds.resamples, thresholds.seed),
    ]),
  );
  // An exit without a trade has nothing to test: p-value 1.
  const steps = holm(
    new Map([...boots].map(([id, boot]) => [id, boot?.pValue ?? 1])),
    thresholds.familyAlpha,
  );

  return new Map(
    [...byExit].map(([id, trades]) => {
      const boot = boots.get(id) ?? null;
      const step = steps.get(id) ?? null;
      const rows: YearRow[] = years.map((year) => {
        const inYear = trades.filter((t) => yearOf(t) === year);
        return {
          year,
          trades: inYear.length,
          meanR: meanR(inYear),
          totalR: sum(inYear.map((t) => t.netR)) / 10_000,
        };
      });
      const positive = rows.filter((row) => row.meanR !== null && row.meanR > 0);
      const leftOut = years.map((year) => ({ year, mean: meanR(trades.filter((t) => yearOf(t) !== year)) }));
      const failingYear = leftOut.find((row) => !(row.mean !== null && row.mean > 0));
      const regime = trades.filter((t) => !thresholds.excludedRegimeYears.includes(yearOf(t)));
      const regimeMean = meanR(regime);
      const gates = {
        trades: {
          passed: trades.length >= thresholds.minTrades,
          detail: `${String(trades.length)} trades, at least ${String(thresholds.minTrades)}`,
        },
        significance: {
          passed: step?.significant ?? false,
          detail:
            step === null
              ? "no p-value"
              : `p ${step.p.toFixed(4)} against ${step.threshold.toFixed(4)} (Holm, family alpha ${String(thresholds.familyAlpha)})`,
        },
        yearsPositive: {
          passed: positive.length >= thresholds.minPositiveYears,
          detail: `${String(positive.length)} of ${String(years.length)} years positive, at least ${String(thresholds.minPositiveYears)}`,
        },
        leaveOneYearOut: {
          passed: !thresholds.leaveOneYearOutPositive || failingYear === undefined,
          detail:
            failingYear === undefined
              ? `every year left out keeps it positive (lowest ${r4(Math.min(...leftOut.map((row) => row.mean ?? Number.NEGATIVE_INFINITY)))})`
              : `without ${String(failingYear.year)} the rest is ${r4(failingYear.mean)}`,
        },
        excludedRegime: {
          passed: !thresholds.excludedRegimeMeanPositive || (regimeMean !== null && regimeMean > 0),
          detail: `without ${thresholds.excludedRegimeYears.join(" and ")}: ${r4(regimeMean)} over ${String(regime.length)} trades`,
        },
      };
      const outcome: VariantOutcome = !gates.trades.passed
        ? "insufficient"
        : Object.values(gates).every((gate) => gate.passed)
          ? "pass"
          : "fail";
      return [
        id,
        {
          id,
          trades: trades.length,
          meanR: meanR(trades),
          bootstrap: boot,
          holm: step,
          years: rows,
          gates,
          outcome,
        },
      ];
    }),
  );
}

export interface FrozenChoice {
  readonly exit: string;
  readonly topN: number;
  /** Why, in a sentence. */
  readonly reason: string;
}

/**
 * Section 4's rule for the frozen configuration. Null when no exit passes.
 *
 * 1. Exit: of the exits that pass, the higher lower bound. A tie goes to the exit listed first.
 * 2. Top N: the largest choice (20), unless the smaller (10) passes every gate on its own, Holm over
 *    both exits again, with a higher lower bound for the chosen exit.
 */
export function chooseFrozen(
  full: ReadonlyMap<string, VariantVerdict>,
  smaller: ReadonlyMap<string, VariantVerdict>,
  thresholds: VerdictThresholds,
): FrozenChoice | null {
  const passing = [...full.values()].filter((v) => v.outcome === "pass");
  const best = passing.reduce<VariantVerdict | null>(
    (chosen, v) =>
      chosen === null || (v.bootstrap?.lower ?? -Infinity) > (chosen.bootstrap?.lower ?? -Infinity)
        ? v
        : chosen,
    null,
  );
  if (best === null) {
    return null;
  }
  const [small, large] = [Math.min(...thresholds.topNChoices), Math.max(...thresholds.topNChoices)];
  const narrow = smaller.get(best.id);
  const narrowWins =
    narrow !== undefined &&
    narrow.outcome === "pass" &&
    (narrow.bootstrap?.lower ?? -Infinity) > (best.bootstrap?.lower ?? -Infinity);
  const lower = (v: VariantVerdict | undefined) => r4(v?.bootstrap?.lower ?? null);
  return {
    exit: best.id,
    topN: narrowWins ? small : large,
    reason:
      `exit ${best.id}: ${passing.length === 1 ? "the only exit to pass" : `the higher lower bound, ${lower(best)}`}; ` +
      (narrowWins
        ? `top ${String(small)}: it passes alone with a higher lower bound, ${lower(narrow)} against ${lower(best)}`
        : `top ${String(large)}: top ${String(small)} ${narrow?.outcome === "pass" ? `has a lower bound of ${lower(narrow)}, not higher` : "does not pass alone"}`),
  };
}

export interface HoldoutVerdict {
  readonly trades: number;
  readonly bootstrap: Bootstrap | null;
  readonly inSampleMeanR: number;
  readonly gates: { readonly positive: Gate; readonly notWorse: Gate };
  readonly outcome: "pass" | "fail";
}

/** Section 6's holdout gates on the frozen configuration's holdout trades. */
export function holdoutVerdict(
  trades: readonly VerdictTrade[],
  inSampleMeanR: number,
  thresholds: Pick<VerdictThresholds, "resamples" | "seed" | "notWorseZ">,
): HoldoutVerdict {
  const boot = dayClusteredBootstrap(trades, thresholds.resamples, thresholds.seed);
  const mean = boot?.mean ?? null;
  const reach = boot === null ? null : boot.mean + thresholds.notWorseZ * boot.standardError;
  const gates = {
    positive: {
      passed: mean !== null && mean > 0,
      detail: `holdout net mean ${r4(mean)} over ${String(trades.length)} trades`,
    },
    notWorse: {
      passed: reach !== null && inSampleMeanR <= reach,
      detail: `in-sample ${r4(inSampleMeanR)} against holdout mean plus ${String(thresholds.notWorseZ)} standard errors, ${r4(reach)}`,
    },
  };
  return {
    trades: trades.length,
    bootstrap: boot,
    inSampleMeanR,
    gates,
    outcome: gates.positive.passed && gates.notWorse.passed ? "pass" : "fail",
  };
}
