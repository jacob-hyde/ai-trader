import { describe, expect, it } from "vitest";
import type { BracketOrder, Fill, Fixed, Order, SymbolBar } from "@trader/contracts";
import { fixed, ratio } from "@trader/contracts";
import {
  type CostModelConfig,
  DEFAULT_COST_MODEL,
  DEFAULT_PATH_CONFIG,
  type FillKind,
  SCRIPTED_SCENARIOS,
  type Scenario,
  type Side,
  type SymbolState,
  type TradePlan,
  buildBracket,
  generatePath,
  loadSetup,
  modelFill,
  orbSetupDefinition,
  planTrade,
  quoteFromReference,
  simulateTrade,
} from "@trader/core";
import { AdapterError } from "./adapter.js";
import { BacktestAdapter, type BacktestAdapterConfig, calendarClock } from "./backtest.js";
import {
  MemoryReplaySource,
  type MemoryReplaySourceData,
  type SessionHours,
  type StoredBar,
  restate,
} from "./replaySource.js";

const CASH = fixed(1_000_000_000);

/** A winter session: 09:30 to 16:00 New York is 14:30Z to 21:00Z. */
function winter(session: string, closeUtc = "21:00"): SessionHours {
  return {
    session,
    openAt: Date.parse(`${session}T14:30:00Z`),
    closeAt: Date.parse(`${session}T${closeUtc}:00Z`),
  };
}

const MON = winter("2026-01-05");
const TUE = winter("2026-01-06");
const WED = winter("2026-01-07");
/** The day after Thanksgiving closes at 13:00 New York, 210 minutes in. */
const HALF = winter("2026-11-27", "18:00");
const AFTER_HALF = winter("2026-11-30");
const CLOCK = calendarClock([MON, TUE, WED, HALF, AFTER_HALF]);

/** Dollars to units. */
const px = (dollars: number): Fixed => fixed(Math.round(dollars * 10_000));

function bar(
  symbol: string,
  hours: SessionHours,
  minute: number,
  [open, high, low, close]: readonly [number, number, number, number],
  volume = 1_000,
): SymbolBar {
  return {
    symbol,
    session: hours.session,
    minuteOfSession: minute,
    open: px(open),
    high: px(high),
    low: px(low),
    close: px(close),
    volume,
    vwap: null,
    closed: true,
  };
}

/** A quiet stretch at one price, minutes from inclusive to exclusive. */
function flat(symbol: string, hours: SessionHours, from: number, to: number, price: number, volume = 1_000) {
  return Array.from({ length: to - from }, (_, i) =>
    bar(symbol, hours, from + i, [price, price, price, price], volume),
  );
}

function daily(symbol: string, hours: SessionHours, close: number, splitFactor: number | null): StoredBar {
  return { ...bar(symbol, hours, 0, [close, close, close, close], 1_000_000), splitFactor };
}

function source(data: Partial<MemoryReplaySourceData> & Pick<MemoryReplaySourceData, "minuteBars">) {
  return new MemoryReplaySource({ sessions: [MON, TUE, WED, HALF, AFTER_HALF], ...data });
}

async function connected(
  from: MemoryReplaySource,
  config: Partial<BacktestAdapterConfig> = {},
): Promise<BacktestAdapter> {
  const adapter = await BacktestAdapter.create({
    source: from,
    from: "2026-01-01",
    to: "2026-12-31",
    universe: [],
    costModel: DEFAULT_COST_MODEL,
    startingCash: CASH,
    ...config,
  });
  await adapter.connect();
  return adapter;
}

function bracketFor(
  symbol: string,
  clientOrderId: string,
  entry: BracketOrder["entry"],
  stop: number,
  target: number | null = null,
): BracketOrder {
  return {
    clientOrderId,
    symbol,
    side: "buy",
    quantity: 10,
    timeInForce: "day",
    orderClass: target === null ? "oto" : "bracket",
    entry,
    stopLoss: { stopPrice: px(stop) },
    takeProfit: target === null ? null : { limitPrice: px(target) },
  };
}

/** The price the cost model gives one fill of ten shares acting at `reference`. */
function priced(side: Side, kind: FillKind, reference: number, costModel = DEFAULT_COST_MODEL): Fixed {
  return modelFill(
    { side, kind, quote: quoteFromReference(px(reference), costModel.spread), shares: 10 },
    costModel,
  ).price;
}

/** Everything an engine would see, one line per event. */
function record(adapter: BacktestAdapter): string[] {
  const log: string[] = [];
  adapter.data.on("bar", (b) => log.push(`bar ${b.symbol} ${b.session} ${String(b.minuteOfSession)}`));
  adapter.data.on("quote", (q) =>
    log.push(`quote ${q.symbol} ${q.at} ${String(q.quote.bid)}/${String(q.quote.ask)}`),
  );
  adapter.execution.on("orderUpdate", (o) => log.push(`order ${o.id} ${o.status} ${o.updatedAt}`));
  adapter.execution.on("fill", (f) => log.push(`fill ${f.orderId} ${String(f.price)} ${f.at}`));
  return log;
}

