import { describe, expect, it } from "vitest";
import {
  type Account,
  type Bar,
  type BracketOrder,
  type Candidate,
  type EngineHealth,
  type Fill,
  MoneyError,
  type NewsItem,
  type Order,
  type Position,
  type Quote,
  type QuoteEvent,
  type ScreenerRow,
  type SetupSignal,
  type SymbolBar,
  type SymbolSnapshot,
  TERMINAL_ORDER_STATUSES,
  type Trade,
  accountSchema,
  barSchema,
  bracketOrderSchema,
  candidateSchema,
  engineHealthSchema,
  fillSchema,
  fixed,
  fixedSchema,
  formatFixed,
  newsItemSchema,
  orderSchema,
  positionSchema,
  quoteEventSchema,
  quoteSchema,
  ratio,
  ratioSchema,
  screenerRowSchema,
  setupSignalSchema,
  symbolBarSchema,
  symbolSnapshotSchema,
  tradeSchema,
} from "./index.js";
import type { z } from "zod";

const AT = "2026-09-21T13:35:00.000Z";
const LATER = "2026-09-21T19:50:00.000Z";

const bar: Bar = {
  session: "2026-09-21",
  minuteOfSession: 4,
  open: fixed(201_800),
  high: fixed(202_600),
  low: fixed(201_500),
  close: fixed(202_200),
  volume: 110_000,
  vwap: fixed(202_050),
  closed: true,
};
const symbolBar: SymbolBar = { symbol: "AAPL", ...bar };
const quote: Quote = { bid: fixed(202_100), ask: fixed(202_200) };
const quoteEvent: QuoteEvent = { symbol: "AAPL", quote, at: AT };
const signal: SetupSignal = {
  setupId: "orb",
  setupVersion: "1.0.0",
  symbol: "AAPL",
  direction: "long",
  session: "2026-09-21",
  minuteOfSession: 4,
  entryType: "stop",
  entry: fixed(203_000),
  levels: { rangeHigh: fixed(203_000), rangeLow: fixed(199_500) },
};
const bracket: BracketOrder = {
  clientOrderId: "orb-AAPL-20260921-50e967ae",
  symbol: "AAPL",
  side: "buy",
  quantity: 24,
  timeInForce: "day",
  orderClass: "oto",
  entry: { type: "stop", stopPrice: fixed(203_000) },
  stopLoss: { stopPrice: fixed(199_500) },
  takeProfit: null,
};
const order: Order = {
  id: "b1c2",
  clientOrderId: bracket.clientOrderId,
  leg: "entry",
  symbol: "AAPL",
  side: "buy",
  type: "stop",
  quantity: 24,
  filledQuantity: 24,
  averageFillPrice: fixed(203_306),
  limitPrice: null,
  stopPrice: fixed(203_000),
  status: "filled",
  replaces: null,
  submittedAt: AT,
  updatedAt: AT,
};
const fill: Fill = {
  id: "f1",
  orderId: order.id,
  clientOrderId: bracket.clientOrderId,
  symbol: "AAPL",
  side: "buy",
  quantity: 24,
  price: fixed(203_306),
  fees: fixed(0),
  at: AT,
};
const position: Position = {
  symbol: "AAPL",
  direction: "long",
  state: "open",
  quantity: 24,
  averageEntryPrice: fixed(203_306),
  stopPrice: fixed(199_500),
  takeProfitPrice: null,
  clientOrderId: bracket.clientOrderId,
  openedAt: AT,
  unrealizedPnl: fixed(-7_344),
  marketValue: fixed(48_720_000),
};
const trade: Trade = {
  id: "t1",
  clientOrderId: bracket.clientOrderId,
  symbol: "AAPL",
  direction: "long",
  setupId: "orb",
  setupVersion: "1.0.0",
  session: "2026-09-21",
  quantity: 24,
  averageEntryPrice: fixed(203_306),
  averageExitPrice: fixed(199_197),
  openedAt: AT,
  closedAt: LATER,
  exitReason: "stop",
  plannedEntry: fixed(203_000),
  plannedStop: fixed(199_500),
  realizedPnl: fixed(-986_160),
  realizedR: -11_740,
  lots: [
    {
      lotId: "t1-1",
      openedAt: AT,
      closedAt: LATER,
      quantity: 20,
      costBasis: fixed(40_661_200),
      proceeds: fixed(39_839_400),
      fees: fixed(0),
    },
    {
      lotId: "t1-2",
      openedAt: AT,
      closedAt: LATER,
      quantity: 4,
      costBasis: fixed(8_132_240),
      proceeds: fixed(7_967_880),
      fees: fixed(0),
    },
  ],
};
const account: Account = {
  id: "PA3PHD8QJ3AL",
  status: "ACTIVE",
  equity: fixed(25_000_000),
  cash: fixed(25_000_000),
  buyingPower: fixed(100_000_000),
  multiplier: 4,
  tradingBlocked: false,
  asOf: AT,
};
const candidate: Candidate = {
  symbol: "AAPL",
  session: "2026-09-21",
  asOf: AT,
  lastPrice: fixed(202_200),
  averageDailyVolume: 55_000_000,
  dailyAtr: fixed(35_000),
  openingRvol: ratio(24_500),
  spreadBps: ratio(5),
  costToRisk: { ratio: ratio(1_446), costPerShare: fixed(506) },
  rank: 3,
};
const health: EngineHealth = {
  mode: "paper",
  engineVersion: "0.0.1",
  at: AT,
  heartbeatSeq: 1_204,
  halted: false,
  dataFeed: { connected: true, lastBarAt: AT, lastQuoteAt: AT, subscriptions: 22 },
  broker: { connected: true, lastSyncAt: AT, rateLimitRemaining: 180 },
  breaker: { tripped: false, dayPnl: fixed(-120_000), dailyLossLimit: fixed(1_250_000) },
  equity: fixed(24_880_000),
  startOfDayEquity: fixed(25_000_000),
  openPositions: 2,
  workingOrders: 4,
};
const snapshot: SymbolSnapshot = {
  symbol: "AAPL",
  asOf: AT,
  lastTrade: { price: fixed(202_200), at: AT },
  quote,
  minuteBar: bar,
  dailyBar: { ...bar, minuteOfSession: 0, volume: 1_200_000 },
  previousDailyBar: null,
};
const screenerRow: ScreenerRow = {
  symbol: "AAPL",
  rank: 1,
  lastPrice: fixed(202_200),
  volume: 9_000_000,
  changeBps: 312,
};
const news: NewsItem = {
  id: "n1",
  headline: "Apple raises guidance",
  summary: "The company raised full-year guidance.",
  source: "benzinga",
  url: "https://example.com/apple",
  symbols: ["AAPL"],
  publishedAt: AT,
};

