/**
 * Where bad prints might be (H.8): the candidates a backtest's bad-tick filter checks for corrupted days.
 *
 * One pass over the minute store, a month at a time, keeps every symbol-session with a bar whose high or
 * low reaches more than 9% past its body. The filter only ever cuts an extreme at least its limit past
 * the body, and its limit is never under 10%, so every cut it could make sits inside these sessions. A
 * backtest runs the exact filter over them alone to find a day too corrupted to trade, instead of over
 * every bar in the store.
 *
 * Each month is replaced in one short transaction and stamped with when it was scanned. A month loaded
 * after its scan is out of date, and a backtest refuses it until the scan runs again.
 */

import type pg from "pg";

/** Just under the filter's lowest allowed limit, so no cut can fall outside the candidates. */
export const WIDE_WICK = 0.09;

/** Scans each month (its first day, "2021-03-01") and returns the candidate symbol-sessions found. */
export async function scanWideWicks(
  pool: pg.Pool,
  months: readonly string[],
  log: (line: string) => void = () => undefined,
): Promise<number> {
  let found = 0;
  for (const month of months) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM bad_tick_candidates WHERE session >= $1::date AND session < ($1::date + interval '1 month')`,
        [month],
      );
      const inserted = await client.query(
        `INSERT INTO bad_tick_candidates (symbol, session, wide_bars)
         SELECT symbol, session, count(*) FROM bars_1m
         WHERE ts >= $1::date AND ts < ($1::date + interval '1 month')
           AND (high > greatest(open, close) * (1 + $2::numeric) OR low < least(open, close) * (1 - $2::numeric))
         GROUP BY symbol, session`,
        [month, WIDE_WICK],
      );
      await client.query(
        `INSERT INTO bad_tick_scans (month, scanned_at) VALUES ($1, now())
         ON CONFLICT (month) DO UPDATE SET scanned_at = excluded.scanned_at`,
        [month],
      );
      await client.query("COMMIT");
      found += inserted.rowCount ?? 0;
      log(`suspects ${month.slice(0, 7)}: ${String(inserted.rowCount ?? 0)} symbol-sessions`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return found;
}

/** Months that hold minute bars, oldest first, as their first day. */
export async function minuteMonths(pool: pg.Pool, from: string, to: string): Promise<string[]> {
  const result = await pool.query<{ month: string }>(
    `SELECT DISTINCT to_char(month, 'YYYY-MM-DD') AS month FROM bar_load_checkpoints
     WHERE timeframe = '1Min' AND month BETWEEN date_trunc('month', $1::date) AND $2::date
     ORDER BY month`,
    [from, to],
  );
  return result.rows.map((row) => row.month);
}
