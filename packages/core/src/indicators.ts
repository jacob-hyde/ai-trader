/**
 * Incremental indicators that only ever see closed bars.
 *
 * Every indicator takes bars one at a time through update and ignores anything it must not act on: a
 * bar still forming, a malformed bar, and a bar that is not strictly after the last one applied. The
 * last case makes a replayed bar after a reconnect harmless. Ignored bars never throw and never change
 * a value. The outcome says which case it was so the caller can log it.
 *
 * A value is null until its lookback is satisfied, and warmedUp says the same thing as a flag. Nothing
 * here can look ahead, because nothing holds a bar it has not been given.
 *
 * ATR and RSI come from trading-signals, which uses Wilder smoothing seeded by a simple mean. The first
 * bar's true range is its high minus its low. Session VWAP and relative volume are ours and run in exact
 * integer arithmetic. The same classes run in backtest, paper, and live.
 *
 * These are the one stateful corner of core. The state is private, deterministic, and fed only by
 * update. A bad constructor argument is a bug and throws IndicatorError.
 */

import { ATR, RSI } from "trading-signals";
import { type Bar, isBarAfter, isWellFormedBar } from "./bars.js";
import { type Fixed, type Ratio, fixed, ratio } from "./money.js";

/** What update did with a bar. Only "applied" changes any value. */
export type BarOutcome = "applied" | "partial" | "invalid" | "stale";

export class IndicatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndicatorError";
  }
}

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new IndicatorError(`${name} must be a whole number of at least 1, got ${String(value)}`);
  }
}

/** Owns the closed-bar, well-formed, and strictly-in-order rules so no indicator can skip them. */
abstract class ClosedBarIndicator {
  #last: Bar | null = null;

  /** True once the lookback is satisfied. Until then the value is null and must not be trusted. */
  abstract get warmedUp(): boolean;

  protected abstract apply(bar: Bar, previous: Bar | null): void;

  update(bar: Bar): BarOutcome {
    if (!bar.closed) {
      return "partial";
    }
    if (!isWellFormedBar(bar)) {
      return "invalid";
    }
    if (this.#last !== null && !isBarAfter(bar, this.#last)) {
      return "stale";
    }
    this.apply(bar, this.#last);
    this.#last = bar;
    return "applied";
  }
}

/**
 * Average true range, Wilder smoothing. Timeframe is whatever bars it is fed.
 *
 * The ORB stop uses the 14-day ATR, so that instance gets daily bars. Warm after `period` bars.
 */
export class Atr extends ClosedBarIndicator {
  readonly period: number;
  readonly #atr: ATR;

  constructor(period = 14) {
    super();
    assertCount("ATR period", period);
    this.period = period;
    this.#atr = new ATR(period);
  }

  get warmedUp(): boolean {
    return this.#atr.isStable;
  }

  /** In price units, rounded to the nearest $0.0001. */
  get value(): Fixed | null {
    const raw = this.#atr.getResult();
    return raw === null ? null : fixed(Math.round(raw));
  }

  protected apply(bar: Bar): void {
    this.#atr.add({ high: bar.high, low: bar.low, close: bar.close });
  }
}

/** Relative strength index on closes, Wilder smoothing, 0 to 100. Warm after `period` + 1 bars. */
export class Rsi extends ClosedBarIndicator {
  readonly period: number;
  readonly #rsi: RSI;

  constructor(period = 14) {
    super();
    assertCount("RSI period", period);
    this.period = period;
    this.#rsi = new RSI(period);
  }

  get warmedUp(): boolean {
    return this.#rsi.isStable;
  }

  get value(): number | null {
    return this.#rsi.getResult();
  }

  protected apply(bar: Bar): void {
    this.#rsi.add(bar.close);
  }
}

/**
 * Volume-weighted average price anchored to the session, reset on the first bar of a new one.
 *
 * Each bar contributes its own vwap when the feed supplied one, else its typical price, (high + low +
 * close) / 3. Exact in BigInt, rounded half up to $0.0001. Null until the session has traded volume.
 */
export class SessionVwap extends ClosedBarIndicator {
  // Three times the sum of price times volume, so the typical price needs no division.
  #tripledNotional = 0n;
  #volume = 0n;

  get warmedUp(): boolean {
    return this.#volume > 0n;
  }