/** Engine to JSON to web: what comes back must equal what went in, brands and all. */
function roundTrip<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: T): T {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}

describe("serialization round-trips through JSON", () => {
  const cases: readonly [string, z.ZodType<unknown, z.ZodTypeDef, unknown>, unknown][] = [
    ["Bar", barSchema, bar],
    ["SymbolBar", symbolBarSchema, symbolBar],
    ["Quote", quoteSchema, quote],
    ["QuoteEvent", quoteEventSchema, quoteEvent],
    ["SetupSignal", setupSignalSchema, signal],
    ["BracketOrder", bracketOrderSchema, bracket],
    ["Order", orderSchema, order],
    ["Fill", fillSchema, fill],
    ["Position", positionSchema, position],
    ["Trade", tradeSchema, trade],
    ["Account", accountSchema, account],
    ["Candidate", candidateSchema, candidate],
    ["EngineHealth", engineHealthSchema, health],
    ["SymbolSnapshot", symbolSnapshotSchema, snapshot],
    ["ScreenerRow", screenerRowSchema, screenerRow],
    ["NewsItem", newsItemSchema, news],
  ];
  for (const [name, schema, value] of cases) {
    it(`${name} comes back equal`, () => {
      expect(roundTrip(schema, value)).toEqual(value);
    });
  }

  it("carries money on the wire as the integer unit count", () => {
    expect(JSON.parse(JSON.stringify(quote))).toEqual({ bid: 202_100, ask: 202_200 });
  });

  it("keeps the bracket entry variants distinct", () => {
    const limit: BracketOrder = { ...bracket, entry: { type: "limit", limitPrice: fixed(203_000) } };
    const market: BracketOrder = { ...bracket, entry: { type: "market" } };
    expect(roundTrip(bracketOrderSchema, limit)).toEqual(limit);
    expect(roundTrip(bracketOrderSchema, market)).toEqual(market);
  });
});

