/**
 * Checks what the bar store holds against the calendar, and reports the holes.
 *
 * Daily: every session between a symbol's first and last daily bar should have a bar. Missing sessions
 * are reported as runs. A short run is a halt or missing data. A run of months is usually a ticker that
 * went quiet and came back as a different company (BBBY from 2023 to 2025), which the bars being
 * ticker-at-time makes visible. Before the first bar and after the last is listing and delisting.
 *
 * Minute: every session a symbol has a daily bar for, in a month whose minute bars are loaded, should
 * have minute bars. A thinly traded name can skip minutes, so the count of minutes is not checked, only
 * that the session is there. Minute bars on a session with no daily bar are reported too.
 */

import type pg from "pg";

export interface MissingRun {
  readonly from: string;
  readonly to: string;
  readonly sessions: number;
}

export interface DailyCoverage {
  readonly symbol: string;
  readonly first: string;
  readonly last: string;
  readonly expected: number;
  readonly present: number;
  /** Runs of consecutive missing sessions, oldest first, at most five. */
  readonly missing: readonly MissingRun[];
  /** How many runs there are in all. */
  readonly runs: number;
}

export interface MinuteCoverage {
  readonly symbol: string;
  readonly month: string;
  /** Sessions with a daily bar in the month. */
  readonly traded: number;
  /** Sessions with at least one minute bar. */
  readonly present: number;
  /** Up to ten traded sessions with no minute bar. */
  readonly missing: readonly string[];
}

export interface VerifyReport {
  readonly symbols: number;
  readonly dailyGaps: readonly DailyCoverage[];
  readonly dailySessions: { readonly expected: number; readonly present: number };
  readonly minuteMonths: number;
  readonly minuteGaps: readonly MinuteCoverage[];
  readonly minuteSessions: { readonly traded: number; readonly present: number };
}

export async function verify(
  pool: pg.Pool,
  from: string,
  to: string,
  symbols: readonly string[] | null,
): Promise<VerifyReport> {
  const daily = await pool.query<{
    symbol: string;
    first: string;
    last: string;
    present: number;
    expected: number;
  }>(
    `WITH r AS (
       SELECT symbol, min(session) AS first, max(session) AS last, count(*)::int AS present
       FROM bars_1d WHERE session BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR symbol = ANY($3))
       GROUP BY symbol
     )
     SELECT r.symbol, to_char(r.first, 'YYYY-MM-DD') AS first, to_char(r.last, 'YYYY-MM-DD') AS last, r.present,
       (SELECT count(*)::int FROM market_sessions s WHERE s.session BETWEEN r.first AND r.last) AS expected
     FROM r ORDER BY r.symbol`,
    [from, to, symbols],
  );
  const dailyGaps: DailyCoverage[] = [];
  let expected = 0;
  let present = 0;
  for (const row of daily.rows) {
    expected += row.expected;
    present += row.present;
    if (row.present < row.expected) {
      const runs = await pool.query<{ from: string; to: string; sessions: number; total: number }>(
        `WITH s AS (
           SELECT session, row_number() OVER (ORDER BY session) AS n FROM market_sessions
           WHERE session BETWEEN $2 AND $3
         ), missing AS (
           SELECT session, n - row_number() OVER (ORDER BY n) AS run FROM s
           WHERE NOT EXISTS (SELECT 1 FROM bars_1d d WHERE d.symbol = $1 AND d.session = s.session)
         )
         SELECT to_char(min(session), 'YYYY-MM-DD') AS from, to_char(max(session), 'YYYY-MM-DD') AS to,
           count(*)::int AS sessions, (count(*) OVER ())::int AS total
         FROM missing GROUP BY run ORDER BY min(session) LIMIT 5`,
        [row.symbol, row.first, row.last],
      );
      dailyGaps.push({
        ...row,
        missing: runs.rows.map(({ from: start, to: end, sessions }) => ({ from: start, to: end, sessions })),
        runs: runs.rows[0]?.total ?? 0,
      });
    }
  }

  // Counted from the bars themselves, not from the checkpoints, so rows lost after a load show up.
  // Distinct symbol-sessions first, then per month: a count(DISTINCT) grouped by month sorts every
  // row, and over the full store that ran for hours where this takes a minute or two.
  const minute = await pool.query<{ symbol: string; month: string; traded: number; present: number }>(
    `WITH s AS (
       SELECT symbol, session FROM bars_1m
       WHERE ts >= date_trunc('month', $1::date) AND ts < $2::date + 1 AND ($3::text[] IS NULL OR symbol = ANY($3))
       GROUP BY symbol, session
     ), m AS (
       SELECT symbol, date_trunc('month', session)::date AS month, count(*)::int AS present
       FROM s GROUP BY 1, 2
     ), d AS (
       SELECT symbol, date_trunc('month', session)::date AS month, count(*)::int AS traded
       FROM bars_1d
       WHERE session >= date_trunc('month', $1::date) AND session <= $2 AND ($3::text[] IS NULL OR symbol = ANY($3))
       GROUP BY 1, 2
     )
     SELECT c.symbol, to_char(c.month, 'YYYY-MM-DD') AS month, coalesce(m.present, 0) AS present,
       coalesce(d.traded, 0) AS traded
     FROM bar_load_checkpoints c
     LEFT JOIN m ON m.symbol = c.symbol AND m.month = c.month
     LEFT JOIN d ON d.symbol = c.symbol AND d.month = c.month
     WHERE c.timeframe = '1Min' AND c.month BETWEEN date_trunc('month', $1::date) AND $2
       AND ($3::text[] IS NULL OR c.symbol = ANY($3))
     ORDER BY c.symbol, c.month`,
    [from, to, symbols],
  );
  const minuteGaps: MinuteCoverage[] = [];
  let traded = 0;
  let minutePresent = 0;
  for (const row of minute.rows) {
    traded += row.traded;
    minutePresent += row.present;
    if (row.present !== row.traded) {
      const missing = await pool.query<{ session: string }>(
        `SELECT to_char(d.session, 'YYYY-MM-DD') AS session FROM bars_1d d
         JOIN market_sessions s ON s.session = d.session
         WHERE d.symbol = $1 AND d.session >= $2::date AND d.session < $2::date + interval '1 month'
           AND NOT EXISTS (
             SELECT 1 FROM bars_1m m WHERE m.symbol = d.symbol AND m.ts >= s.open_at AND m.ts < s.close_at
           )
         ORDER BY d.session LIMIT 10`,
        [row.symbol, row.month],
      );
      minuteGaps.push({ ...row, missing: missing.rows.map((m) => m.session) });
    }
  }

  return {
    symbols: daily.rows.length,
    dailyGaps,
    dailySessions: { expected, present },
    minuteMonths: minute.rows.length,
    minuteGaps,
    minuteSessions: { traded, present: minutePresent },
  };
}

