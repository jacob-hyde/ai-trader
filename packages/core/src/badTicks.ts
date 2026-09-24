/**
 * The bad-tick filter (H.8): a price that cannot be trusted never reaches a stage that acts on it.
 *
 * One erroneous print can trigger a resting stop entry, fill a target, or stop a position out, and a
 * minute bar carries it as its high or low. So a bar's extremes are judged before the broker or the
 * engine sees the bar. An extreme that reaches past both the bar's own body (its open and close) and
 * the last clean close by more than the limit is a bad print, and the high or low is cut back to the
 * body. Open, close, and volume are never changed.
 *
 * A real fast move moves the body with it, so a gap, a halt reopening, or a squeeze passes untouched.
 * Only a lone extreme that neither the rest of the bar nor the minute before it follows is cut. The
 * limit is the larger of a percentage of price and a multiple of the symbol's recent average minute
 * range, so a name already moving several percent a minute is judged against its own pace. Until a
 * session has enough bars to average, the percentage alone applies.
 *
 * Causal: a bar is judged on itself and the bars before it, never on the bar after, since a broker acts
 * on a bar before the next one exists. Replayed from a store, it cuts exactly what it would have cut
 * live.
 *
 * What it cannot repair: a bar that is a bad print from open to close. Nothing inside the bar disagrees
 * with it, and only the next bar could, which would be look-ahead. A day corrupted that way shows up as
 * a day the filter cuts again and again, since its good and bad prints land in the same bars, so
 * countCuts is how such a symbol-session is found and left out whole. In the in-sample store there is
 * one: JWN on 2018-03-26, trading at $46.90 and at a phantom $63.60 all day.
 *
 * isSanePrint and isSaneQuote apply the same limit to a single trade or quote, for the live feed (H.3),
 * where a print also has to sit near the NBBO.
 */

import type { Bar } from "./bars.js";
import type { Quote } from "./costs.js";
import {
  type Fixed,
  type Ratio,
  ONE_HUNDRED_PERCENT,
  add,
  max,
  midpoint,
  min,
  mulRatio,
  ratio,
  sub,
} from "./money.js";

export interface BadTickConfig {
  /**
   * How far past both the bar's body and the last clean close an extreme may reach, in basis points of
   * that level. 1 000 is 10%.
   */
  readonly maxExcursion: Ratio;
  /**
   * The same limit as a multiple of the symbol's average minute range over its recent clean bars, used
   * when it is the larger. Zero turns it off.
   */
  readonly maxExcursionRanges: number;
  /** Clean bars of the session averaged for that range. Until there are this many, only maxExcursion applies. */
  readonly rangeBars: number;
}

/** Inclusive bounds a config must sit within. */
export const BAD_TICK_BOUNDS = {
  maxExcursion: { min: ratio(100), max: ONE_HUNDRED_PERCENT },
  maxExcursionRanges: { min: 0, max: 100 },
  rangeBars: { min: 1, max: 390 },
} as const;

/**
 * The defaults: an extreme 20% past the body and the last close, or 10 average minute ranges if that is
 * further, is a bad print. Tuned on the in-sample minute bars of liquid $5 to $100 names. Outside the one
 * corrupted day it cuts 10 bars in eight years: BBBY's $123.45 prints on a $40 stock, the opening prints
 * of the 2023-01-24 NYSE auction fault (NCLH, NLY, T), and a few one-offs. At 10% it cut 154, and in a
 * third of them the next bar traded right back there: real squeezes (AMC in January 2021, SN, SHPH),
 * the very names that rank in play. At 25% it let the 2023-01-24 prints through.
 */
export const DEFAULT_BAD_TICK_CONFIG: BadTickConfig = {
  maxExcursion: ratio(2_000),
  maxExcursionRanges: 10,
  rangeBars: 30,
};

/**
 * More cuts than this in one symbol's session and none of its bars can be trusted: its good and bad
 * prints share bars, so the body is suspect as well. JWN on 2018-03-26 has dozens; no other in-sample
 * symbol-session has more than 2.
 */
export const DEFAULT_MAX_CUTS_PER_SESSION = 5;

/** How far outside the NBBO a live print may sit, in basis points of the midpoint: 5%. */
export const DEFAULT_MAX_OUTSIDE_QUOTE: Ratio = ratio(500);

export class BadTickError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadTickError";
  }
}

export function assertBadTickConfig(config: BadTickConfig): void {
  const problems: string[] = [];
  for (const [name, bounds] of Object.entries(BAD_TICK_BOUNDS)) {
    const value = config[name as keyof BadTickConfig];
    if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
      problems.push(`${name} must be a whole number within [${String(bounds.min)}, ${String(bounds.max)}]`);
    }
  }
  if (problems.length > 0) {
    throw new BadTickError(problems.join("; "));
  }
}

/** An extreme the filter cut. */
export interface ClippedExtreme {
  readonly side: "high" | "low";
  /** What the feed reported. */
  readonly reported: Fixed;
  /** What the bar carries now: the edge of its body. */
  readonly kept: Fixed;
  /** The furthest a clean extreme could have reached. */
  readonly limit: Fixed;
}

export interface FilteredBar<B extends Bar = Bar> {
  readonly bar: B;
  /** Empty when the bar was clean. */
  readonly clipped: readonly ClippedExtreme[];
}