function fillsOf(adapter: BacktestAdapter): Fill[] {
  const fills: Fill[] = [];
  adapter.execution.on("fill", (fill) => fills.push(fill));
  return fills;
}

describe("the replay", () => {
  it("walks every symbol minute by minute, each minute to the broker before the engine", async () => {
    const a = await connected(
      source({
        minuteBars: [
          ...flat("AAA", MON, 0, 3, 20),
          ...flat("AAA", TUE, 0, 2, 20),
          ...flat("BBB", MON, 0, 1, 10),
          ...flat("BBB", MON, 2, 3, 10),
        ],
      }),
      { from: "2026-01-05", to: "2026-01-06", universe: ["BBB", "AAA"] },
    );
    await a.data.subscribe(["AAA", "BBB"]);
    const log = record(a);
    await a.execution.submitBracket(bracketFor("BBB", "bbb", { type: "market" }, 9));
    const report = await a.replay();
    expect(log.filter((line) => line.startsWith("bar")).map((line) => line.slice(4))).toEqual([
      "AAA 2026-01-05 0",
      "BBB 2026-01-05 0",
      "AAA 2026-01-05 1",
      "AAA 2026-01-05 2",
      "BBB 2026-01-05 2",
      "AAA 2026-01-06 0",
      "AAA 2026-01-06 1",
    ]);
    // BBB's bar reached the broker, which filled the entry, before the engine saw AAA's bar of that minute.
    expect(log.findIndex((line) => line.startsWith("fill bbb/entry"))).toBeLessThan(
      log.indexOf("bar AAA 2026-01-05 0"),
    );
    // Each bar's quote is modeled on its close, stamped when the minute ended.
    const quote = quoteFromReference(px(20), DEFAULT_COST_MODEL.spread);
    expect(log[log.indexOf("bar AAA 2026-01-05 0") + 1]).toBe(
      `quote AAA 2026-01-05T14:31:00.000Z ${String(quote.bid)}/${String(quote.ask)}`,
    );
    expect(report).toMatchObject({ sessions: 2, bars: 7, expiredEntries: [], unloaded: [] });
    // The engine never flattened BBB, so the close did, at its last bar's close.
    expect(report.closedAtSessionEnd.map((o) => [o.id, o.averageFillPrice, o.updatedAt])).toEqual([
      ["bbb/flatten", priced("sell", "market", 10), CLOCK("2026-01-05", 2)],
    ]);
    expect(a.now).toBe("2026-01-06T21:00:00.000Z");
  });

  it("never fills an order on a bar of the minute that prompted it, whatever the symbol", async () => {
    const a = await connected(
      source({
        minuteBars: [
          ...flat("AAA", MON, 0, 4, 20),
          ...flat("BBB", MON, 0, 2, 10),
          ...flat("BBB", MON, 2, 4, 11),
        ],
      }),
      { from: "2026-01-05", to: "2026-01-05", universe: ["AAA", "BBB"] },
    );
    await a.data.subscribe(["AAA"]);
    const fills = fillsOf(a);
    a.data.on("bar", (b) => {
      if (b.minuteOfSession === 1) {
        void a.execution.submitBracket(bracketFor("BBB", "bbb", { type: "market" }, 5));
      }
    });
    await a.replay();
    // Handed out one bar at a time, BBB's minute-1 bar would come after AAA's and fill this at $10.
    expect(fills.map((f) => [f.orderId, f.price, f.at])).toEqual([
      ["bbb/entry", priced("buy", "market", 11), CLOCK("2026-01-05", 2)],
      ["bbb/flatten", priced("sell", "market", 11), CLOCK("2026-01-05", 3)],
    ]);
  });
});