describe("what the schemas refuse", () => {
  const fails = (schema: z.ZodType<unknown, z.ZodTypeDef, unknown>, value: unknown): boolean =>
    !schema.safeParse(value).success;

  it("money that is not a safe integer", () => {
    for (const bad of [1.5, Number.NaN, "20.3000", 2 ** 53]) {
      expect(fails(fixedSchema, bad), String(bad)).toBe(true);
      expect(fails(ratioSchema, bad), String(bad)).toBe(true);
    }
    expect(fixedSchema.parse(-0)).toBe(0);
    expect(Object.is(fixedSchema.parse(-0), 0)).toBe(true);
  });

  it("a crossed quote", () => {
    expect(fails(quoteSchema, { bid: 202_200, ask: 202_100 })).toBe(true);
    expect(fails(quoteSchema, { bid: 202_200, ask: 202_200 })).toBe(false);
  });

  it("a malformed session, minute, or timestamp", () => {
    expect(fails(barSchema, { ...bar, session: "09/21/2026" })).toBe(true);
    expect(fails(barSchema, { ...bar, minuteOfSession: 1_440 })).toBe(true);
    expect(fails(barSchema, { ...bar, minuteOfSession: -1 })).toBe(true);
    expect(fails(fillSchema, { ...fill, at: "2026-09-21 13:35" })).toBe(true);
    expect(fails(fillSchema, { ...fill, at: "2026-09-21T13:35:00+02:00" })).toBe(true);
  });

  it("an order filled beyond its quantity, or a bad status", () => {
    expect(fails(orderSchema, { ...order, filledQuantity: 25 })).toBe(true);
    expect(fails(orderSchema, { ...order, status: "working" })).toBe(true);
    expect(fails(orderSchema, { ...order, quantity: 0 })).toBe(true);
  });

  it("a trade whose lots do not account for every share, or with no lots at all", () => {
    expect(fails(tradeSchema, { ...trade, lots: [trade.lots[0]] })).toBe(true);
    expect(fails(tradeSchema, { ...trade, lots: [] })).toBe(true);
    const missingFields = { ...trade, lots: [{ lotId: "x", quantity: 24 }] };
    expect(fails(tradeSchema, missingFields)).toBe(true);
  });

  it("a signal with a bad direction or entry type, or levels that are not money", () => {
    expect(fails(setupSignalSchema, { ...signal, direction: "flat" })).toBe(true);
    expect(fails(setupSignalSchema, { ...signal, entryType: "stopLimit" })).toBe(true);
    expect(fails(setupSignalSchema, { ...signal, levels: { rangeHigh: "20.30" } })).toBe(true);
  });

  it("health from an unknown mode", () => {
    expect(fails(engineHealthSchema, { ...health, mode: "sandbox" })).toBe(true);
  });

  it("a news item with a malformed url", () => {
    expect(fails(newsItemSchema, { ...news, url: "not a url" })).toBe(true);
    expect(fails(newsItemSchema, { ...news, url: null })).toBe(false);
  });
});

describe("money helpers", () => {
  it("brand safe integers and reject the rest", () => {
    expect(fixed(1_234)).toBe(1_234);
    expect(ratio(50)).toBe(50);
    expect(Object.is(fixed(-0), 0)).toBe(true);
    for (const bad of [0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => fixed(bad)).toThrow(MoneyError);
      expect(() => ratio(bad)).toThrow(MoneyError);
    }
    try {
      fixed(0.5);
    } catch (error) {
      expect((error as MoneyError).code).toBe("NOT_INTEGER");
      expect((error as MoneyError).name).toBe("MoneyError");
    }
  });

  it("format with exactly four places", () => {
    expect(formatFixed(fixed(203_306))).toBe("20.3306");
    expect(formatFixed(fixed(-500))).toBe("-0.0500");
    expect(formatFixed(fixed(0))).toBe("0.0000");
    expect(formatFixed(fixed(25_000_000))).toBe("2500.0000");
  });

  it("name the terminal order statuses", () => {
    expect(TERMINAL_ORDER_STATUSES).toEqual(["filled", "canceled", "replaced", "rejected", "expired"]);
  });
});