/** The limit's distance from a level: the larger of the percentage and the range multiple. */
function allowance(level: Fixed, averageRange: Fixed | null, config: BadTickConfig): Fixed {
  const byPercent = mulRatio(level, config.maxExcursion, "floor");
  if (averageRange === null || config.maxExcursionRanges === 0) {
    return byPercent;
  }
  return max(byPercent, (averageRange * config.maxExcursionRanges) as Fixed);
}

/**
 * Judges one symbol's bars in order, one session at a time. Keeps the last clean close and the recent
 * clean ranges, so each symbol needs its own. A bar from a new session starts it afresh: an overnight
 * gap is not a move to judge.
 */
export class BadTickFilter {
  readonly #config: BadTickConfig;
  #session: string | null = null;
  #lastClose: Fixed | null = null;
  #ranges: number[] = [];
  #rangeSum = 0;

  constructor(config: BadTickConfig = DEFAULT_BAD_TICK_CONFIG) {
    assertBadTickConfig(config);
    this.#config = config;
  }

  /** The symbol's average minute range over its recent clean bars, or null until there are enough. */
  get averageRange(): Fixed | null {
    return this.#ranges.length < this.#config.rangeBars
      ? null
      : (Math.floor(this.#rangeSum / this.#ranges.length) as Fixed);
  }

  /** The last clean close this session, or null before the first bar. */
  get lastClose(): Fixed | null {
    return this.#lastClose;
  }

  /** Returns the bar to act on, with any extreme past the limit cut back to its body. */
  filter<B extends Bar>(bar: B): FilteredBar<B> {
    if (bar.session !== this.#session) {
      this.#session = bar.session;
      this.#lastClose = null;
      this.#ranges = [];
      this.#rangeSum = 0;
    }
    const top = max(bar.open, bar.close);
    const bottom = min(bar.open, bar.close);
    const averageRange = this.averageRange;
    const clipped: ClippedExtreme[] = [];

    const upper = this.#lastClose === null ? top : max(top, this.#lastClose);
    const highLimit = add(upper, allowance(upper, averageRange, this.#config));
    if (bar.high > highLimit) {
      clipped.push({ side: "high", reported: bar.high, kept: top, limit: highLimit });
    }
    const lower = this.#lastClose === null ? bottom : min(bottom, this.#lastClose);
    const lowLimit = sub(lower, allowance(lower, averageRange, this.#config));
    if (bar.low < lowLimit) {
      clipped.push({ side: "low", reported: bar.low, kept: bottom, limit: lowLimit });
    }

    const clean: B =
      clipped.length === 0
        ? bar
        : {
            ...bar,
            high: bar.high > highLimit ? top : bar.high,
            low: bar.low < lowLimit ? bottom : bar.low,
          };
    this.#lastClose = clean.close;
    this.#ranges.push(clean.high - clean.low);
    this.#rangeSum += clean.high - clean.low;
    if (this.#ranges.length > this.#config.rangeBars) {
      this.#rangeSum -= this.#ranges.shift() as number;
    }
    return { bar: clean, clipped };
  }
}

/** How many highs and lows the filter cuts across one symbol's bars, judged in order from a fresh filter. */
export function countCuts(bars: readonly Bar[], config: BadTickConfig = DEFAULT_BAD_TICK_CONFIG): number {
  const filter = new BadTickFilter(config);
  return bars.reduce((cuts, bar) => cuts + filter.filter(bar).clipped.length, 0);
}

/** What a live check judges a price against. */
export interface PriceReference {
  /** The last clean close. */
  readonly lastClose: Fixed;
  /** BadTickFilter.averageRange, or null. */
  readonly averageRange: Fixed | null;
}

/** True when a live trade is close enough to the last close, and to the NBBO when there is one, to act on. */
export function isSanePrint(
  price: Fixed,
  reference: PriceReference,
  quote: Quote | null,
  config: BadTickConfig = DEFAULT_BAD_TICK_CONFIG,
  maxOutsideQuote: Ratio = DEFAULT_MAX_OUTSIDE_QUOTE,
): boolean {
  assertBadTickConfig(config);
  const reach = allowance(reference.lastClose, reference.averageRange, config);
  if (price > add(reference.lastClose, reach) || price < sub(reference.lastClose, reach)) {
    return false;
  }
  if (quote === null) {
    return true;
  }
  const mid = midpoint(quote.bid, quote.ask, "floor");
  const margin = mulRatio(mid, maxOutsideQuote, "floor");
  return price <= add(quote.ask, margin) && price >= sub(quote.bid, margin);
}

/** True when a live quote is well formed and its midpoint close enough to the last close to act on. */
export function isSaneQuote(
  quote: Quote,
  reference: PriceReference,
  config: BadTickConfig = DEFAULT_BAD_TICK_CONFIG,
): boolean {
  assertBadTickConfig(config);
  if (
    !Number.isSafeInteger(quote.bid) ||
    !Number.isSafeInteger(quote.ask) ||
    quote.bid <= 0 ||
    quote.ask < quote.bid
  ) {
    return false;
  }
  const mid = midpoint(quote.bid, quote.ask, "floor");
  const reach = allowance(reference.lastClose, reference.averageRange, config);
  return mid <= add(reference.lastClose, reach) && mid >= sub(reference.lastClose, reach);
}
