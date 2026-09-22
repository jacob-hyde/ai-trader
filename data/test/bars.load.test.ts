import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AlpacaAsset,
  AlpacaBar,
  AlpacaCalendarDay,
  AlpacaCorporateActions,
} from "@trader/adapters/alpaca";
import { config as loadDotenv } from "dotenv";
import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BarLoader, type Unit } from "../src/bars/loader.js";
import { compressNow } from "../src/bars/maintenance.js";
import type { BarSource, BarsQuery } from "../src/bars/source.js";
import { BarStore } from "../src/bars/store.js";
import { fromAssets } from "../src/bars/symbols.js";
import { sessionTimes } from "../src/bars/time.js";
import { verify } from "../src/bars/verify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../.env") });

const ownerUrl = process.env["MIGRATION_DATABASE_URL"] ?? "";
const engineUrl = process.env["DATABASE_URL"] ?? "";

// Tickers no exchange uses, so the test shares a database with real loads safely.
const LIVE = "ZZTLIVE";
const GONE = "ZZTGONE";
const HOLE = "ZZTHOLE";
const SYMBOLS = [LIVE, GONE, HOLE];

/** January and February 2021 as Alpaca's calendar has them: weekdays, less New Year, MLK, and Presidents' Day. */
const CALENDAR: AlpacaCalendarDay[] = Array.from({ length: 59 }, (_unused, i) =>
  new Date(Date.UTC(2021, 0, 1 + i)).toISOString().slice(0, 10),
)
  .filter((date) => {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    return weekday !== 0 && weekday !== 6 && !["2021-01-01", "2021-01-18", "2021-02-15"].includes(date);
  })
  .map((date) => ({ date, open: "09:30", close: "16:00", session_open: "0400", session_close: "2000" }));
const SESSIONS = CALENDAR.map((day) => day.date);

/**
 * A pretend Alpaca. LIVE trades every session at $20 before a 2:1 split on Feb 1 and $10 after. GONE is
 * delisted after Feb 10 and is only in the asset list as inactive. HOLE misses Jan 20 entirely. Minute
 * bars cover 09:25 to 16:04 ET, so pre- and after-market must be dropped.
 */
class FakeAlpaca implements BarSource {
  readonly queries: BarsQuery[] = [];
  /** Throw on the nth bars() call, counting from 1. */
  failOn: number | null = null;

  calendar(): Promise<readonly AlpacaCalendarDay[]> {
    return Promise.resolve(CALENDAR);
  }

  assets(): Promise<readonly AlpacaAsset[]> {
    const asset = (symbol: string, status: "active" | "inactive"): AlpacaAsset => ({
      id: `00000000-0000-4000-8000-00000000000${String(SYMBOLS.indexOf(symbol))}`,
      class: "us_equity",
      exchange: "NYSE",
      symbol,
      name: symbol,
      status,
      tradable: status === "active",
      marginable: false,
      shortable: false,
      easy_to_borrow: false,
      fractionable: false,
      attributes: null,
    });
    return Promise.resolve([asset(LIVE, "active"), asset(GONE, "inactive"), asset(HOLE, "active")]);
  }

  async *corporateActions(): AsyncIterable<AlpacaCorporateActions> {
    // Nothing: the delisted name must come from the asset list here.
  }

  async *bars(query: BarsQuery): AsyncIterable<Readonly<Record<string, readonly AlpacaBar[]>>> {
    this.queries.push(query);
    if (this.failOn === this.queries.length) {
      throw new Error("connection reset");
    }
    const start = Date.parse(query.start);
    const end = Date.parse(query.end);
    const page: Record<string, AlpacaBar[]> = {};
    for (const symbol of query.symbols) {
      const bars: AlpacaBar[] = [];
      for (const session of SESSIONS) {
        if ((symbol === GONE && session > "2021-02-10") || (symbol === HOLE && session === "2021-01-20")) {
          continue;
        }
        const splitDone = session >= "2021-02-01";
        // Split-adjusted history shows old shares at today's basis: twice the volume, half the price.
        const factor = symbol === LIVE && !splitDone && query.adjustment === "split" ? 2 : 1;
        const price = (symbol === LIVE && !splitDone ? 20 : 10) / factor;
        if (query.timeframe === "1Day") {
          const t = new Date(`${session}T05:00:00Z`);
          if (t.getTime() >= start && t.getTime() <= end) {
            bars.push({
              t: t.toISOString(),
              o: price,
              h: price + 0.5,
              l: price - 0.5,
              c: price,
              v: 3_000_000 * factor,
              n: 100,
              vw: price,
            });
          }
          continue;
        }
        const open = sessionTimes({ date: session, open: "09:30", close: "16:00" }).openAt;
        for (let minute = -5; minute < 395; minute += 1) {
          const at = open + minute * 60_000;
          if (at >= start && at <= end) {
            bars.push({
              t: new Date(at).toISOString(),
              o: price,
              h: price + 0.01,
              l: price - 0.01,
              c: price,
              v: 100,
              n: 3,
              vw: price,
            });
          }
        }
      }
      page[symbol] = bars;
    }
    // Two pages, as a paged response would come.
    const half = Object.fromEntries(
      Object.entries(page).map(([symbol, bars]) => [symbol, bars.slice(0, Math.ceil(bars.length / 2))]),
    );
    const rest = Object.fromEntries(
      Object.entries(page).map(([symbol, bars]) => [symbol, bars.slice(Math.ceil(bars.length / 2))]),
    );
    yield half;
    yield rest;
  }
}

