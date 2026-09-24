/**
 * The bar store (H.7) as the study universe's source. Read only: three queries, each one short.
 *
 * Opening volumes are summed a month at a time by ts range, which is what lets Timescale touch only that
 * month's chunks: one month of every symbol's opening minutes reads in well under a second. Daily bars
 * come the same way, by session range.
 */

import type { StoredBar } from "@trader/adapters";
import type { Bar } from "@trader/contracts";
import { fixed } from "@trader/contracts";
import type pg from "pg";
import type { OpeningVolume, StudySource, WideWickSession } from "./universe.js";

/** The first instant of a month and of the next, in UTC. No session straddles midnight UTC. */
function monthRange(month: string): [string, string] {
  const [year, monthOfYear] = month.split("-").map(Number) as [number, number];
  const start = new Date(Date.UTC(year, monthOfYear - 1, 1));
  const end = new Date(Date.UTC(year, monthOfYear, 1));
  return [start.toISOString(), end.toISOString()];
}

export class TimescaleStudySource implements StudySource {
  readonly #pool: pg.Pool;

  /** Takes the engine role's pool: this only ever reads. */
  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async dailyBars(month: string): Promise<readonly StoredBar[]> {
    const [from, to] = monthRange(month);
    const result = await this.#pool.query<{
      symbol: string;
      session: string;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
      vwap: string | null;
      split_factor: number | null;
    }>(
      `SELECT symbol, to_char(session, 'YYYY-MM-DD') AS session, open, high, low, close, volume, vwap,
         split_factor
       FROM bars_1d WHERE session >= $1::date AND session < $2::date
       ORDER BY session, symbol`,
      [from.slice(0, 10), to.slice(0, 10)],
    );
    return result.rows.map((row) => ({
      symbol: row.symbol,
      session: row.session,
      minuteOfSession: 0,
      open: fixed(Number(row.open)),
      high: fixed(Number(row.high)),
      low: fixed(Number(row.low)),
      close: fixed(Number(row.close)),
      volume: Number(row.volume),
      vwap: row.vwap === null ? null : fixed(Number(row.vwap)),
      closed: true,
      splitFactor: row.split_factor,
    }));
  }

  async openingVolumes(month: string, minutes: number): Promise<readonly OpeningVolume[]> {
    const [from, to] = monthRange(month);
    const result = await this.#pool.query<{ symbol: string; session: string; volume: string }>(
      `SELECT symbol, to_char(session, 'YYYY-MM-DD') AS session, sum(volume) AS volume
       FROM bars_1m WHERE ts >= $1 AND ts < $2 AND minute < $3
       GROUP BY symbol, session`,
      [from, to, minutes],
    );
    return result.rows.map((row) => ({
      symbol: row.symbol,
      session: row.session,
      volume: Number(row.volume),
    }));
  }

  /**
   * From the wide-wick scan (pnpm bars suspects). Throws when the month holds minute bars loaded after
   * its last scan, or never scanned: a candidate missing from the table would let a corrupted day trade.
   */
  async wideWickSessions(month: string): Promise<readonly WideWickSession[]> {
    const [from, to] = monthRange(month);
    const scan = await this.#pool.query<{ scanned_at: Date | null; loaded_at: Date | null }>(
      `SELECT (SELECT scanned_at FROM bad_tick_scans WHERE month = $1::date) AS scanned_at,
         (SELECT max(loaded_at) FROM bar_load_checkpoints WHERE timeframe = '1Min' AND month = $1::date)
           AS loaded_at`,
      [from.slice(0, 10)],
    );
    const { scanned_at: scannedAt, loaded_at: loadedAt } = scan.rows[0] ?? {
      scanned_at: null,
      loaded_at: null,
    };
    if (loadedAt !== null && (scannedAt === null || loadedAt > scannedAt)) {
      throw new Error(
        `minute bars for ${month} were loaded after their bad-tick scan: run pnpm bars suspects`,
      );
    }
    const result = await this.#pool.query<{ symbol: string; session: string; wide_bars: number }>(
      `SELECT symbol, to_char(session, 'YYYY-MM-DD') AS session, wide_bars FROM bad_tick_candidates
       WHERE session >= $1::date AND session < $2::date ORDER BY session, symbol`,
      [from.slice(0, 10), to.slice(0, 10)],
    );
    return result.rows.map((row) => ({ symbol: row.symbol, session: row.session, wideBars: row.wide_bars }));
  }

  async sessionMinuteBars(symbol: string, session: string): Promise<readonly Bar[]> {
    const result = await this.#pool.query<{
      minute: number;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
      vwap: string | null;
    }>(
      `SELECT minute, open, high, low, close, volume, vwap FROM bars_1m
       WHERE symbol = $1 AND session = $2 AND ts >= $2::date AND ts < $2::date + 1
       ORDER BY minute`,
      [symbol, session],
    );
    return result.rows.map((row) => ({
      session,
      minuteOfSession: row.minute,
      open: fixed(Number(row.open)),
      high: fixed(Number(row.high)),
      low: fixed(Number(row.low)),
      close: fixed(Number(row.close)),
      volume: Number(row.volume),
      vwap: row.vwap === null ? null : fixed(Number(row.vwap)),
      closed: true,
    }));
  }

  async minuteMonths(): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    const result = await this.#pool.query<{ symbol: string; month: string }>(
      `SELECT symbol, to_char(month, 'YYYY-MM') AS month FROM bar_load_checkpoints
       WHERE timeframe = '1Min' AND status = 'complete'`,
    );
    const months = new Map<string, Set<string>>();
    for (const { symbol, month } of result.rows) {
      (months.get(symbol) ?? months.set(symbol, new Set()).get(symbol))?.add(month);
    }
    return months;
  }
}