  get value(): Fixed | null {
    if (this.#volume === 0n) {
      return null;
    }
    const denominator = 3n * this.#volume;
    return fixed(Number((2n * this.#tripledNotional + denominator) / (2n * denominator)));
  }

  protected apply(bar: Bar, previous: Bar | null): void {
    if (previous !== null && previous.session !== bar.session) {
      this.#tripledNotional = 0n;
      this.#volume = 0n;
    }
    const tripledPrice =
      bar.vwap !== null ? 3n * BigInt(bar.vwap) : BigInt(bar.high) + BigInt(bar.low) + BigInt(bar.close);
    this.#tripledNotional += tripledPrice * BigInt(bar.volume);
    this.#volume += BigInt(bar.volume);
  }
}

export interface RelativeVolumeOptions {
  /** Prior sessions averaged into the baseline. */
  readonly baselineSessions: number;
  /** Length of the opening window in minutes. The ORB uses the first five. */
  readonly openingMinutes: number;
}

export const DEFAULT_RELATIVE_VOLUME: RelativeVolumeOptions = { baselineSessions: 14, openingMinutes: 5 };

/**
 * Relative volume against the same point in prior sessions, fed one-minute bars.
 *
 * running is today's cumulative volume through the latest bar's minute over the baseline sessions' mean
 * cumulative volume through that same minute. opening is that ratio frozen at the last minute of the
 * opening window. It stays null until the window has provably closed, which is the first bar at or past
 * its last minute, so a gap in the feed cannot make it report a partial window.
 *
 * Both floor to whole basis points, so a gate of "above 100%" is never passed by rounding. Both are null
 * until the baseline holds `baselineSessions` full curves, and when the baseline traded nothing by that
 * minute. A session shorter than the minute asked for counts at its full-day total.
 */
export class RelativeVolume extends ClosedBarIndicator {
  readonly options: RelativeVolumeOptions;
  // Cumulative volume by minute, one dense curve per finished session, oldest first.
  #baseline: number[][] = [];
  #today: number[] = [];
  #running: Ratio | null = null;
  #opening: Ratio | null = null;
  #openingIsFinal = false;

  constructor(options: RelativeVolumeOptions = DEFAULT_RELATIVE_VOLUME) {
    super();
    assertCount("baselineSessions", options.baselineSessions);
    assertCount("openingMinutes", options.openingMinutes);
    this.options = options;
  }

  get warmedUp(): boolean {
    return this.#baseline.length >= this.options.baselineSessions;
  }

  get running(): Ratio | null {
    return this.#running;
  }

  get opening(): Ratio | null {
    return this.#opening;
  }

  protected apply(bar: Bar, previous: Bar | null): void {
    if (previous !== null && previous.session !== bar.session) {
      this.#baseline = [...this.#baseline, this.#today].slice(-this.options.baselineSessions);
      this.#today = [];
      this.#opening = null;
      this.#openingIsFinal = false;
    }
    // Minutes with no bar carry the running total forward, so the curve is dense up to this minute.
    const soFar = this.#today.at(-1) ?? 0;
    while (this.#today.length < bar.minuteOfSession) {
      this.#today.push(soFar);
    }
    this.#today.push(soFar + bar.volume);

    this.#running = this.#ratioAt(bar.minuteOfSession);
    const lastOpeningMinute = this.options.openingMinutes - 1;
    if (!this.#openingIsFinal && bar.minuteOfSession >= lastOpeningMinute) {
      this.#opening = this.#ratioAt(lastOpeningMinute);
      this.#openingIsFinal = true;
    }
  }

  #ratioAt(minute: number): Ratio | null {
    if (!this.warmedUp) {
      return null;
    }
    // Every stored curve has at least one entry, so the clamped index always exists.
    const through = (curve: readonly number[]): bigint =>
      BigInt(curve[Math.min(minute, curve.length - 1)] as number);
    const baselineTotal = this.#baseline.reduce((sum, curve) => sum + through(curve), 0n);
    if (baselineTotal === 0n) {
      return null;
    }
    const basisPoints = (through(this.#today) * BigInt(this.#baseline.length) * 10_000n) / baselineTotal;
    const value = Number(basisPoints);
    return Number.isSafeInteger(value) ? ratio(value) : null;
  }
}