const units = (symbols: readonly string[]): Unit[] =>
  symbols.flatMap((symbol) => ["2021-01-01", "2021-02-01"].map((month) => ({ symbol, month })));

describe.skipIf(!ownerUrl || !engineUrl)("H.7 bar store", () => {
  const pool = new pg.Pool({ connectionString: engineUrl, max: 4 });
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  const store = new BarStore(pool);
  // A "now" well after the test months, so both are complete.
  const later = () => new Date("2021-06-01T12:00:00Z");

  const cleanup = async (): Promise<void> => {
    await owner.query("DELETE FROM bars_1m WHERE symbol = ANY($1)", [SYMBOLS]);
    await owner.query("DELETE FROM bars_1d WHERE symbol = ANY($1)", [SYMBOLS]);
    await owner.query("DELETE FROM bar_load_checkpoints WHERE symbol = ANY($1)", [SYMBOLS]);
    await owner.query("DELETE FROM symbols WHERE symbol = ANY($1)", [SYMBOLS]);
    await owner.query("DELETE FROM asset_snapshots WHERE symbol = ANY($1)", [SYMBOLS]);
  };

  beforeAll(async () => {
    await runner({
      databaseUrl: ownerUrl,
      dir: path.resolve(here, "../migrations"),
      migrationsTable: "pgmigrations",
      direction: "up",
      count: Number.POSITIVE_INFINITY,
      log: () => undefined,
    });
    await cleanup();
    // The same sessions a real calendar load writes, so rewriting them is harmless.
    await store.saveSessions(CALENDAR.map(sessionTimes));
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
    await owner.end();
  });

  it("keeps a delisted name in the asset snapshot and on the ticker list", async () => {
    const fake = new FakeAlpaca();
    const assets = await fake.assets();
    await store.saveAssetSnapshot(new Date("2021-06-01T00:00:00Z"), assets);
    expect(await store.addSymbols(fromAssets(assets))).toBe(3);
    expect(await store.addSymbols([{ symbol: GONE, source: "merger" }])).toBe(0);
    const row = await pool.query("SELECT sources FROM symbols WHERE symbol = $1", [GONE]);
    expect(row.rows[0]).toEqual({ sources: ["asset:inactive", "merger"] });
    const snapshot = await pool.query("SELECT status FROM asset_snapshots WHERE symbol = $1", [GONE]);
    expect(snapshot.rows).toEqual([{ status: "inactive" }]);
  });

  it("loads daily bars raw with their split factors, and resumes after a failure", async () => {
    const failing = new FakeAlpaca();
    // One symbol per job, in symbol order: GONE, HOLE, LIVE. HOLE's first request fails.
    failing.failOn = 3;
    const first = await new BarLoader(failing, store).load({
      timeframe: "1Day",
      units: units(SYMBOLS),
      batchSize: 1,
      concurrency: 1,
      now: later,
    });
    expect(first).toMatchObject({ jobs: 3, failedJobs: 1, aborted: false });

    const good = new FakeAlpaca();
    const second = await new BarLoader(good, store).load({
      timeframe: "1Day",
      units: units(SYMBOLS),
      batchSize: 1,
      concurrency: 1,
      now: later,
    });
    // Only the failed job ran again: its split pass and its raw pass.
    expect(second).toMatchObject({ skipped: 4, jobs: 1, failedJobs: 0 });
    expect(good.queries.map((q) => `${q.symbols.join()} ${q.adjustment}`).sort()).toEqual([
      `${HOLE} raw`,
      `${HOLE} split`,
    ]);

    // The same months as a grid, planned one symbol per pass: all complete, nothing fetched.
    const quiet = new FakeAlpaca();
    const again = await new BarLoader(quiet, store).load({
      timeframe: "1Day",
      units: { symbols: SYMBOLS, months: ["2021-01-01", "2021-02-01"] },
      symbolsPerPass: 1,
      now: later,
    });
    expect(again).toMatchObject({ skipped: 6, jobs: 0 });
    expect(quiet.queries).toEqual([]);

    const live = await pool.query<{ session: string; close: string; split_factor: number }>(
      `SELECT to_char(session, 'YYYY-MM-DD') AS session, close, split_factor FROM bars_1d
       WHERE symbol = $1 AND session IN ('2021-01-29', '2021-02-01') ORDER BY session`,
      [LIVE],
    );
    expect(live.rows).toEqual([
      { session: "2021-01-29", close: "200000", split_factor: 2 },
      { session: "2021-02-01", close: "100000", split_factor: 1 },
    ]);
    const counts = await pool.query<{ symbol: string; n: number }>(
      "SELECT symbol, count(*)::int AS n FROM bars_1d WHERE symbol = ANY($1) GROUP BY symbol ORDER BY symbol",
      [SYMBOLS],
    );
    expect(counts.rows).toEqual([
      { symbol: GONE, n: SESSIONS.filter((s) => s <= "2021-02-10").length },
      { symbol: HOLE, n: SESSIONS.length - 1 },
      { symbol: LIVE, n: SESSIONS.length },
    ]);

    await store.refreshSymbolRanges();
    const range = await pool.query(
      "SELECT to_char(last_session, 'YYYY-MM-DD') AS last FROM symbols WHERE symbol = $1",
      [GONE],
    );
    expect(range.rows).toEqual([{ last: "2021-02-10" }]);
  });

  it("writes a month still in progress as partial and fetches it again", async () => {
    const midFebruary = () => new Date("2021-02-17T21:00:00Z");
    await owner.query("DELETE FROM bar_load_checkpoints WHERE symbol = $1 AND timeframe = '1Min'", [LIVE]);
    const first = await new BarLoader(new FakeAlpaca(), store).load({
      timeframe: "1Min",
      units: [{ symbol: LIVE, month: "2021-02-01" }],
      now: midFebruary,
    });
    expect(first.jobs).toBe(1);
    const status = await pool.query(
      "SELECT status FROM bar_load_checkpoints WHERE symbol = $1 AND timeframe = '1Min'",
      [LIVE],
    );
    expect(status.rows).toEqual([{ status: "partial" }]);
    const second = await new BarLoader(new FakeAlpaca(), store).load({
      timeframe: "1Min",
      units: [{ symbol: LIVE, month: "2021-02-01" }],
      now: later,
    });
    expect(second).toMatchObject({ skipped: 0, jobs: 1 });
  });

  it("loads regular-hours minute bars, numbered from the open, and verify finds every hole", async () => {
    const result = await new BarLoader(new FakeAlpaca(), store).load({
      timeframe: "1Min",
      units: units(SYMBOLS),
      now: later,
    });
    // Five minutes before the open and five after the close, every session, every symbol, dropped.
    expect(result.dropped.outsideSession).toBeGreaterThan(0);
    expect(result.dropped.invalid).toBe(0);
    const day = await pool.query<{ n: number; first: number; last: number }>(
      "SELECT count(*)::int AS n, min(minute)::int AS first, max(minute)::int AS last FROM bars_1m WHERE symbol = $1 AND session = '2021-01-27'",
      [LIVE],
    );
    expect(day.rows).toEqual([{ n: 390, first: 0, last: 389 }]);

    const clean = await verify(pool, "2021-01-01", "2021-02-28", SYMBOLS);
    expect(clean.dailyGaps.map((gap) => [gap.symbol, gap.missing, gap.runs])).toEqual([
      [HOLE, [{ from: "2021-01-20", to: "2021-01-20", sessions: 1 }], 1],
    ]);
    expect(clean.minuteGaps).toEqual([]);
    expect(clean.minuteSessions.traded).toBe(clean.minuteSessions.present);

    await owner.query("DELETE FROM bars_1m WHERE symbol = $1 AND session = '2021-02-03'", [LIVE]);
    const holed = await verify(pool, "2021-01-01", "2021-02-28", [LIVE]);
    expect(holed.minuteGaps.map((gap) => [gap.symbol, gap.missing])).toEqual([[LIVE, ["2021-02-03"]]]);
  });

  it(
    "compresses the loaded chunks and still reads them back at backtest speed",
    { timeout: 60_000 },
    async () => {
      // Minute chunks around the test months only; a real load may be writing elsewhere in a shared database.
      expect(
        await compressNow(owner, { tables: ["bars_1m"], from: "2020-12-01", before: "2021-04-01" }),
      ).toBeGreaterThanOrEqual(0);
      // Again, the way a minute load compresses a finished month: everything before it, already-compressed skipped.
      expect(await compressNow(owner, { tables: ["bars_1m"], before: "2021-03-01" })).toBe(0);
      const chunks = await owner.query<{ compressed: boolean }>(
        `SELECT bool_and(is_compressed) AS compressed FROM timescaledb_information.chunks
       WHERE hypertable_name = 'bars_1m' AND range_end <= '2021-03-15'::timestamptz AND range_start >= '2021-01-01'::timestamptz`,
      );
      expect(chunks.rows).toEqual([{ compressed: true }]);
      const started = performance.now();
      const read = await pool.query(
        "SELECT * FROM bars_1m WHERE symbol = ANY($1) AND session = '2021-01-27' ORDER BY symbol, ts",
        [SYMBOLS],
      );
      expect(read.rowCount).toBe(3 * 390);
      expect(performance.now() - started).toBeLessThan(1_000);
    },
  );
});
