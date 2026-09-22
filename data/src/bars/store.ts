/**
 * The bar store's reads and writes. Connects as the engine role: rows only, never the schema.
 *
 * A load job writes its bars and its checkpoints in one transaction, so a month is either all there
 * with its checkpoint or not there at all. A crash, a Ctrl-C, or a failed request leaves nothing half
 * written, and the next run fetches exactly the months without a complete checkpoint.
 */

import type { AlpacaAsset } from "@trader/adapters/alpaca";
import type pg from "pg";
import type { BarRow, DailyRow, MinuteRow } from "./convert.js";
import type { Timeframe } from "./source.js";
import type { SessionTimes } from "./time.js";

/** One symbol-month a job finished. */
export interface Checkpoint {
  readonly symbol: string;
  readonly month: string;
  readonly status: "complete" | "partial";
  readonly rows: number;
  readonly sessions: number;
}

export interface SymbolSource {
  readonly symbol: string;
  readonly source: string;
}

/** Rows per INSERT. Keeps each statement's arrays a manageable size. */
const INSERT_BATCH = 20_000;

function column<T, V>(rows: readonly T[], pick: (row: T) => V): V[] {
  return rows.map(pick);
}

export class BarStore {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async saveSessions(sessions: readonly SessionTimes[]): Promise<void> {
    if (sessions.length === 0) {
      return;
    }
    await this.#pool.query(
      `INSERT INTO market_sessions (session, open_at, close_at)
       SELECT * FROM unnest($1::date[], $2::timestamptz[], $3::timestamptz[])
       ON CONFLICT (session) DO UPDATE SET open_at = EXCLUDED.open_at, close_at = EXCLUDED.close_at`,
      [
        column(sessions, (s) => s.session),
        column(sessions, (s) => new Date(s.openAt).toISOString()),
        column(sessions, (s) => new Date(s.closeAt).toISOString()),
      ],
    );
  }

  /** Sessions in a date range, inclusive, keyed by date. */
  async sessions(from: string, to: string): Promise<Map<string, SessionTimes>> {
    const result = await this.#pool.query<{ session: string; open_at: Date; close_at: Date }>(
      `SELECT to_char(session, 'YYYY-MM-DD') AS session, open_at, close_at
       FROM market_sessions WHERE session BETWEEN $1 AND $2 ORDER BY session`,
      [from, to],
    );
    return new Map(
      result.rows.map((row) => [
        row.session,
        { session: row.session, openAt: row.open_at.getTime(), closeAt: row.close_at.getTime() },
      ]),
    );
  }

  async saveAssetSnapshot(takenAt: Date, assets: readonly AlpacaAsset[]): Promise<void> {
    for (let i = 0; i < assets.length; i += INSERT_BATCH) {
      const batch = assets.slice(i, i + INSERT_BATCH);
      await this.#pool.query(
        `INSERT INTO asset_snapshots
           (taken_at, asset_id, symbol, name, exchange, asset_class, status, tradable, shortable, easy_to_borrow)
         SELECT $1, * FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
           $8::boolean[], $9::boolean[], $10::boolean[])
         ON CONFLICT DO NOTHING`,
        [
          takenAt.toISOString(),
          column(batch, (a) => a.id),
          column(batch, (a) => a.symbol),
          column(batch, (a) => a.name),
          column(batch, (a) => a.exchange),
          column(batch, (a) => a.class),
          column(batch, (a) => a.status),
          column(batch, (a) => a.tradable),
          column(batch, (a) => a.shortable),
          column(batch, (a) => a.easy_to_borrow),
        ],
      );
    }
  }

  /** Adds symbols, merging sources for ones already known. Returns how many were new. */
  async addSymbols(entries: readonly SymbolSource[]): Promise<number> {
    const bySymbol = new Map<string, Set<string>>();
    for (const { symbol, source } of entries) {
      (bySymbol.get(symbol) ?? bySymbol.set(symbol, new Set()).get(symbol))?.add(source);
    }
    const symbols = [...bySymbol.keys()];
    const before = await this.#pool.query<{ n: number }>("SELECT count(*)::int AS n FROM symbols");
    await this.#pool.query(
      `INSERT INTO symbols (symbol, sources)
       SELECT symbol, string_to_array(sources, ',') FROM unnest($1::text[], $2::text[]) AS t(symbol, sources)
       ON CONFLICT (symbol) DO UPDATE SET sources = (
         SELECT array_agg(DISTINCT s ORDER BY s) FROM unnest(symbols.sources || EXCLUDED.sources) AS s
       )`,
      [symbols, symbols.map((symbol) => [...(bySymbol.get(symbol) ?? [])].sort().join(","))],
    );
    const after = await this.#pool.query<{ n: number }>("SELECT count(*)::int AS n FROM symbols");
    return (after.rows[0]?.n ?? 0) - (before.rows[0]?.n ?? 0);
  }

  async allSymbols(): Promise<string[]> {
    const result = await this.#pool.query<{ symbol: string }>("SELECT symbol FROM symbols ORDER BY symbol");
    return result.rows.map((row) => row.symbol);
  }

  /** Symbol-months with a complete checkpoint, as "SYMBOL|YYYY-MM-01", optionally for some symbols only. */
  async completed(
    timeframe: Timeframe,
    fromMonth: string,
    toMonth: string,
    symbols: readonly string[] | null = null,
  ): Promise<Set<string>> {
    const result = await this.#pool.query<{ key: string }>(
      `SELECT symbol || '|' || to_char(month, 'YYYY-MM-DD') AS key FROM bar_load_checkpoints
       WHERE timeframe = $1 AND status = 'complete' AND month BETWEEN $2 AND $3
         AND ($4::text[] IS NULL OR symbol = ANY($4))`,
      [timeframe, fromMonth, toMonth, symbols],
    );
    return new Set(result.rows.map((row) => row.key));
  }

  /** Writes a job's bars and checkpoints in one transaction. */
  async writeJob(
    timeframe: Timeframe,
    rows: readonly (DailyRow | MinuteRow)[],
    checkpoints: readonly Checkpoint[],
  ): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const batch = rows.slice(i, i + INSERT_BATCH);
        if (timeframe === "1Day") {
          const days = batch as readonly DailyRow[];
          await client.query(
            `INSERT INTO bars_1d (symbol, session, open, high, low, close, volume, trades, vwap, split_factor)
             SELECT * FROM unnest($1::text[], $2::date[], $3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[],
               $7::bigint[], $8::integer[], $9::bigint[], $10::double precision[])
             ON CONFLICT (symbol, session) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high,
               low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume, trades = EXCLUDED.trades,
               vwap = EXCLUDED.vwap, split_factor = EXCLUDED.split_factor`,
            [...barColumns(days), column(days, (r) => r.splitFactor)],
          );
        } else {
          const minutes = batch as readonly MinuteRow[];
          await client.query(
            `INSERT INTO bars_1m (symbol, ts, session, minute, open, high, low, close, volume, trades, vwap)
             SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::date[], $4::smallint[], $5::bigint[],
               $6::bigint[], $7::bigint[], $8::bigint[], $9::bigint[], $10::integer[], $11::bigint[])
             ON CONFLICT (symbol, ts) DO UPDATE SET session = EXCLUDED.session, minute = EXCLUDED.minute,
               open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
               volume = EXCLUDED.volume, trades = EXCLUDED.trades, vwap = EXCLUDED.vwap`,
            [
              column(minutes, (r) => r.symbol),
              column(minutes, (r) => r.ts),
              column(minutes, (r) => r.session),
              column(minutes, (r) => r.minute),
              ...barColumns(minutes).slice(2),
            ],
          );
        }
      }
      if (checkpoints.length > 0) {
        await client.query(
          `INSERT INTO bar_load_checkpoints (timeframe, symbol, month, status, rows, sessions)
           SELECT $1, * FROM unnest($2::text[], $3::date[], $4::text[], $5::integer[], $6::integer[])
           ON CONFLICT (timeframe, symbol, month) DO UPDATE SET status = EXCLUDED.status, rows = EXCLUDED.rows,
             sessions = EXCLUDED.sessions, loaded_at = now()`,
          [
            timeframe,
            column(checkpoints, (c) => c.symbol),
            column(checkpoints, (c) => c.month),
            column(checkpoints, (c) => c.status),
            column(checkpoints, (c) => c.rows),
            column(checkpoints, (c) => c.sessions),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Sets each symbol's first and last session from its daily bars: listing and delisting as observed. */
  async refreshSymbolRanges(): Promise<void> {
    await this.#pool.query(
      `UPDATE symbols SET first_session = r.first, last_session = r.last
       FROM (SELECT symbol, min(session) AS first, max(session) AS last FROM bars_1d GROUP BY symbol) r
       WHERE symbols.symbol = r.symbol`,
    );
  }

  /** One symbol's daily bars, oldest first. */
  async dailyBars(symbol: string, from: string, to: string): Promise<DailyRow[]> {
    const result = await this.#pool.query<Record<string, string | number | null>>(
      `SELECT symbol, to_char(session, 'YYYY-MM-DD') AS session, open, high, low, close, volume, trades, vwap,
         split_factor
       FROM bars_1d WHERE symbol = $1 AND session BETWEEN $2 AND $3 ORDER BY session`,
      [symbol, from, to],
    );
    return result.rows.map((row) => ({
      symbol: String(row["symbol"]),
      session: String(row["session"]),
      open: Number(row["open"]),
      high: Number(row["high"]),
      low: Number(row["low"]),
      close: Number(row["close"]),
      volume: Number(row["volume"]),
      trades: row["trades"] === null ? null : Number(row["trades"]),
      vwap: row["vwap"] === null ? null : Number(row["vwap"]),
      splitFactor: row["split_factor"] === null ? null : Number(row["split_factor"]),
    }));
  }

  /** Symbols with at least one daily bar in the range. */
  async symbolsWithDailyBars(from: string, to: string): Promise<string[]> {
    const result = await this.#pool.query<{ symbol: string }>(
      `SELECT symbol FROM symbols
       WHERE first_session IS NOT NULL AND first_session <= $2 AND last_session >= $1 ORDER BY symbol`,
      [from, to],
    );
    return result.rows.map((row) => row.symbol);
  }
}

function barColumns(rows: readonly BarRow[]): unknown[] {
  return [
    column(rows, (r) => r.symbol),
    column(rows, (r) => r.session),
    column(rows, (r) => r.open),
    column(rows, (r) => r.high),
    column(rows, (r) => r.low),
    column(rows, (r) => r.close),
    column(rows, (r) => r.volume),
    column(rows, (r) => r.trades),
    column(rows, (r) => r.vwap),
  ];
}