describe("fills against stored bars", () => {
  it("takes the stop when one bar reaches the trigger, the stop, and the target", async () => {
    const a = await connected(
      source({
        minuteBars: [
          ...flat("SYN", MON, 0, 5, 20),
          bar("SYN", MON, 5, [20, 20.7, 19.85, 20.65]),
          ...flat("SYN", MON, 6, 10, 20.65),
          ...flat("TWO", MON, 0, 3, 20),
          bar("TWO", MON, 3, [20, 20.7, 19.8, 20.5]),
          ...flat("TWO", MON, 4, 10, 20.5),
        ],
      }),
      { from: "2026-01-05", to: "2026-01-05", universe: ["SYN", "TWO"] },
    );
    const fills = fillsOf(a);
    await a.execution.submitBracket(
      bracketFor("SYN", "syn", { type: "stop", stopPrice: px(20.1) }, 19.9, 20.6),
    );
    await a.execution.submitBracket(bracketFor("TWO", "two", { type: "market" }, 19.9, 20.6));
    await a.replay();
    // Read in the trade's favor, both bars are winners at the target. Worst case, both are losers.
    expect(fills.map((f) => [f.orderId, f.price, f.at])).toEqual([
      ["two/entry", priced("buy", "market", 20), CLOCK("2026-01-05", 0)],
      ["two/stopLoss", priced("sell", "stopExit", 19.9), CLOCK("2026-01-05", 3)],
      ["syn/entry", priced("buy", "stopEntry", 20.1), CLOCK("2026-01-05", 5)],
      ["syn/stopLoss", priced("sell", "stopExit", 19.9), CLOCK("2026-01-05", 5)],
    ]);
    expect((await a.execution.getAccount()).cash).toBeLessThan(CASH);
  });

  it("fills a stop the market gapped through at the open, not at the stop", async () => {
    const a = await connected(
      source({
        minuteBars: [
          ...flat("SYN", MON, 0, 2, 20),
          bar("SYN", MON, 2, [19.5, 19.6, 19.4, 19.55]),
          ...flat("SYN", MON, 3, 5, 19.55),
        ],
      }),
      { from: "2026-01-05", to: "2026-01-05", universe: ["SYN"] },
    );
    const fills = fillsOf(a);
    await a.execution.submitBracket(bracketFor("SYN", "syn", { type: "market" }, 19.9));
    await a.replay();
    const exit = fills.find((f) => f.orderId === "syn/stopLoss");
    expect(exit?.price).toBe(priced("sell", "stopExit", 19.5));
    expect(exit?.price).toBeLessThan(priced("sell", "stopExit", 19.9));
  });

  it("fills nothing through a halt, then fills what the reopen gapped through at its open", async () => {
    const a = await connected(
      source({
        minuteBars: [
          ...flat("OUT", MON, 0, 11, 20),
          bar("OUT", MON, 30, [19, 19.1, 18.9, 19.05]),
          ...flat("OUT", MON, 31, 40, 19.05),
          ...flat("IN", MON, 0, 11, 20),
          bar("IN", MON, 30, [21, 21.2, 20.9, 21.1]),
          ...flat("IN", MON, 31, 40, 21.1),
        ],
      }),
      { from: "2026-01-05", to: "2026-01-05", universe: ["OUT", "IN"] },
    );
    const fills = fillsOf(a);
    await a.execution.submitBracket(bracketFor("OUT", "out", { type: "market" }, 19.9));
    await a.execution.submitBracket(bracketFor("IN", "in", { type: "stop", stopPrice: px(20.1) }, 19.5));
    await a.replay();
    expect(fills.map((f) => [f.orderId, f.price, f.at])).toEqual([
      ["out/entry", priced("buy", "market", 20), CLOCK("2026-01-05", 0)],
      ["in/entry", priced("buy", "stopEntry", 21), CLOCK("2026-01-05", 30)],
      ["out/stopLoss", priced("sell", "stopExit", 19), CLOCK("2026-01-05", 30)],
      ["in/flatten", priced("sell", "market", 21.1), CLOCK("2026-01-05", 39)],
    ]);
  });

  it("ends a half day at its 13:00 close: working entries expire and open positions exit there", async () => {
    const a = await connected(
      source({
        minuteBars: [
          ...flat("SYN", HALF, 0, 209, 20),
          bar("SYN", HALF, 209, [20, 20.5, 20, 20.5]),
          ...flat("SYN", AFTER_HALF, 0, 10, 20),
        ],
      }),
      { from: "2026-11-27", to: "2026-11-30", universe: ["SYN"] },
    );
    await a.data.subscribe(["SYN"]);
    let closedAt: string | null = null;
    a.execution.on("fill", (f) => {
      if (f.orderId === "syn/flatten") {
        closedAt = a.now;
      }
    });
    const openAtNextSession: number[] = [];
    a.data.on("bar", (b) => {
      if (b.session === "2026-11-30" && b.minuteOfSession === 0) {
        void a.execution.getPositions().then((positions) => openAtNextSession.push(positions.length));
      }
    });
    await a.execution.submitBracket(bracketFor("SYN", "syn", { type: "market" }, 19));
    await a.execution.submitBracket(bracketFor("SYN", "never", { type: "stop", stopPrice: px(30) }, 29));
    const report = await a.replay();
    expect(report.closedAtSessionEnd.map((o) => [o.id, o.averageFillPrice, o.updatedAt])).toEqual([
      ["syn/flatten", priced("sell", "market", 20.5), "2026-11-27T17:59:00.000Z"],
    ]);
    expect(report.expiredEntries.map((o) => [o.id, o.status, o.updatedAt])).toEqual([
      ["never/entry", "expired", "2026-11-27T18:00:00.000Z"],
    ]);
    expect(closedAt).toBe("2026-11-27T18:00:00.000Z");
    expect(openAtNextSession).toEqual([0]);
  });

  it("refuses a cost model with a free fill in it", async () => {
    const frictionless: CostModelConfig = {
      ...DEFAULT_COST_MODEL,
      slippage: { ...DEFAULT_COST_MODEL.slippage, stopEntry: { bps: ratio(0), ticks: 0 } },
    };
    await expect(
      BacktestAdapter.create({
        source: source({ minuteBars: [] }),
        from: "2026-01-05",
        to: "2026-01-05",
        universe: [],
        costModel: frictionless,
        startingCash: CASH,
      }),
    ).rejects.toThrow();
  });
});

