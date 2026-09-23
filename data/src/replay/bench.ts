/**
 * Times a backtest replay over the bar store. Reads only, so it is safe beside a running load.
 *
 *   pnpm --filter @trader/data replay:bench [--from 2017-01-01] [--to 2017-12-31] [--symbols A,B,...]
 *
 * Without --symbols it takes the 20 symbols with the most minute bars among those loaded for every
 * month of the range. The engine here is a stand-in with the ORB's shape: at 09:35 it reads each
 * symbol's opening range back through history and a month of daily bars, places a one-share breakout
 * bracket, and flattens everything at 15:50. It runs the replay twice and prints a digest of every
 * event each time, which must match.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BacktestAdapter, type ReplaySource, type SessionHours } from "@trader/adapters";
import { fixed } from "@trader/contracts";
import { DEFAULT_COST_MODEL } from "@trader/core";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { TimescaleReplaySource } from "./timescale.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../../.env") });

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Wraps a source to count its calls and the time spent waiting on them. */
function timed(source: ReplaySource): { source: ReplaySource; calls: () => number; ms: () => number } {
  let calls = 0;
  let ms = 0;
  const wrap =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const started = performance.now();
      calls += 1;
      try {
        return await call(...args);
      } finally {
        ms += performance.now() - started;
      }
    };
  return {
    source: {
      sessions: wrap((from, to) => source.sessions(from, to)),
      loaded: wrap((session, symbols) => source.loaded(session, symbols)),
      sessionBars: wrap((hours, symbols) => source.sessionBars(hours, symbols)),
      dailyBars: wrap((symbol, from, to) => source.dailyBars(symbol, from, to)),
      minuteBars: wrap((symbol, from, to) => source.minuteBars(symbol, from, to)),
      splitFactor: wrap((symbol, session) => source.splitFactor(symbol, session)),
    },
    calls: () => calls,
    ms: () => ms,
  };
}

async function busiest(pool: pg.Pool, from: string, to: string, count: number): Promise<string[]> {
  const result = await pool.query<{ symbol: string }>(
    `SELECT symbol FROM bar_load_checkpoints
     WHERE timeframe = '1Min' AND status = 'complete'
       AND month BETWEEN date_trunc('month', $1::date) AND date_trunc('month', $2::date)
     GROUP BY symbol
     HAVING count(*) = (SELECT count(*) FROM generate_series(date_trunc('month', $1::date),
       date_trunc('month', $2::date), interval '1 month'))
     ORDER BY sum(rows) DESC, symbol LIMIT $3`,
    [from, to, count],
  );
  return result.rows.map((row) => row.symbol);
}

async function replay(pool: pg.Pool, from: string, to: string, symbols: readonly string[]) {
  const store = timed(new TimescaleReplaySource(pool));
  const adapter = await BacktestAdapter.create({
    source: store.source,
    from,
    to,
    universe: symbols,
    costModel: DEFAULT_COST_MODEL,
    startingCash: fixed(25_000 * 10_000),
  });
  await adapter.connect();
  await adapter.data.subscribe(symbols);
  const hours = new Map<string, SessionHours>(adapter.sessions.map((h) => [h.session, h]));
  const digest = createHash("sha256");
  let fills = 0;
  adapter.data.on("bar", (bar) =>
    digest.update(`b${bar.symbol}${bar.session}${String(bar.minuteOfSession)}`),
  );
  adapter.execution.on("orderUpdate", (order) =>
    digest.update(`o${order.id}${order.status}${order.updatedAt}`),
  );
  adapter.execution.on("fill", (fill) => {
    fills += 1;
    digest.update(`f${fill.orderId}${String(fill.price)}${fill.at}`);
  });
  let flattened = "";
  adapter.data.on("bar", (bar) => {
    const session = hours.get(bar.session) as SessionHours;
    if (bar.minuteOfSession === 4) {
      void (async () => {
        const [range, days] = await Promise.all([
          adapter.data.getHistoricalBars({
            symbol: bar.symbol,
            timeframe: "1Min",
            from: new Date(session.openAt).toISOString(),
            to: new Date(session.closeAt).toISOString(),
          }),
          adapter.data.getHistoricalBars({
            symbol: bar.symbol,
            timeframe: "1Day",
            from: new Date(session.openAt - 30 * DAY).toISOString(),
            to: new Date(session.openAt).toISOString(),
          }),
        ]);
        digest.update(`r${bar.symbol}${String(range.length)}${String(days.length)}`);
        const high = Math.max(...range.map((b) => b.high));
        const low = Math.min(...range.map((b) => b.low));
        if (low < high) {
          await adapter.execution.submitBracket({
            clientOrderId: `bench-${bar.symbol}-${bar.session}`,
            symbol: bar.symbol,
            side: "buy",
            quantity: 1,
            timeInForce: "day",
            orderClass: "oto",
            entry: { type: "stop", stopPrice: fixed(high + 100) },
            stopLoss: { stopPrice: fixed(low) },
            takeProfit: null,
          });
        }
      })();
    }
    // 15:50 on a full day, 12:50 on a half day.
    const flattenAt = (session.closeAt - session.openAt) / MINUTE - 10;
    if (bar.minuteOfSession >= flattenAt - 1 && flattened !== bar.session) {
      flattened = bar.session;
      void adapter.execution.flattenAll();
    }
  });
  const started = performance.now();
  const report = await adapter.replay();
  const seconds = (performance.now() - started) / 1_000;
  const account = await adapter.execution.getAccount();
  return {
    seconds,
    storeSeconds: store.ms() / 1_000,
    storeCalls: store.calls(),
    report,
    fills,
    equity: account.equity / 10_000,
    digest: digest.digest("hex").slice(0, 16),
  };
}

const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"], max: 8 });
try {
  const from = option("from") ?? "2017-01-01";
  const to = option("to") ?? "2017-12-31";
  const symbols = option("symbols")?.split(",") ?? (await busiest(pool, from, to, 20));
  console.log(`replaying ${from} to ${to}, ${String(symbols.length)} symbols: ${symbols.join(" ")}`);
  const runs = [];
  for (const run of [1, 2]) {
    const result = await replay(pool, from, to, symbols);
    runs.push(result);
    const { report } = result;
    console.log(
      `run ${String(run)}: ${result.seconds.toFixed(1)} s (${String(result.storeCalls)} store calls, ` +
        `${result.storeSeconds.toFixed(1)} s summed), ${String(report.sessions)} sessions, ` +
        `${String(report.bars)} bars (${Math.round(report.bars / result.seconds).toLocaleString()}/s), ` +
        `${String(result.fills)} fills, closed at the bell ${String(report.closedAtSessionEnd.length)}, ` +
        `expired ${String(report.expiredEntries.length)}, unloaded ${String(report.unloaded.length)}, ` +
        `equity $${result.equity.toFixed(2)}, digest ${result.digest}`,
    );
  }
  console.log(runs[0]?.digest === runs[1]?.digest ? "identical: yes" : "identical: NO");
} finally {
  await pool.end();
}
