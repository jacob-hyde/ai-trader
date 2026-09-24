/**
 * Study 2.1, the no-news overnight gap fade (Round 2, section 5): the trades, their prices, the verdict,
 * and the diagnostics.
 *
 * Each session, the eligible names that gapped up by at least the registered minimum by 09:25, with no
 * article naming them overnight and not under the short-sale price test, rank by gap, largest first,
 * and the top N are shorted on the opening auction and covered on the closing auction. Each trade's
 * value is its net return in millionths of the entry (integers, so sums are exact): the open less the
 * close over the open, less the sale fee. The verdict is Round 2's gates at the study's alpha, on the
 * same bootstrap as ORB's.
 *
 * The diagnostics are priced from the store's daily bars (the day's open and close as traded), not from
 * auction prints, and gate nothing: the same fade on names that had news, the mirror long on quiet
 * gap-downs, and the confirmatory trades by gap size.
 */

import type { Fixed, SessionDate } from "@trader/contracts";
import { clusteredMean } from "../metrics.js";
import type { Round2 } from "../round2.js";
import { type VariantVerdict, type VerdictTrade, inSampleVerdict } from "../verdict.js";
import type { AuctionPrint } from "./auction.js";
import type { Gapper } from "./signals.js";

export interface PickRules {
  readonly minGap: number;
  readonly topN: number;
}

/** The session's trades: quiet gap-ups at or over the minimum, not under the price test, top N by gap. */
export function pick(
  gappers: readonly Gapper[],
  rules: PickRules,
  restricted: ReadonlySet<string>,
  side: "up" | "down" = "up",
  news: "quiet" | "news" = "quiet",
): Gapper[] {
  return gappers
    .filter(
      (g) =>
        (side === "up" ? g.gap >= rules.minGap : g.gap <= -rules.minGap) &&
        (news === "quiet" ? g.news === 0 : g.news > 0) &&
        !restricted.has(g.symbol),
    )
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || (a.symbol < b.symbol ? -1 : 1))
    .slice(0, rules.topN);
}

/**
 * Whether the short-sale price test is on for a session: the prior session's low at least `drop` under
 * the close before it. Both on the prior session's share basis.
 */
export function underPriceTest(priorLow: number, closeBefore: number, drop: number): boolean {
  return priorLow <= closeBefore * (1 - drop);
}

/** Net return in millionths of the entry, floored, after the sale fee. */
export function netMillionths(
  direction: "short" | "long",
  open: number,
  close: number,
  saleFeeBps: number,
): number {
  const gross = direction === "short" ? (open - close) / open : (close - open) / open;
  return Math.floor((gross - saleFeeBps / 10_000) * 1_000_000 + 1e-9);
}

export interface PricedTrade {
  readonly symbol: string;
  readonly session: SessionDate;
  readonly gap: number;
  readonly open: AuctionPrint | null;
  readonly close: AuctionPrint | null;
  /** Null when either auction print is missing. */
  readonly net: number | null;
}

export interface Estimate {
  readonly trades: number;
  /** In basis points of the entry. */
  readonly meanBps: number | null;
  readonly lowerBps: number | null;
  readonly upperBps: number | null;
}

/** Mean net return in bps with its analytic day-clustered 95% interval. */
export function estimateBps(
  trades: ReadonlyArray<{ readonly session: string; readonly net: number }>,
): Estimate {
  const byDay = new Map<string, number[]>();
  for (const t of trades) {
    (byDay.get(t.session) ?? byDay.set(t.session, []).get(t.session))?.push(t.net / 100);
  }
  const m = clusteredMean(byDay);
  return {
    trades: trades.length,
    meanBps: m?.mean ?? null,
    lowerBps: m?.lower ?? null,
    upperBps: m?.upper ?? null,
  };
}

export interface GapFadeResult {
  readonly verdict: VariantVerdict;
  readonly priced: number;
  readonly unpriced: number;
  readonly diagnostics: {
    readonly withNews: Estimate;
    readonly gapDownLong: Estimate;
    readonly byGap: ReadonlyArray<{
      readonly from: number;
      readonly to: number | null;
      readonly estimate: Estimate;
    }>;
  };
}

/** Gap buckets for the diagnostics, as fractions of the prior close. */
export const GAP_BUCKETS: ReadonlyArray<readonly [number, number | null]> = [
  [0, 0.05],
  [0.05, 0.1],
  [0.1, null],
];

/**
 * The verdict and diagnostics from priced trades. `daily` prices a diagnostic trade from the day's own
 * open and close as traded, or null when the store has no bar.
 */
export function judge(options: {
  readonly round: Round2;
  readonly minTrades: number;
  readonly trades: readonly PricedTrade[];
  readonly withNews: readonly Gapper[];
  readonly gapDowns: readonly Gapper[];
  readonly daily: (
    symbol: string,
    session: SessionDate,
  ) => { readonly open: number; readonly close: number } | null;
}): GapFadeResult {
  const { round } = options;
  const priced = options.trades.filter((t): t is PricedTrade & { net: number } => t.net !== null);
  // The verdict's unit is whatever its integers are; here millionths of the entry.
  const verdictTrades: VerdictTrade[] = priced.map((t) => ({ session: t.session, netR: t.net, rank: 1 }));
  const verdict = inSampleVerdict(new Map([["2.1", verdictTrades]]), {
    inSample: round.samples.inSample,
    minTrades: options.minTrades,
    minPositiveYears: round.inSampleGates.minPositiveYears,
    years: round.inSampleGates.years,
    leaveOneYearOutPositive: round.inSampleGates.leaveOneYearOutPositive,
    excludedRegimeYears: round.inSampleGates.excludedRegimeYears,
    excludedRegimeMeanPositive: round.inSampleGates.excludedRegimeMeanPositive,
    resamples: round.statistics.resamples,
    seed: round.statistics.seed,
    familyAlpha: round.studyAlpha,
    notWorseZ: round.holdoutGates.notWorseZ,
    topNChoices: [1],
  }).get("2.1") as VariantVerdict;
  const fee = round.prices.saleFeeBps;
  const diagnostic = (gappers: readonly Gapper[], direction: "short" | "long") =>
    estimateBps(
      gappers.flatMap((g) => {
        const bar = options.daily(g.symbol, g.session);
        return bar === null
          ? []
          : [{ session: g.session, net: netMillionths(direction, bar.open, bar.close, fee) }];
      }),
    );
  return {
    verdict,
    priced: priced.length,
    unpriced: options.trades.length - priced.length,
    diagnostics: {
      withNews: diagnostic(options.withNews, "short"),
      gapDownLong: diagnostic(options.gapDowns, "long"),
      byGap: GAP_BUCKETS.map(([from, to]) => ({
        from,
        to,
        estimate: estimateBps(priced.filter((t) => t.gap >= from && (to === null || t.gap < to))),
      })),
    },
  };
}

/** A price in $0.0001 units as dollars. */
export const dollars = (units: Fixed | number) => Number(units) / 10_000;