describe("point-in-time data", () => {
  /** SPL splits 2:1 on Wednesday: $100 and $102 before, $51 after. Tuesday's factor is missing. */
  const split = () =>
    source({
      minuteBars: [...flat("SPL", TUE, 0, 5, 102), ...flat("SPL", WED, 0, 10, 51)],
      dailyBars: [daily("SPL", WED, 51, 1), daily("SPL", MON, 100, 2), daily("SPL", TUE, 102, null)],
    });
  const everything = { from: "2026-01-01T00:00:00.000Z", to: "2026-12-31T00:00:00.000Z" };

  it("serves history only up to the replay, restated for splits as of the session being replayed", async () => {
    const a = await connected(split(), { from: "2026-01-07", to: "2026-01-07", universe: ["SPL"] });
    await a.data.subscribe(["SPL"]);
    const summary = (bars: readonly SymbolBar[]) =>
      bars.map((b) => `${b.session}@${String(b.minuteOfSession)} ${String(b.close)}x${String(b.volume)}`);

    // Before the first session nothing of it is known, and the lookback is already on its share basis.
    const before = await a.data.getHistoricalBars({ symbol: "SPL", timeframe: "1Day", ...everything });
    expect(summary(before)).toEqual(["2026-01-05@0 500000x2000000", "2026-01-06@0 510000x2000000"]);

    const during: string[][] = [];
    a.data.on("bar", (b) => {
      if (b.minuteOfSession === 3) {
        void (async () => {
          during.push(
            summary(await a.data.getHistoricalBars({ symbol: "SPL", timeframe: "1Day", ...everything })),
          );
          const minutes = await a.data.getHistoricalBars({ symbol: "SPL", timeframe: "1Min", ...everything });
          during.push(summary(minutes));
          // Today's bars come back as traded, so they stay on the tick grid.
          during.push(minutes.filter((m) => m.session === WED.session).map((m) => String(m.close % 100)));
        })();
      }
    });
    await a.replay();
    expect(during).toEqual([
      ["2026-01-05@0 500000x2000000", "2026-01-06@0 510000x2000000"],
      [
        ...[0, 1, 2, 3, 4].map((m) => `2026-01-06@${String(m)} 510000x2000`),
        ...[0, 1, 2, 3].map((m) => `2026-01-07@${String(m)} 510000x1000`),
      ],
      ["0", "0", "0", "0"],
    ]);
    // Once the session has closed its daily bar is history too.
    const after = await a.data.getHistoricalBars({ symbol: "SPL", timeframe: "1Day", ...everything });
    expect(summary(after).at(-1)).toBe("2026-01-07@0 510000x1000000");
    expect(
      await a.data.getHistoricalBars({
        symbol: "SPL",
        timeframe: "1Min",
        from: "2026-12-31T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual([]);
  });

  it("snapshots what the replay has shown and nothing more", async () => {
    const a = await connected(
      source({
        minuteBars: [
          bar("AAA", TUE, 0, [20, 20.2, 19.9, 20.1], 500),
          bar("AAA", TUE, 1, [20.1, 20.5, 20, 20.4], 700),
          bar("AAA", TUE, 2, [20.4, 20.4, 19.8, 19.9], 900),
          ...flat("AAA", TUE, 3, 6, 19.9),
          ...flat("BBB", TUE, 4, 6, 10),
        ],
        dailyBars: [daily("AAA", MON, 19.5, 1), daily("AAA", TUE, 19.9, 1)],
      }),
      { from: "2026-01-06", to: "2026-01-06", universe: ["AAA", "BBB"] },
    );
    await a.data.subscribe(["AAA"]);
    expect(await a.data.getSnapshots(["AAA"])).toEqual([]);
    const seen: unknown[] = [];
    a.data.on("bar", (b) => {
      if (b.minuteOfSession === 2) {
        void a.data.getSnapshots(["AAA", "BBB", "ZZZ", "AAA"]).then((snapshots) => seen.push(snapshots));
      }
    });
    const report = await a.replay();
    const quote = quoteFromReference(px(19.9), DEFAULT_COST_MODEL.spread);
    expect(seen).toEqual([
      [
        {
          symbol: "AAA",
          asOf: "2026-01-06T14:33:00.000Z",
          lastTrade: { price: px(19.9), at: "2026-01-06T14:32:00.000Z" },
          quote,
          minuteBar: { ...bar("AAA", TUE, 2, [20.4, 20.4, 19.8, 19.9], 900), symbol: undefined },
          dailyBar: {
            session: "2026-01-06",
            minuteOfSession: 0,
            open: px(20),
            high: px(20.5),
            low: px(19.8),
            close: px(19.9),
            volume: 2_100,
            vwap: null,
            closed: false,
          },
          previousDailyBar: { ...daily("AAA", MON, 19.5, 1), symbol: undefined, splitFactor: undefined },
        },
      ],
    ]);
    // ZZZ was never loaded, so it replayed as silence, and the report says so.
    expect(report.unloaded).toEqual([{ session: "2026-01-06", symbol: "ZZZ" }]);
    const [closing] = await a.data.getSnapshots(["AAA"]);
    expect(closing?.dailyBar).toMatchObject({ closed: true, volume: 5_100 });
  });
});

describe("what the engine brings in", () => {
  it("applies a subscription change from the next minute, and replays a new symbol from there", async () => {
    const a = await connected(
      source({
        minuteBars: [
          ...flat("AAA", MON, 0, 10, 20),
          ...flat("BBB", MON, 0, 10, 10),
          ...flat("CCC", MON, 0, 10, 5),
        ],
      }),
      { from: "2026-01-05", to: "2026-01-05", universe: ["AAA", "BBB"] },
    );
    await expect(
      (
        await BacktestAdapter.create({
          source: source({ minuteBars: [] }),
          from: "2026-01-05",
          to: "2026-01-05",
          universe: [],
          costModel: DEFAULT_COST_MODEL,
          startingCash: CASH,
        })
      ).data.subscribe(["AAA"]),
    ).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    await a.data.subscribe(["AAA"]);
    const seen: string[] = [];
    a.data.on("bar", (b) => {
      seen.push(`${b.symbol}${String(b.minuteOfSession)}`);
      if (b.symbol === "AAA" && b.minuteOfSession === 3) {
        void a.data.subscribe(["CCC", "BBB"]);
      }
      if (b.symbol === "AAA" && b.minuteOfSession === 6) {
        void a.data.unsubscribe(["BBB", "NOPE"]);
      }
    });
    await a.replay();
    expect(a.data.subscriptions()).toEqual(["AAA", "CCC"]);
    // BBB already replayed for the universe. Its minute-3 and minute-6 bars went out with the change.
    expect(seen.filter((s) => s.startsWith("BBB"))).toEqual(["BBB4", "BBB5", "BBB6"]);
    expect(seen.filter((s) => s.startsWith("CCC"))).toEqual(["CCC4", "CCC5", "CCC6", "CCC7", "CCC8", "CCC9"]);
  });

  it("brings in a symbol the engine orders but never subscribed to, so the order meets its bars", async () => {
    const a = await connected(
      source({
        minuteBars: [
          ...flat("AAA", MON, 0, 5, 20),
          ...flat("CCC", MON, 0, 2, 5),
          ...flat("CCC", MON, 2, 5, 6),
        ],
      }),
      { from: "2026-01-05", to: "2026-01-05", universe: ["AAA"] },
    );
    await a.data.subscribe(["AAA"]);
    const log = record(a);
    a.data.on("bar", (b) => {
      if (b.minuteOfSession === 1) {
        void a.execution.submitBracket(bracketFor("CCC", "ccc", { type: "market" }, 4));
      }
    });
    await a.replay();
    expect(log.filter((line) => line.startsWith("fill"))).toEqual([
      `fill ccc/entry ${String(priced("buy", "market", 6))} ${CLOCK("2026-01-05", 2)}`,
      `fill ccc/flatten ${String(priced("sell", "market", 6))} ${CLOCK("2026-01-05", 4)}`,
    ]);
    expect(log.some((line) => line.startsWith("bar CCC"))).toBe(false);
  });

  it("asks the universe per session, and refuses a universe symbol the store never loaded", async () => {
    const asked: string[] = [];
    const a = await connected(
      source({ minuteBars: [...flat("AAA", MON, 0, 2, 20), ...flat("BBB", TUE, 0, 2, 10)] }),
      {
        from: "2026-01-05",
        to: "2026-01-06",
        universe: (hours) => {
          asked.push(hours.session);
          return Promise.resolve(hours.session === MON.session ? ["AAA"] : ["BBB"]);
        },
      },
    );
    const report = await a.replay();
    expect(asked).toEqual(["2026-01-05", "2026-01-06"]);
    expect(report.bars).toBe(4);
    await expect(a.replay()).rejects.toMatchObject({ code: "UNSUPPORTED" });

    const missing = await connected(source({ minuteBars: flat("AAA", MON, 0, 2, 20) }), {
      from: "2026-01-05",
      to: "2026-01-05",
      universe: ["AAA", "NOPE"],
    });
    await expect(missing.replay()).rejects.toThrow("no minute bars loaded for NOPE in 2026-01");
  });

  it("ranks the screener by volume replayed so far and has no news", async () => {
    const a = await connected(
      source({
        minuteBars: [
          ...flat("AAA", MON, 0, 3, 20, 100),
          ...flat("BBB", MON, 0, 3, 10, 300),
          ...flat("CCC", MON, 0, 3, 5, 300),
          ...flat("DDD", MON, 2, 3, 5, 5_000),
        ],
      }),
      { from: "2026-01-05", to: "2026-01-05", universe: ["AAA", "BBB", "CCC", "DDD"] },
    );
    await a.data.subscribe(["AAA"]);
    const ranked: string[][] = [];
    a.data.on("bar", (b) => {
      if (b.minuteOfSession === 1) {
        void a.data
          .getScreener("topGainers", 3)
          .then((rows) => ranked.push(rows.map((r) => `${String(r.rank)} ${r.symbol} ${String(r.volume)}`)));
      }
    });
    await a.replay();
    expect(ranked).toEqual([["1 BBB 600", "2 CCC 600", "3 AAA 200"]]);
    expect((await a.data.getScreener("mostActives", 1)).map((r) => r.symbol)).toEqual(["DDD"]);
    expect(await a.data.getNews({})).toEqual([]);
  });

  it("hands a store failure to the call that hit it, and stops the replay when the universe cannot load", async () => {
    class Flaky extends MemoryReplaySource {
      failures = 1;
      override sessionBars(hours: SessionHours, symbols: readonly string[]) {
        if (symbols.includes("BAD") && this.failures > 0) {
          this.failures -= 1;
          return Promise.reject(new Error("connection reset"));
        }
        return super.sessionBars(hours, symbols);
      }
    }
    // Sessions out of order on purpose: the source sorts them.
    const flaky = new Flaky({
      sessions: [TUE, MON],
      minuteBars: [...flat("AAA", MON, 0, 5, 20), ...flat("BAD", MON, 0, 5, 10)],
    });
    const a = await connected(flaky, { from: "2026-01-05", to: "2026-01-05", universe: ["AAA"] });
    await a.data.subscribe(["AAA"]);
    const outcomes: string[] = [];
    const seen: string[] = [];
    a.data.on("bar", (b) => {
      seen.push(`${b.symbol}${String(b.minuteOfSession)}`);
      if (b.minuteOfSession === 1 || b.minuteOfSession === 2) {
        void a.data.subscribe(["BAD"]).then(
          () => outcomes.push(`subscribed at ${String(b.minuteOfSession)}`),
          (error: unknown) =>
            outcomes.push(`failed at ${String(b.minuteOfSession)}: ${(error as Error).message}`),
        );
      }
    });
    await a.replay();
    // The failed read left nothing half done, so the next subscribe read BAD again and it replayed.
    expect(outcomes).toEqual(["failed at 1: connection reset", "subscribed at 2"]);
    expect(seen.filter((s) => s.startsWith("BAD"))).toEqual(["BAD3", "BAD4"]);

    const broken = await connected(new Flaky({ sessions: [MON], minuteBars: flat("BAD", MON, 0, 5, 10) }), {
      from: "2026-01-05",
      to: "2026-01-05",
      universe: ["BAD"],
    });
    await expect(broken.replay()).rejects.toThrow("connection reset");
  });

  it("builds only over a range with sessions, and replays only when connected", async () => {
    const empty = source({ minuteBars: [] });
    const config = {
      source: empty,
      universe: [],
      costModel: DEFAULT_COST_MODEL,
      startingCash: CASH,
    };
    await expect(BacktestAdapter.create({ ...config, from: "2026-02-01", to: "2026-01-01" })).rejects.toThrow(
      AdapterError,
    );
    await expect(BacktestAdapter.create({ ...config, from: "2026-02-01", to: "2026-02-28" })).rejects.toThrow(
      "no sessions",
    );
    const a = await BacktestAdapter.create({ ...config, from: "2026-01-05", to: "2026-01-05" });
    await expect(a.replay()).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    await a.connect();
    await a.close();
    await expect(a.replay()).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    expect(() => calendarClock([MON])("2026-01-06", 0)).toThrow(AdapterError);
  });
});

describe("determinism", () => {
  const symbols = ["ALP", "BET", "GAM", "DEL"];
  const sessions = [MON, TUE, WED];
  const minuteBars = sessions.flatMap((hours, day) =>
    symbols.flatMap((symbol, i) =>
      generatePath({
        ...DEFAULT_PATH_CONFIG,
        scenario: "driftlessWalk",
        seed: 100 * day + i + 1,
        session: hours.session,
        volatilityBps: 40,
      }).bars.map((b) => ({ ...b, symbol })),
    ),
  );

  /**
   * An engine that waits on the adapter in every handler: it reads the opening range back through
   * history and a snapshot before it places a breakout bracket, and flattens late in the day.
   */
  async function run(delay: () => number): Promise<string[]> {
    const a = await connected(new MemoryReplaySource({ sessions, minuteBars, delay }), {
      from: "2026-01-05",
      to: "2026-01-07",
      universe: symbols,
    });
    await a.data.subscribe(symbols);
    const log = record(a);
    let flattened = "";
    a.data.on("bar", (b) => {
      if (b.minuteOfSession === 4) {
        void (async () => {
          const hours = sessions.find((h) => h.session === b.session) as SessionHours;
          const range = await a.data.getHistoricalBars({
            symbol: b.symbol,
            timeframe: "1Min",
            from: new Date(hours.openAt).toISOString(),
            to: new Date(hours.closeAt).toISOString(),
          });
          const [snapshot] = await a.data.getSnapshots([b.symbol]);
          log.push(
            `range ${b.symbol} ${String(range.length)} ${String(snapshot?.minuteBar?.minuteOfSession)}`,
          );
          const high = Math.max(...range.map((r) => r.high));
          const low = Math.min(...range.map((r) => r.low));
          await a.execution.submitBracket(
            bracketFor(
              b.symbol,
              `${b.symbol}-${b.session}`,
              { type: "stop", stopPrice: fixed(high + 100) },
              low / 10_000,
            ),
          );
        })();
      }
      if (b.minuteOfSession >= 379 && flattened !== b.session) {
        flattened = b.session;
        void a.execution.flattenAll();
      }
    });
    const report = await a.replay();
    log.push(JSON.stringify(report), JSON.stringify(await a.execution.getAccount()));
    return log;
  }

  it("replays the same sessions identically, however long each call to the store takes", async () => {
    const still = await run(() => 0);
    const jittery = await run(() => Math.floor(Math.random() * 4));
    const again = await run(() => Math.floor(Math.random() * 4));
    expect(jittery).toEqual(still);
    expect(again).toEqual(still);
    // The range was read back at minute 4 with nothing after it, and trades happened.
    expect(still.filter((line) => line.startsWith("range"))).toEqual(
      sessions.flatMap(() => [...symbols].sort().map((s) => `range ${s} 5 4`)),
    );
    expect(still.filter((line) => line.startsWith("fill")).length).toBeGreaterThan(8);
  });
});

describe("the backtest agrees with the trade simulator across symbols and sessions", () => {
  const LAST_ENTRY_MINUTE = 360;
  const FLATTEN_MINUTE = 380;
  const SHARES = 10;
  const sessions = [MON, TUE, WED];
  const scenarios: readonly Scenario[] = ["driftlessWalk", ...SCRIPTED_SCENARIOS];

  interface Case {
    readonly symbol: string;
    readonly hours: SessionHours;
    readonly bars: readonly SymbolBar[];
    readonly plan: TradePlan | null;
  }

  function cases(params: Record<string, unknown>): Case[] {
    const setup = loadSetup(orbSetupDefinition, { allowShort: true, ...params });
    return sessions.flatMap((hours, day) =>
      scenarios.flatMap((scenario, s) =>
        [1, 2, 3, 4].map((seed): Case => {
          const symbol = `S${String(s)}${String(seed)}`;
          const bars = generatePath({
            ...DEFAULT_PATH_CONFIG,
            scenario,
            seed: 1_000 * day + seed,
            session: hours.session,
            volatilityBps: scenario === "driftlessWalk" ? 60 : DEFAULT_PATH_CONFIG.volatilityBps,
          }).bars.map((b) => ({ ...b, symbol }));
          const range = bars.filter((b) => b.minuteOfSession < 5);
          const last = range.at(-1) as SymbolBar;
          const state: SymbolState = {
            symbol,
            session: hours.session,
            minuteOfSession: last.minuteOfSession,
            lastClose: last.close,
            dailyAtr: fixed(15_000),
            rsi: null,
            sessionVwap: null,
            openingRvol: ratio(20_000),
            runningRvol: null,
          };
          const signal = setup.detectTrigger(state, range, null);
          return { symbol, hours, bars, plan: signal === null ? null : planTrade(setup, signal, state) };
        }),
      ),
    );
  }

  /**
   * Drives every case through one backtest. With `flatten`, the engine cancels an unfilled entry at the
   * last entry minute and flattens at the flatten minute. Without, it does neither and the close does.
   */
  async function drive(
    all: readonly Case[],
    flatten: boolean,
  ): Promise<{ fills: Fill[]; orders: Order[]; cash: number; closedAtEnd: number }> {
    const withPlans = all.filter((c) => c.plan !== null);
    const a = await connected(new MemoryReplaySource({ sessions, minuteBars: all.flatMap((c) => c.bars) }), {
      from: "2026-01-05",
      to: "2026-01-07",
      universe: [...new Set(all.map((c) => c.symbol))],
    });
    await a.data.subscribe([...new Set(all.map((c) => c.symbol))]);
    const byKey = new Map(withPlans.map((c) => [`${c.symbol}|${c.hours.session}`, c]));
    const fills = fillsOf(a);
    const orders: Order[] = [];
    const state = new Map<
      string,
      { entryId?: string; stopId?: string; entered?: boolean; closed?: boolean; moved?: boolean }
    >();
    a.execution.on("orderUpdate", (o) => {
      orders.push(o);
      const s = state.get(o.clientOrderId) ?? {};
      state.set(o.clientOrderId, s);
      if (o.leg === "entry" && o.status === "accepted") s.entryId = o.id;
      if (o.leg === "entry" && o.status === "filled") s.entered = true;
      if (o.leg === "stopLoss" && o.status === "accepted") s.stopId = o.id;
      if (o.leg !== "entry" && o.status === "filled") s.closed = true;
    });
    let flattened = "";
    a.data.on("bar", (b) => {
      const c = byKey.get(`${b.symbol}|${b.session}`);
      if (flatten && b.minuteOfSession >= FLATTEN_MINUTE - 1 && flattened !== b.session) {
        flattened = b.session;
        void a.execution.flattenAll();
      }
      if (c === undefined) {
        return;
      }
      const plan = c.plan as TradePlan;
      const built = buildBracket({ plan, shares: SHARES });
      if (!built.ok) {
        throw new Error(built.reasons.join(", "));
      }
      const id = built.order.clientOrderId;
      if (b.minuteOfSession === plan.signal.minuteOfSession) {
        void a.execution.submitBracket(built.order);
      }
      const s = state.get(id);
      if (s === undefined) {
        return;
      }
      const long = plan.signal.direction === "long";
      const risk = long ? plan.signal.entry - plan.stop : plan.stop - plan.signal.entry;
      const breakevenAtR = plan.management.breakevenAtR;
      if (s.entered && !s.closed && breakevenAtR !== null && !s.moved) {
        const trigger = long
          ? plan.signal.entry + Math.ceil((risk * breakevenAtR) / 10_000)
          : plan.signal.entry - Math.ceil((risk * breakevenAtR) / 10_000);
        if (long ? b.high >= trigger : b.low <= trigger) {
          s.moved = true;
          void a.execution.replace(s.stopId as string, { stopPrice: plan.signal.entry });
        }
      }
      const next = c.bars.find((x) => x.minuteOfSession > b.minuteOfSession);
      const lastBefore =
        b.minuteOfSession < LAST_ENTRY_MINUTE &&
        (next === undefined || next.minuteOfSession >= LAST_ENTRY_MINUTE);
      if (flatten && !s.entered && s.entryId !== undefined && lastBefore) {
        void a.execution.cancel(s.entryId);
      }
    });
    const report = await a.replay();
    if (flatten) {
      expect(report.closedAtSessionEnd).toEqual([]);
    }
    return {
      fills,
      orders,
      cash: (await a.execution.getAccount()).cash,
      closedAtEnd: report.closedAtSessionEnd.length,
    };
  }

  const variants = {
    eod: {},
    target: { exit: { kind: "fixedR", targetR: 2, breakevenAtR: 1 } },
  } as const;

  for (const [variant, params] of Object.entries(variants)) {
    for (const flatten of [true, false]) {
      it(`${variant} exit, ${flatten ? "the engine flattens" : "the close flattens"}`, async () => {
        const all = cases(params);
        const { fills, orders, cash, closedAtEnd } = await drive(all, flatten);
        let pnl = 0;
        let filled = 0;
        const reasons = new Set<string>();
        for (const c of all) {
          if (c.plan === null) {
            continue;
          }
          const minutes = (c.hours.closeAt - c.hours.openAt) / 60_000;
          const expected = simulateTrade(c.plan, c.bars, {
            shares: SHARES,
            costModel: DEFAULT_COST_MODEL,
            lastEntryMinute: flatten ? LAST_ENTRY_MINUTE : minutes,
            flattenMinute: flatten ? FLATTEN_MINUTE : minutes,
          });
          const built = buildBracket({ plan: c.plan, shares: SHARES });
          const id = built.ok ? built.order.clientOrderId : "";
          const mine = fills.filter((f) => f.clientOrderId === id);
          const where = `${c.symbol} ${c.hours.session}`;
          if (!expected.filled) {
            expect(mine, where).toEqual([]);
            continue;
          }
          filled += 1;
          reasons.add(expected.exitReason);
          pnl += expected.netPnl;
          const [entry, exit] = mine as [Fill, Fill];
          expect(mine.length, where).toBe(2);
          expect([entry.price, entry.at], where).toEqual([
            expected.entryFill,
            CLOCK(c.hours.session, expected.entryMinute),
          ]);
          expect([exit.price, exit.at], where).toEqual([
            expected.exitFill,
            CLOCK(c.hours.session, expected.exitMinute),
          ]);
          const leg = (orders.find((o) => o.id === exit.orderId) as Order).leg;
          expect(leg, where).toBe(
            { stop: "stopLoss", breakevenStop: "stopLoss", target: "takeProfit", eod: "flatten" }[
              expected.exitReason
            ],
          );
        }
        expect(cash - CASH).toBe(pnl);
        expect(filled).toBeGreaterThan(20);
        expect(reasons.has("stop")).toBe(true);
        if (variant === "eod") {
          expect(reasons.has("eod")).toBe(true);
          // Without the engine's flatten, every position still open went out at the close.
          expect(closedAtEnd > 0).toBe(!flatten);
        } else {
          expect(reasons.has("target")).toBe(true);
        }
      });
    }
  }
});

describe("restating stored bars", () => {
  const stored = (splitFactor: number | null): StoredBar => ({
    ...daily("SPL", MON, 100.01, splitFactor),
    vwap: px(100.02),
  });

  it("puts a bar on another session's share basis, and leaves one on the same basis untouched", () => {
    expect(restate(stored(4), 1)).toEqual({
      ...stored(4),
      splitFactor: undefined,
      open: px(25.0025),
      high: px(25.0025),
      low: px(25.0025),
      close: px(25.0025),
      vwap: px(25.005),
      volume: 4_000_000,
    });
    const { splitFactor: _unused, ...plain } = stored(2);
    expect(restate(stored(2), 2.0000004)).toEqual(plain);
    expect(restate(stored(null), 2)).toEqual(plain);
    expect(restate(stored(2), null)).toEqual(plain);
    expect(restate({ ...stored(1), vwap: null }, 3).vwap).toBeNull();
  });

  it("refuses a minute bar on a day the memory source has no session for", () => {
    expect(() => new MemoryReplaySource({ sessions: [MON], minuteBars: flat("AAA", TUE, 0, 1, 20) })).toThrow(
      RangeError,
    );
  });
});
