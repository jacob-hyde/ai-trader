/**
 * The bar store (H.7) as the study universe's source. Read only: three queries, each one short.
 *
 * Opening volumes are summed a month at a time by ts range, which is what lets Timescale touch only that
 * month's chunks: one month of every symbol's opening minutes reads in well under a second. Daily bars
 * come the same way, by session range.
 */

import type { StoredBar } from "@trader/adapters";
import { fixed } from "@trader/contracts";
import type pg from "pg";
import type { OpeningVolume, StudySource } from "./universe.js";

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