/** The report as lines for a terminal. */
export function formatReport(report: VerifyReport, limit = 25): string[] {
  const pct = (a: number, b: number): string => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(2)}%`);
  const lines = [
    `daily: ${String(report.symbols)} symbols, ${String(report.dailySessions.present)} of ${String(report.dailySessions.expected)} sessions ` +
      `between each symbol's first and last bar (${pct(report.dailySessions.present, report.dailySessions.expected)}), ` +
      `${String(report.dailyGaps.length)} symbols with gaps`,
  ];
  for (const gap of report.dailyGaps.slice(0, limit)) {
    const runs = gap.missing.map((run) =>
      run.sessions === 1 ? run.from : `${run.from}..${run.to} (${String(run.sessions)})`,
    );
    const more =
      gap.runs > gap.missing.length ? ` and ${String(gap.runs - gap.missing.length)} more runs` : "";
    lines.push(
      `  ${gap.symbol} ${gap.first}..${gap.last}: ${String(gap.present)}/${String(gap.expected)}, missing ${runs.join(", ")}${more}`,
    );
  }
  lines.push(
    `minute: ${String(report.minuteMonths)} symbol-months, ${String(report.minuteSessions.present)} of ${String(report.minuteSessions.traded)} traded sessions ` +
      `have minute bars (${pct(report.minuteSessions.present, report.minuteSessions.traded)}), ${String(report.minuteGaps.length)} symbol-months with gaps`,
  );
  for (const gap of report.minuteGaps.slice(0, limit)) {
    lines.push(
      `  ${gap.symbol} ${gap.month.slice(0, 7)}: ${String(gap.present)}/${String(gap.traded)}` +
        (gap.missing.length > 0
          ? `, missing ${gap.missing.join(" ")}`
          : ", minute bars on a session with no daily bar"),
    );
  }
  return lines;
}
