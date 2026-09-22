/**
 * Compression and a health readout for the bar store.
 *
 * The compression policy on both hypertables compresses chunks once they are 30 days old, but its job
 * runs every 12 hours, so a bulk load sits uncompressed until then. compressNow does the same work at
 * once. It needs the table owner, so it takes the owner's pool; the engine role cannot compress.
 */

import type pg from "pg";

export interface CompressionStats {
  readonly table: string;
  readonly chunks: number;
  readonly compressedChunks: number;
  readonly beforeBytes: number | null;
  readonly afterBytes: number | null;
  readonly totalBytes: number;
}

const TABLES = ["bars_1d", "bars_1m"] as const;

export interface CompressWindow {
  /** Only these hypertables. Default both. */
  readonly tables?: ReadonlyArray<(typeof TABLES)[number]>;
  /** Only chunks that start at or after this. */
  readonly from?: string;
  /** Only chunks that end at or before this. Default: older than the policy's 30 days. */
  readonly before?: string;
}

/**
 * Compresses every chunk the policy would, now, and returns how many. Owner only. A window narrows it,
 * e.g. to the months a load has finished, or away from chunks a running load is still writing.
 */
export async function compressNow(owner: pg.Pool, window: CompressWindow = {}): Promise<number> {
  let compressed = 0;
  for (const table of window.tables ?? TABLES) {
    const type = table === "bars_1d" ? "date" : "timestamptz";
    const params: unknown[] = [table];
    const bind = (value: string): string => {
      params.push(value);
      return `$${String(params.length)}::${type}`;
    };
    const olderThan = window.before === undefined ? "interval '30 days'" : bind(window.before);
    const newerThan = window.from === undefined ? "" : `, newer_than => ${bind(window.from)}`;
    // Only chunks not yet compressed, so the count is what this call did.
    const result = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT compress_chunk(c)
         FROM show_chunks($1::regclass, older_than => ${olderThan}${newerThan}) c
         JOIN timescaledb_information.chunks i ON format('%I.%I', i.chunk_schema, i.chunk_name)::regclass = c
         WHERE NOT i.is_compressed
       ) done`,
      params,
    );
    compressed += result.rows[0]?.n ?? 0;
  }
  return compressed;
}

export async function compressionStats(pool: pg.Pool): Promise<CompressionStats[]> {
  const stats: CompressionStats[] = [];
  for (const table of TABLES) {
    const result = await pool.query<{
      chunks: string | null;
      compressed: string | null;
      before: string | null;
      after: string | null;
      total: string;
    }>(
      `SELECT s.total_chunks AS chunks, s.number_compressed_chunks AS compressed,
         s.before_compression_total_bytes AS before, s.after_compression_total_bytes AS after,
         hypertable_size($1::regclass) AS total
       FROM hypertable_compression_stats($1::regclass) s`,
      [table],
    );
    const row = result.rows[0];
    stats.push({
      table,
      chunks: Number(row?.chunks ?? 0),
      compressedChunks: Number(row?.compressed ?? 0),
      beforeBytes: row?.before === null || row?.before === undefined ? null : Number(row.before),
      afterBytes: row?.after === null || row?.after === undefined ? null : Number(row.after),
      totalBytes: Number(row?.total ?? 0),
    });
  }
  return stats;
}

export interface Timing {
  readonly what: string;
  readonly rows: number;
  readonly ms: number;
}

/**
 * Times the reads a backtest makes: every minute bar of one session for the symbols loaded that month
 * (up to twenty, the size of the ORB's in-play list), and a year of one symbol's minute bars.
 */
export async function timeBacktestReads(pool: pg.Pool): Promise<Timing[]> {
  const sample = await pool.query<{ month: string; symbols: string[] }>(
    `SELECT to_char(month, 'YYYY-MM-DD') AS month, (array_agg(symbol ORDER BY rows DESC))[1:20] AS symbols
     FROM bar_load_checkpoints WHERE timeframe = '1Min' AND status = 'complete' AND rows > 0
     GROUP BY month ORDER BY count(*) DESC, month DESC LIMIT 1`,
  );
  const pick = sample.rows[0];
  if (pick === undefined) {
    return [];
  }
  const session = await pool.query<{ session: string; open_at: Date; close_at: Date }>(
    `SELECT to_char(session, 'YYYY-MM-DD') AS session, open_at, close_at FROM market_sessions
     WHERE session >= $1::date AND session < $1::date + interval '1 month' ORDER BY session DESC LIMIT 1`,
    [pick.month],
  );
  const day = session.rows[0];
  const timings: Timing[] = [];
  const time = async (what: string, sql: string, params: unknown[]): Promise<void> => {
    const started = performance.now();
    const result = await pool.query(sql, params);
    timings.push({ what, rows: result.rowCount ?? 0, ms: Math.round(performance.now() - started) });
  };
  if (day !== undefined) {
    await time(
      `one session (${day.session}), ${String(pick.symbols.length)} symbols`,
      `SELECT * FROM bars_1m WHERE symbol = ANY($1) AND ts >= $2 AND ts < $3 ORDER BY symbol, ts`,
      [pick.symbols, day.open_at, day.close_at],
    );
  }
  const busiest = pick.symbols[0];
  if (busiest !== undefined) {
    await time(
      `one year of ${busiest}`,
      `SELECT * FROM bars_1m WHERE symbol = $1 AND ts >= $2::date - interval '1 year' AND ts < $2::date + interval '1 month'
       ORDER BY ts`,
      [busiest, pick.month],
    );
  }
  return timings;
}

export async function checkpointSummary(
  pool: pg.Pool,
): Promise<Array<{ timeframe: string; status: string; months: number; symbols: number; rows: number }>> {
  const result = await pool.query<{
    timeframe: string;
    status: string;
    months: number;
    symbols: number;
    rows: string;
  }>(
    `SELECT timeframe, status, count(*)::int AS months, count(DISTINCT symbol)::int AS symbols, sum(rows)::bigint AS rows
     FROM bar_load_checkpoints GROUP BY timeframe, status ORDER BY timeframe, status`,
  );
  return result.rows.map((row) => ({ ...row, rows: Number(row.rows) }));
}
