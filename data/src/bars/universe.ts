/**
 * Which symbol-months get minute bars.
 *
 * Minute bars for every listed ticker since 2016 would be billions of rows. The strategy only ever
 * trades names that pass its liquidity screen (Stage 3: price, average volume, daily ATR), so minute
 * bars are loaded for the months in which a symbol passes that screen on at least one session. The
 * RVOL ranking inside that set needs minute data and happens in the backtest, not here.
 *
 * The screen for a session uses only bars before it: the prior close, the prior 14 sessions' average
 * volume, and ATR(14) as of the prior close, the same ATR class the strategy uses. So the selection has
 * no look-ahead, and a name that later collapsed or was delisted is selected on the days it qualified.
 *
 * The month before each selected month is loaded as well, so the opening-volume average behind RVOL,
 * 14 sessions back, always has minute bars.
 */

import { type Bar, SCALE, fixed } from "@trader/contracts";
import { Atr } from "@trader/core";
import type { DailyRow } from "./convert.js";
import { monthOf, previousMonth } from "./time.js";

export interface UniverseScreen {
  /** Prior close, dollars, inclusive. */
  readonly minPrice: number;
  readonly maxPrice: number;
  /** Average daily volume over the lookback, shares, strictly above. */
  readonly minAverageVolume: number;
  /** Daily ATR over the lookback, dollars, strictly above, as in the ORB gate. */
  readonly minAtr: number;
  /** Sessions of history behind every number above. */
  readonly lookback: number;
}

/** The published screen (Zarattini, Barbon, Aziz): $5 to $100, over 1M shares a day, ATR(14) over $0.50. */
export const PUBLISHED_SCREEN: UniverseScreen = {
  minPrice: 5,
  maxPrice: 100,
  minAverageVolume: 1_000_000,
  minAtr: 0.5,
  lookback: 14,
};

/** A daily bar on today's share basis (split-adjusted), for an indicator that runs across splits. */
function adjusted(row: DailyRow): Bar {
  const factor = row.splitFactor ?? 1;
  const price = (units: number) => fixed(Math.round(units / factor));
  return {
    session: row.session,
    minuteOfSession: 0,
    open: price(row.open),
    high: price(row.high),
    low: price(row.low),
    close: price(row.close),
    volume: Math.round(row.volume * factor),
    vwap: null,
    closed: true,
  };
}

/**
 * Sessions on which the symbol passes the screen, judged on the bars before each. Bars oldest first.
 *
 * Every number is stated as of the session being judged, the way a scanner showed it that morning: the
 * ATR and average volume run on split-adjusted bars and are then put back on that session's share basis,
 * so a split inside the lookback neither inflates the ATR nor shrinks the volume, and a split after the
 * session changes nothing. Bars without a split factor are taken as unsplit.
 */
export function eligibleSessions(bars: readonly DailyRow[], screen: UniverseScreen): string[] {
  const atr = new Atr(screen.lookback);
  const eligible: string[] = [];
  const minPrice = screen.minPrice * SCALE;
  const maxPrice = screen.maxPrice * SCALE;
  const minAtr = screen.minAtr * SCALE;
  /** Split-adjusted volume over the lookback. */
  let volumeSum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i] as DailyRow;
    const prior = bars[i - 1];
    const factor = bar.splitFactor ?? 1;
    if (i >= screen.lookback && prior !== undefined) {
      const priorClose = (prior.close * factor) / (prior.splitFactor ?? 1);
      const averageVolume = volumeSum / screen.lookback / factor;
      const range = atr.value === null ? null : atr.value * factor;
      if (
        priorClose >= minPrice &&
        priorClose <= maxPrice &&
        averageVolume > screen.minAverageVolume &&
        range !== null &&
        range > minAtr
      ) {
        eligible.push(bar.session);
      }
    }
    const today = adjusted(bar);
    atr.update(today);
    volumeSum += today.volume;
    const leaving = bars[i - screen.lookback];
    if (leaving !== undefined) {
      volumeSum -= adjusted(leaving).volume;
    }
  }
  return eligible;
}

/** Months to load minute bars for: each month with an eligible session, and the month before it. */
export function monthsToLoad(eligible: readonly string[]): string[] {
  const months = new Set<string>();
  for (const session of eligible) {
    const month = monthOf(session);
    months.add(month);
    months.add(previousMonth(month));
  }
  return [...months].sort();
}
