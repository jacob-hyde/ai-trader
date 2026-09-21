/**
 * The OHLCV bar the decision core consumes.
 *
 * Time is carried as data, never read from a clock. A bar names its trading session and its minute
 * within that session, both assigned upstream where the exchange calendar and the time zone live. Core
 * stays free of time zone logic, and "the first five minutes" is just minutes 0 to 4.
 */

import type { Fixed } from "./money.js";

export interface Bar {
  /** Trading date in ISO form, e.g. "2026-09-21". Sorts as a string. */
  readonly session: string;
  /** Minutes from the regular-session open to the bar's start. The 09:30 ET bar is 0. A daily bar is 0. */
  readonly minuteOfSession: number;
  readonly open: Fixed;
  readonly high: Fixed;
  readonly low: Fixed;
  readonly close: Fixed;
  /** Whole shares. */
  readonly volume: number;
  /** The bar's own volume-weighted price when the feed supplies one (Alpaca's vw), else null. */
  readonly vwap: Fixed | null;
  /** False while the bar is still forming. Nothing in core acts on a bar that is not closed. */
  readonly closed: boolean;
}

const MINUTES_PER_DAY = 1_440;

function isPositiveUnits(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Checks that a bar is internally consistent.
 *
 * Prices are positive whole units with low at or below open and close, and high at or above them.
 * Volume and minute are non-negative whole numbers, and the minute fits in a day. A supplied vwap only
 * has to be positive: feeds compute it over a wider set of trade conditions than high and low, so it can
 * sit outside them.
 */
export function isWellFormedBar(bar: Bar): boolean {
  const prices = [bar.open, bar.high, bar.low, bar.close];
  return (
    bar.session.length > 0 &&
    Number.isSafeInteger(bar.minuteOfSession) &&
    bar.minuteOfSession >= 0 &&
    bar.minuteOfSession < MINUTES_PER_DAY &&
    prices.every(isPositiveUnits) &&
    bar.low <= Math.min(bar.open, bar.close) &&
    bar.high >= Math.max(bar.open, bar.close) &&
    Number.isSafeInteger(bar.volume) &&
    bar.volume >= 0 &&
    (bar.vwap === null || isPositiveUnits(bar.vwap))
  );
}

/** True when a bar starts strictly after another: a later session, or a later minute of the same one. */
export function isBarAfter(bar: Bar, previous: Bar): boolean {
  if (bar.session !== previous.session) {
    return bar.session > previous.session;
  }
  return bar.minuteOfSession > previous.minuteOfSession;
}
