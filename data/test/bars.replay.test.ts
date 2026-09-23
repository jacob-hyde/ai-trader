import path from "node:path";
import { fileURLToPath } from "node:url";
import { BacktestAdapter, type BacktestAdapterConfig, type SessionHours } from "@trader/adapters";
import type { BracketOrder, SymbolBar } from "@trader/contracts";
import { fixed } from "@trader/contracts";
import { DEFAULT_COST_MODEL, modelFill, quoteFromReference } from "@trader/core";
import { config as loadDotenv } from "dotenv";
import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DailyRow, MinuteRow } from "../src/bars/convert.js";
import { BarStore } from "../src/bars/store.js";
import { sessionTimes } from "../src/bars/time.js";
import { TimescaleReplaySource } from "../src/replay/timescale.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../.env") });

const ownerUrl = process.env["MIGRATION_DATABASE_URL"] ?? "";
const engineUrl = process.env["DATABASE_URL"] ?? "";

// Tickers no exchange uses, so the test shares a database with real loads safely.
const GAP = "ZZTRGAP";
const SPLIT = "ZZTRSPL";
/** In a universe but never loaded: no checkpoint. */
const NONE = "ZZTRNONE";
const SYMBOLS = [GAP, SPLIT, NONE];

/** Three winter sessions, 14:30Z to 21:00Z, the way Alpaca's calendar gives them. */
const DAYS = ["2023-03-06", "2023-03-07", "2023-03-08"] as const;
const [MON, TUE, WED] = DAYS;
const HOURS = DAYS.map((date) => sessionTimes({ date, open: "09:30", close: "16:00" }));

/** Dollars to units. */
const px = (dollars: number): number => Math.round(dollars * 10_000);

function minute(
  symbol: string,
  day: number,
  at: number,
  prices: readonly number[],
  volume = 1_000,
): MinuteRow {
  const hours = HOURS[day] as SessionHours;
  const [open, high, low, close] = prices.map(px) as [number, number, number, number];
  return {
    symbol,
    session: hours.session,
    ts: new Date(hours.openAt + at * 60_000).toISOString(),
    minute: at,
    open,
    high,
    low,
    close,
    volume,
    trades: 10,
    vwap: null,
  };
}

function quiet(symbol: string, day: number, from: number, to: number, price: number): MinuteRow[] {
  return Array.from({ length: to - from }, (_, i) =>
    minute(symbol, day, from + i, [price, price, price, price]),
  );
}

function daily(symbol: string, session: string, close: number, splitFactor: number | null): DailyRow {
  const units = px(close);
  return {
    symbol,
    session,
    open: units,
    high: units,
    low: units,
    close: units,
    volume: 1_000_000,
    trades: 100,
    vwap: null,
    splitFactor,
  };
}

/**
 * GAP trades quietly at $20 on Monday, halts after 10:00, and reopens at 10:30 at $19. SPLIT splits
 * 2:1 on Wednesday: $100 Monday and $102 Tuesday, whose split factor is missing, then $51.
 */
const MINUTES: MinuteRow[] = [
  ...quiet(GAP, 0, 0, 31, 20),
  minute(GAP, 0, 60, [19, 19.1, 18.9, 19.05]),
  ...quiet(GAP, 0, 61, 70, 19.05),
  ...quiet(GAP, 1, 0, 10, 19.05),
  ...quiet(SPLIT, 1, 0, 5, 102),
  ...quiet(SPLIT, 2, 0, 10, 51),
];
const DAILY: DailyRow[] = [
  daily(GAP, MON, 19.05, 1),
  daily(GAP, TUE, 19.05, 1),
  daily(SPLIT, MON, 100, 2),
  daily(SPLIT, TUE, 102, null),
  daily(SPLIT, WED, 51, 1),
];

