/**
 * Alpaca bars into rows of the bar store.
 *
 * Prices become integer units of $0.0001 (Fixed). Alpaca sends them as JSON numbers with at most four
 * places, so rounding x * 10,000 recovers the exact units; a VWAP with six places rounds to the nearest.
 *
 * A minute bar keeps its place only inside a regular session: from the open, inclusive, to the close,
 * exclusive. Pre-market and after-hours bars are dropped, and so is anything on a date the calendar
 * does not list. A bar whose prices contradict each other (a high under the close) is dropped too and
 * counted, never repaired: the verify report shows the hole.
 */

import type { AlpacaBar } from "@trader/adapters/alpaca";
import { SCALE } from "@trader/contracts";
import { type SessionTimes, newYorkDate } from "./time.js";

/** What every bar row holds. Prices as traded, in units of $0.0001. */
export interface BarRow {
  readonly symbol: string;
  readonly session: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly trades: number | null;
  readonly vwap: number | null;
}

export interface DailyRow extends BarRow {
  /** Shares today per share on this date, from the split-adjusted volume. Null without volume. */
  readonly splitFactor: number | null;
}

export interface MinuteRow extends BarRow {
  /** The bar's start, ISO 8601 in UTC. */
  readonly ts: string;
  /** Minutes from the session's open. 09:30 ET is 0. */
  readonly minute: number;
}

export type Dropped = "outsideSession" | "invalid";

/** A price in units of $0.0001, or null when it is not a positive finite number. */
export function units(price: number): number | null {
  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }
  const value = Math.round(price * SCALE);
  return value > 0 && Number.isSafeInteger(value) ? value : null;
}

function prices(symbol: string, session: string, bar: AlpacaBar): BarRow | null {
  const open = units(bar.o);
  const high = units(bar.h);
  const low = units(bar.l);
  const close = units(bar.c);
  if (open === null || high === null || low === null || close === null) {
    return null;
  }
  if (low > Math.min(open, close) || high < Math.max(open, close) || !(bar.v >= 0)) {
    return null;
  }
  return {
    symbol,
    session,
    open,
    high,
    low,
    close,
    volume: Math.round(bar.v),
    trades: bar.n === null ? null : Math.round(bar.n),
    vwap: bar.vw === null ? null : units(bar.vw),
  };
}

/**
 * A daily bar, stamped at New York midnight by Alpaca, as a row for its session.
 *
 * The split factor is the split-adjusted volume over the raw volume. Volume is a large integer, so the
 * ratio is exact to many places, where the adjusted price is rounded to the cent by Alpaca.
 */
export function toDailyRow(
  symbol: string,
  bar: AlpacaBar,
  splitAdjustedVolume: number | undefined,
  sessions: ReadonlyMap<string, SessionTimes>,
): DailyRow | Dropped {
  const session = newYorkDate(new Date(bar.t));
  if (!sessions.has(session)) {
    return "outsideSession";
  }
  const row = prices(symbol, session, bar);
  if (row === null) {
    return "invalid";
  }
  const splitFactor =
    splitAdjustedVolume !== undefined && splitAdjustedVolume > 0 && bar.v > 0
      ? splitAdjustedVolume / bar.v
      : null;
  return { ...row, splitFactor };
}

/** A minute bar as a row, placed in its session by the calendar. */
export function toMinuteRow(
  symbol: string,
  bar: AlpacaBar,
  sessions: ReadonlyMap<string, SessionTimes>,
): MinuteRow | Dropped {
  const at = Date.parse(bar.t);
  const times = sessions.get(newYorkDate(new Date(at)));
  if (times === undefined || at < times.openAt || at >= times.closeAt) {
    return "outsideSession";
  }
  const minute = (at - times.openAt) / 60_000;
  const row = Number.isInteger(minute) ? prices(symbol, times.session, bar) : null;
  return row === null ? "invalid" : { ...row, ts: new Date(at).toISOString(), minute };
}
