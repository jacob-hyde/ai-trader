/**
 * The bar store (H.7) as a backtest's replay source. Read only, and every read is one short query.
 *
 * Minute bars are read by the ts range of their session as well as by session, because the hypertable
 * is chunked on ts: the range is what lets Timescale skip every chunk but one. Daily bars get the same
 * treatment on session, with a day of slack each side since a UTC date and a New York date can differ.
 *
 * A symbol counts as loaded for a month only with a complete checkpoint. A month still in progress or
 * never fetched is not loaded, so a backtest that reaches it stops instead of replaying silence.
 */

import type { ReplaySource, SessionHours, StoredBar } from "@trader/adapters";
import type { IsoTimestamp, SessionDate, SymbolBar } from "@trader/contracts";
import { fixed } from "@trader/contracts";
import type pg from "pg";

/** A bigint column comes back from pg as a string. */
type Units = string;

interface BarColumns {
  readonly symbol: string;
  readonly session: string;
  readonly minute: number;
  readonly open: Units;
  readonly high: Units;
  readonly low: Units;
  readonly close: Units;
  readonly volume: Units;
  readonly vwap: Units | null;
}

function toBar(row: BarColumns): SymbolBar {
  return {
    symbol: row.symbol,
    session: row.session,
    minuteOfSession: row.minute,
    open: fixed(Number(row.open)),
    high: fixed(Number(row.high)),
    low: fixed(Number(row.low)),
    close: fixed(Number(row.close)),
    volume: Number(row.volume),
    vwap: row.vwap === null ? null : fixed(Number(row.vwap)),
    closed: true,
  };
}

/** How far back a missing split factor is looked for. A symbol a year without one is taken as unsplit. */
const FACTOR_LOOKBACK_DAYS = 400;

export class TimescaleReplaySource implements ReplaySource {
  readonly #pool: pg.Pool;

  /** Takes the engine role's pool: this only ever reads. */
  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async sessions(from: SessionDate, to: SessionDate): Promise<readonly SessionHours[]> {
    const result = await this.#pool.query<{ session: string; open_at: Date; close_at: Date }>(
      `SELECT to_char(session, 'YYYY-MM-DD') AS session, open_at, close_at
       FROM market_sessions WHERE session BETWEEN $1 AND $2 ORDER BY session`,
      [from, to],
    );
    return result.rows.map((row) => ({
      session: row.session,
      openAt: row.open_at.getTime(),
      closeAt: row.close_at.getTime(),
    }));
  }

  async loaded(session: SessionDate, symbols: readonly string[]): Promise<ReadonlySet<string>> {
    const result = await this.#pool.query<{ symbol: string }>(
      `SELECT symbol FROM bar_load_checkpoints
       WHERE timeframe = '1Min' AND status = 'complete'
         AND month = date_trunc('month', $1::date)::date AND symbol = ANY($2)`,
      [session, symbols],
    );
    return new Set(result.rows.map((row) => row.symbol));
  }

  async sessionBars(hours: SessionHours, symbols: readonly string[]): Promise<readonly SymbolBar[]> {
    const result = await this.#pool.query<BarColumns>(
      `SELECT symbol, to_char(session, 'YYYY-MM-DD') AS session, minute, open, high, low, close, volume, vwap
       FROM bars_1m
       WHERE symbol = ANY($1) AND ts >= $2 AND ts < $3 AND session = $4`,
      [symbols, new Date(hours.openAt).toISOString(), new Date(hours.closeAt).toISOString(), hours.session],
    );
    return result.rows.map(toBar);
  }

  async dailyBars(symbol: string, from: IsoTimestamp, to: IsoTimestamp): Promise<readonly StoredBar[]> {
    const result = await this.#pool.query<BarColumns & { split_factor: number | null }>(
      `SELECT d.symbol, to_char(d.session, 'YYYY-MM-DD') AS session, 0 AS minute, d.open, d.high, d.low,
         d.close, d.volume, d.vwap, d.split_factor
       FROM bars_1d d JOIN market_sessions s ON s.session = d.session
       WHERE d.symbol = $1 AND s.open_at >= $2 AND s.open_at < $3
         AND d.session BETWEEN $2::timestamptz::date - 1 AND $3::timestamptz::date + 1
       ORDER BY d.session`,
      [symbol, from, to],
    );
    return result.rows.map((row) => ({ ...toBar(row), splitFactor: row.split_factor }));
  }

  async minuteBars(symbol: string, from: IsoTimestamp, to: IsoTimestamp): Promise<readonly StoredBar[]> {
    const result = await this.#pool.query<BarColumns & { split_factor: number | null }>(
      `SELECT m.symbol, to_char(m.session, 'YYYY-MM-DD') AS session, m.minute, m.open, m.high, m.low,
         m.close, m.volume, m.vwap, d.split_factor
       FROM bars_1m m
       LEFT JOIN bars_1d d ON d.symbol = m.symbol AND d.session = m.session
         AND d.session BETWEEN $2::timestamptz::date - 1 AND $3::timestamptz::date + 1
       WHERE m.symbol = $1 AND m.ts >= $2 AND m.ts < $3
       ORDER BY m.ts`,
      [symbol, from, to],
    );
    return result.rows.map((row) => ({ ...toBar(row), splitFactor: row.split_factor }));
  }

  async splitFactor(symbol: string, session: SessionDate): Promise<number | null> {
    const result = await this.#pool.query<{ split_factor: number }>(
      `SELECT split_factor FROM bars_1d
       WHERE symbol = $1 AND session <= $2 AND session > $2::date - $3::int AND split_factor IS NOT NULL
       ORDER BY session DESC LIMIT 1`,
      [symbol, session, FACTOR_LOOKBACK_DAYS],
    );
    return result.rows[0]?.split_factor ?? null;
  }
}