describe.skipIf(!ownerUrl || !engineUrl)("F.2 backtest replay over the bar store", () => {
  const pool = new pg.Pool({ connectionString: engineUrl, max: 4 });
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  const store = new BarStore(pool);
  const source = new TimescaleReplaySource(pool);

  const cleanup = async (): Promise<void> => {
    await owner.query("DELETE FROM bars_1m WHERE symbol = ANY($1)", [SYMBOLS]);
    await owner.query("DELETE FROM bars_1d WHERE symbol = ANY($1)", [SYMBOLS]);
    await owner.query("DELETE FROM bar_load_checkpoints WHERE symbol = ANY($1)", [SYMBOLS]);
  };

  const backtest = async (config: Partial<BacktestAdapterConfig>): Promise<BacktestAdapter> => {
    const adapter = await BacktestAdapter.create({
      source,
      from: MON,
      to: WED,
      universe: [],
      costModel: DEFAULT_COST_MODEL,
      startingCash: fixed(100_000_000),
      ...config,
    });
    await adapter.connect();
    return adapter;
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
    await store.saveSessions(HOURS);
    const checkpoint = (symbol: string) => ({
      symbol,
      month: "2023-03-01",
      status: "complete" as const,
      rows: MINUTES.filter((row) => row.symbol === symbol).length,
      sessions: new Set(MINUTES.filter((row) => row.symbol === symbol).map((row) => row.session)).size,
    });
    await store.writeJob("1Day", DAILY, []);
    await store.writeJob("1Min", MINUTES, [checkpoint(GAP), checkpoint(SPLIT)]);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
    await owner.end();
  });

  it("reads the calendar with each session's real hours", async () => {
    expect(await source.sessions(MON, WED)).toEqual(HOURS);
    expect(await source.loaded(TUE, SYMBOLS)).toEqual(new Set([GAP, SPLIT]));
  });

  it("replays stored bars into the broker the same way twice, and fills the reopen's gap at its open", async () => {
    const run = async (): Promise<string[]> => {
      const adapter = await backtest({ from: MON, to: TUE, universe: [GAP] });
      await adapter.data.subscribe([GAP]);
      const log: string[] = [];
      adapter.data.on("bar", (b) =>
        log.push(`bar ${b.session} ${String(b.minuteOfSession)} ${String(b.close)}`),
      );
      adapter.execution.on("fill", (f) => log.push(`fill ${f.orderId} ${String(f.price)} ${f.at}`));
      const order: BracketOrder = {
        clientOrderId: "gap",
        symbol: GAP,
        side: "buy",
        quantity: 10,
        timeInForce: "day",
        orderClass: "oto",
        entry: { type: "market" },
        stopLoss: { stopPrice: fixed(px(19.9)) },
        takeProfit: null,
      };
      await adapter.execution.submitBracket(order);
      const report = await adapter.replay();
      log.push(JSON.stringify(report));
      return log;
    };
    const first = await run();
    expect(await run()).toEqual(first);
    const exit = modelFill(
      {
        side: "sell",
        kind: "stopExit",
        quote: quoteFromReference(fixed(px(19)), DEFAULT_COST_MODEL.spread),
        shares: 10,
      },
      DEFAULT_COST_MODEL,
    ).price;
    // Nothing between 10:00 and 10:30: the halt has no bars. The stop fills at the reopen's open, not at $19.90.
    expect(first.filter((line) => line.startsWith("fill"))).toEqual([
      expect.stringMatching(/^fill gap\/entry \d+ 2023-03-06T14:30:00.000Z$/),
      `fill gap/stopLoss ${String(exit)} 2023-03-06T15:30:00.000Z`,
    ]);
    expect(first.filter((line) => line.startsWith("bar 2023-03-06")).length).toBe(31 + 10);
  });

  it("restates a lookback across a split as of the session being replayed", async () => {
    const adapter = await backtest({ from: WED, to: WED, universe: [SPLIT] });
    await adapter.data.subscribe([SPLIT]);
    const seen: string[][] = [];
    const summary = (bars: readonly SymbolBar[]) =>
      bars.map((b) => `${b.session}@${String(b.minuteOfSession)} ${String(b.close)}x${String(b.volume)}`);
    const wide = { from: "2023-01-01T00:00:00.000Z", to: "2023-12-31T00:00:00.000Z" };
    adapter.data.on("bar", (b) => {
      if (b.minuteOfSession === 3) {
        void Promise.all([
          adapter.data.getHistoricalBars({ symbol: SPLIT, timeframe: "1Day", ...wide }),
          adapter.data.getHistoricalBars({ symbol: SPLIT, timeframe: "1Min", ...wide }),
        ]).then(([days, minutes]) => seen.push(summary(days), summary(minutes)));
      }
    });
    await adapter.replay();
    // Tuesday's factor is missing, so it takes Monday's: the same side of the split.
    expect(seen).toEqual([
      [`${MON}@0 500000x2000000`, `${TUE}@0 510000x2000000`],
      [
        ...[0, 1, 2, 3, 4].map((m) => `${TUE}@${String(m)} 510000x2000`),
        ...[0, 1, 2, 3].map((m) => `${WED}@${String(m)} 510000x1000`),
      ],
    ]);
  });

  it("refuses to replay a universe symbol whose month was never loaded", async () => {
    const adapter = await backtest({ from: MON, to: MON, universe: [GAP, NONE] });
    await expect(adapter.replay()).rejects.toThrow(`no minute bars loaded for ${NONE} in 2023-03`);
  });
});
