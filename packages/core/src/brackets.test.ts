import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Bar } from "./bars.js";
import {
  BRACKET_REJECTION_REASONS,
  MAX_CLIENT_ORDER_ID_LENGTH,
  buildBracket,
  clientOrderIdFor,
  type BracketOrder,
} from "./brackets.js";
import { DEFAULT_COST_TO_RISK, evaluateCostToRisk } from "./costToRisk.js";
import { DEFAULT_COST_MODEL } from "./costs.js";
import { fixed, fromNumber, ratio, type Fixed } from "./money.js";
import { orbSetupDefinition } from "./orb.js";
import { BREAKER_ARMED, DEFAULT_RISK_CONFIG, evaluateOrder } from "./riskRules.js";
import {
  loadSetup,
  planTrade,
  type EntryType,
  type SetupSignal,
  type SymbolState,
  type TradePlan,
} from "./setup.js";
import { sizePosition, type Direction } from "./sizing.js";

const usd = fromNumber;

function plan(
  direction: Direction,
  entry: number,
  stop: number,
  target: number | null,
  signal: Partial<SetupSignal> = {},
): TradePlan {
  return {
    signal: {
      setupId: "orb",
      setupVersion: "1.0.0",
      symbol: "AAPL",
      direction,
      session: "2026-09-21",
      minuteOfSession: 4,
      entryType: "stop",
      entry: usd(entry),
      levels: {},
      ...signal,
    },
    stop: usd(stop),
    target: target === null ? null : usd(target),
    management: { breakevenAtR: null },
  };
}

function built(input: TradePlan, shares = 25): BracketOrder {
  const result = buildBracket({ plan: input, shares });
  if (!result.ok) {
    throw new Error(`expected an order, got ${result.reasons.join(", ")}`);
  }
  return result.order;
}

function reasonsFor(input: TradePlan, shares = 25): readonly string[] {
  const result = buildBracket({ plan: input, shares });
  return result.ok ? [] : result.reasons;
}

/** Alpaca's bracket and OTO rules, restated from its docs independently of the builder. */
function alpacaViolations(order: BracketOrder, basePrice: Fixed): string[] {
  const problems: string[] = [];
  const decimalsOk = (price: Fixed) => price % (price >= 10_000 ? 100 : 1) === 0;
  if (!Number.isInteger(order.quantity) || order.quantity <= 0) {
    problems.push("quantity must be a positive whole number");
  }
  if (order.timeInForce !== "day") {
    problems.push("time_in_force must be day or gtc");
  }
  if ((order.orderClass === "bracket") !== (order.takeProfit !== null)) {
    problems.push("bracket needs both exits and oto exactly one");
  }
  const stop = order.stopLoss.stopPrice;
  const limit = order.takeProfit?.limitPrice ?? null;
  const entryPrice = order.entry.type === "stop" ? order.entry.stopPrice : basePrice;
  if (order.side === "buy" ? stop > entryPrice - 100 : stop < entryPrice + 100) {
    problems.push("stop_loss.stop_price must be at least $0.01 beyond the base price");
  }
  if (limit !== null && (order.side === "buy" ? limit < entryPrice + 100 : limit > entryPrice - 100)) {
    problems.push("take_profit.limit_price must be at least $0.01 beyond the base price");
  }
  if (limit !== null && (order.side === "buy" ? limit <= stop : limit >= stop)) {
    problems.push("take_profit must be on the far side of stop_loss");
  }
  if (![entryPrice, stop, ...(limit === null ? [] : [limit])].every(decimalsOk)) {
    problems.push("too many decimals for the price level");
  }
  return problems;
}

describe("buildBracket", () => {
  it("builds a long bracket with both exits", () => {
    expect(built(plan("long", 20.3, 20.15, 20.6))).toEqual({
      clientOrderId: clientOrderIdFor(plan("long", 20.3, 20.15, 20.6)),
      symbol: "AAPL",
      side: "buy",
      quantity: 25,
      timeInForce: "day",
      orderClass: "bracket",
      entry: { type: "stop", stopPrice: usd(20.3) },
      stopLoss: { stopPrice: usd(20.15) },
      takeProfit: { limitPrice: usd(20.6) },
    });
  });

  it("builds a stop-only order for a position that runs to the EOD flatten", () => {
    const order = built(plan("long", 20.3, 20.15, null));
    expect(order.orderClass).toBe("oto");
    expect(order.takeProfit).toBeNull();
    expect(order.stopLoss).toEqual({ stopPrice: usd(20.15) });
  });

  it("mirrors a short", () => {
    const order = built(plan("short", 19.7, 19.85, 19.4));
    expect(order.side).toBe("sell");
    expect(order.entry).toEqual({ type: "stop", stopPrice: usd(19.7) });
    expect(order.stopLoss).toEqual({ stopPrice: usd(19.85) });
    expect(order.takeProfit).toEqual({ limitPrice: usd(19.4) });
  });

  it("carries limit and market entries", () => {
    expect(built(plan("long", 20.3, 20.15, null, { entryType: "limit" })).entry).toEqual({
      type: "limit",
      limitPrice: usd(20.3),
    });
    expect(built(plan("long", 20.3, 20.15, null, { entryType: "market" })).entry).toEqual({ type: "market" });
  });

  it("satisfies Alpaca's rules across a table of long cases and their mirrored shorts", () => {
    const cases: readonly [number, number, number | null][] = [
      [20.3, 20.15, null],
      [20.3, 20.15, 20.6],
      [20.3, 20.29, 20.31],
      [5.0, 4.95, 5.1],
      [99.99, 98.5, null],
      [250.0, 249.0, 252.0],
      [0.5, 0.49, 0.52],
      [1.0, 0.99, 1.01],
    ];
    for (const [entry, stop, target] of cases) {
      for (const entryType of ["stop", "limit", "market"] as const) {
        const long = plan("long", entry, stop, target, { entryType });
        expect(alpacaViolations(built(long), long.signal.entry), JSON.stringify(long)).toEqual([]);
        const mirroredTarget = target === null ? null : Math.round((2 * entry - target) * 10_000) / 10_000;
        const mirroredStop = Math.round((2 * entry - stop) * 10_000) / 10_000;
        const short = plan("short", entry, mirroredStop, mirroredTarget, { entryType });
        expect(alpacaViolations(built(short), short.signal.entry), JSON.stringify(short)).toEqual([]);
      }
    }
  });
});

describe("buildBracket rejections", () => {
  it("lists its reasons in a stable order", () => {
    expect(BRACKET_REJECTION_REASONS).toEqual([
      "INVALID_IDENTITY",
      "INVALID_QUANTITY",
      "INVALID_PRICE",
      "PRICE_OFF_TICK",
      "STOP_GEOMETRY",
      "TARGET_GEOMETRY",
    ]);
  });

  it("rejects a stop on the wrong side of entry, or within a penny of it, and never moves it", () => {
    expect(reasonsFor(plan("long", 20.3, 20.45, null))).toEqual(["STOP_GEOMETRY"]);
    expect(reasonsFor(plan("long", 20.3, 20.3, null))).toEqual(["STOP_GEOMETRY"]);
    expect(reasonsFor(plan("long", 20.3, 20.29, null))).toEqual([]);
    expect(reasonsFor(plan("short", 19.7, 19.55, null))).toEqual(["STOP_GEOMETRY"]);
    expect(reasonsFor(plan("short", 19.7, 19.7, null))).toEqual(["STOP_GEOMETRY"]);
    expect(reasonsFor(plan("short", 19.7, 19.71, null))).toEqual([]);
    // Below a dollar the tick is $0.0001 but Alpaca's minimum distance is still a full penny.
    expect(reasonsFor(plan("long", 0.5, 0.495, null))).toEqual(["STOP_GEOMETRY"]);
  });

  it("rejects a target on the wrong side of entry, or within a penny of it", () => {
    expect(reasonsFor(plan("long", 20.3, 20.15, 20.2))).toEqual(["TARGET_GEOMETRY"]);
    expect(reasonsFor(plan("long", 20.3, 20.15, 20.3))).toEqual(["TARGET_GEOMETRY"]);
    expect(reasonsFor(plan("long", 20.3, 20.15, 20.31))).toEqual([]);
    expect(reasonsFor(plan("short", 19.7, 19.85, 19.8))).toEqual(["TARGET_GEOMETRY"]);
    expect(reasonsFor(plan("short", 19.7, 19.85, 19.69))).toEqual([]);
  });

  it("rejects a price off the tick grid instead of rounding it", () => {
    expect(reasonsFor(plan("long", 20.305, 20.15, null))).toEqual(["PRICE_OFF_TICK"]);
    expect(reasonsFor(plan("long", 20.3, 20.1549, null))).toEqual(["PRICE_OFF_TICK"]);
    expect(reasonsFor(plan("long", 20.3, 20.15, 20.6001))).toEqual(["PRICE_OFF_TICK"]);
    // Sub-dollar prices trade in hundredths of a cent.
    expect(reasonsFor(plan("long", 0.5123, 0.4987, null))).toEqual([]);
  });

  it("rejects a quantity that is not a positive whole number", () => {
    for (const shares of [0, -5, 1.5, Number.NaN]) {
      expect(reasonsFor(plan("long", 20.3, 20.15, null), shares)).toEqual(["INVALID_QUANTITY"]);
    }
  });

  it("rejects a price that is not a positive whole number of units, without checking its geometry", () => {
    const base = plan("long", 20.3, 20.15, 20.6);
    expect(reasonsFor({ ...base, stop: fixed(0) })).toEqual(["INVALID_PRICE"]);
    expect(reasonsFor({ ...base, stop: Number.NaN as Fixed })).toEqual(["INVALID_PRICE"]);
    expect(reasonsFor({ ...base, target: fixed(-100) })).toEqual(["INVALID_PRICE"]);
    expect(reasonsFor({ ...base, signal: { ...base.signal, entry: Number.NaN as Fixed } })).toEqual([
      "INVALID_PRICE",
    ]);
  });

  it("rejects a trade it cannot name", () => {
    expect(reasonsFor(plan("long", 20.3, 20.15, null, { symbol: "" }))).toEqual(["INVALID_IDENTITY"]);
    expect(reasonsFor(plan("long", 20.3, 20.15, null, { setupId: "" }))).toEqual(["INVALID_IDENTITY"]);
    expect(reasonsFor(plan("long", 20.3, 20.15, null, { session: "09/21/2026" }))).toEqual([
      "INVALID_IDENTITY",
    ]);
    const longName = "opening-range-breakout-with-a-very-long-name";
    expect(reasonsFor(plan("long", 20.3, 20.15, null, { setupId: longName }))).toEqual(["INVALID_IDENTITY"]);
  });

  it("reports every reason at once", () => {
    const bad = plan("long", 20.305, 20.45, 20.2, { symbol: "" });
    expect(reasonsFor(bad, 0)).toEqual([
      "INVALID_IDENTITY",
      "INVALID_QUANTITY",
      "PRICE_OFF_TICK",
      "STOP_GEOMETRY",
      "TARGET_GEOMETRY",
    ]);
  });
});

describe("clientOrderIdFor", () => {
  const base = plan("long", 20.3, 20.15, 20.6);

  it("is pinned, because the idempotency ledger keys on it", () => {
    expect(clientOrderIdFor(base)).toBe("orb-AAPL-20260921-50e967ae");
    expect(clientOrderIdFor(base).length).toBeLessThanOrEqual(MAX_CLIENT_ORDER_ID_LENGTH);
  });

  it("is the same for the same trade, whatever its size or management", () => {
    const again = plan("long", 20.3, 20.15, 20.6);
    expect(buildBracket({ plan: again, shares: 25 })).toEqual(buildBracket({ plan: base, shares: 25 }));
    expect(built(again, 3).clientOrderId).toBe(built(base, 25).clientOrderId);
    const managed = { ...base, management: { breakevenAtR: ratio(10_000) } };
    expect(clientOrderIdFor(managed)).toBe(clientOrderIdFor(base));
    expect(clientOrderIdFor({ ...base, signal: { ...base.signal, levels: { rangeHigh: usd(20.3) } } })).toBe(
      clientOrderIdFor(base),
    );
  });

  it("changes with anything that makes it a different trade", () => {
    const variants: readonly TradePlan[] = [
      plan("long", 20.31, 20.15, 20.6),
      plan("long", 20.3, 20.14, 20.6),
      plan("long", 20.3, 20.15, 20.61),
      plan("long", 20.3, 20.15, null),
      plan("short", 20.3, 20.15, 20.6),
      plan("long", 20.3, 20.15, 20.6, { symbol: "MSFT" }),
      plan("long", 20.3, 20.15, 20.6, { session: "2026-09-22" }),
      plan("long", 20.3, 20.15, 20.6, { setupVersion: "1.0.1" }),
      plan("long", 20.3, 20.15, 20.6, { minuteOfSession: 6 }),
      plan("long", 20.3, 20.15, 20.6, { entryType: "limit" }),
    ];
    const ids = new Set(variants.map(clientOrderIdFor));
    expect(ids.size).toBe(variants.length);
    expect(ids.has(clientOrderIdFor(base))).toBe(false);
  });
});

describe("buildBracket properties", () => {
  const entryTypeArb = fc.constantFrom<EntryType>("stop", "limit", "market");
  const planArb = fc
    .record({
      direction: fc.constantFrom<Direction>("long", "short"),
      entryCents: fc.integer({ min: 200, max: 50_000 }),
      stopCents: fc.integer({ min: -60, max: 60 }),
      targetCents: fc.option(fc.integer({ min: -200, max: 200 }), { nil: null }),
      entryType: entryTypeArb,
      shares: fc.integer({ min: -2, max: 500 }),
    })
    .map(({ direction, entryCents, stopCents, targetCents, entryType, shares }) => ({
      shares,
      plan: plan(
        direction,
        entryCents / 100,
        (entryCents + stopCents) / 100,
        targetCents === null ? null : (entryCents + targetCents) / 100,
        { entryType },
      ),
    }));

  it("only ever emits an order that satisfies Alpaca's rules, and rejects the rest with a reason", () => {
    fc.assert(
      fc.property(planArb, (input) => {
        const result = buildBracket(input);
        if (result.ok) {
          expect(alpacaViolations(result.order, input.plan.signal.entry)).toEqual([]);
          expect(result.order.quantity).toBe(input.shares);
          expect(result.order.stopLoss.stopPrice).toBe(input.plan.stop);
        } else {
          expect(result.reasons.length).toBeGreaterThan(0);
        }
        expect(buildBracket(input)).toEqual(result);
      }),
    );
  });
});

describe("the decision pipeline end to end", () => {
  const SESSION = "2026-01-05";
  const bar = (minute: number, open: number, high: number, low: number, close: number): Bar => ({
    session: SESSION,
    minuteOfSession: minute,
    open: usd(open),
    high: usd(high),
    low: usd(low),
    close: usd(close),
    volume: 50_000,
    vwap: null,
    closed: true,
  });
  const bars = [
    bar(0, 20.0, 20.1, 19.95, 20.05),
    bar(1, 20.05, 20.2, 20.0, 20.15),
    bar(2, 20.15, 20.3, 20.1, 20.25),
    bar(3, 20.25, 20.28, 20.12, 20.18),
    bar(4, 20.18, 20.26, 20.15, 20.22),
  ];
  const symbol: SymbolState = {
    symbol: "AAA",
    session: SESSION,
    minuteOfSession: 4,
    lastClose: usd(20.22),
    dailyAtr: usd(1.5),
    rsi: 61,
    sessionVwap: usd(20.12),
    openingRvol: ratio(25_000),
    runningRvol: ratio(25_000),
  };
  const quote = { bid: usd(20.21), ask: usd(20.22) };

  function decide(stop: Record<string, unknown>) {
    const setup = loadSetup(orbSetupDefinition, { stop });
    const signal = setup.detectTrigger(symbol, bars, quote) as SetupSignal;
    const tradePlan = planTrade(setup, signal, symbol);
    const stopDistance = fixed(signal.entry - tradePlan.stop);
    const gate = evaluateCostToRisk({ quote, stopDistance }, DEFAULT_COST_TO_RISK, DEFAULT_COST_MODEL);
    return { tradePlan, gate };
  }

  it("turns the range-low ORB variant into an approved stop-only order", () => {
    const { tradePlan, gate } = decide({ kind: "openingRange" });
    // $0.0506 of round-trip cost against a $0.35 stop.
    expect(gate).toMatchObject({ passed: true, costToRisk: 1_446 });

    const sized = sizePosition(
      {
        direction: tradePlan.signal.direction,
        entry: tradePlan.signal.entry,
        stop: tradePlan.stop,
        equity: usd(2_500),
        buyingPower: usd(2_500),
        roundTripCostPerShare: gate.costPerShare as Fixed,
      },
      { riskPerTrade: ratio(100), maxPositionPct: ratio(2_000), regime: { kind: "proven" } },
    );
    expect(sized).toMatchObject({ accepted: true, shares: 24, bindingConstraint: "notionalCap" });
    const shares = sized.accepted ? sized.shares : 0;

    const verdict = evaluateOrder(
      {
        intent: "entry",
        symbol: "AAA",
        direction: "long",
        shares,
        entry: tradePlan.signal.entry,
        stop: tradePlan.stop,
      },
      {
        account: { equity: usd(2_500), startOfDayEquity: usd(2_500), realizedPnlToday: usd(0) },
        exposures: [],
        breaker: BREAKER_ARMED,
      },
      DEFAULT_RISK_CONFIG,
    );
    expect(verdict.allowed).toBe(true);

    expect(built(tradePlan, shares)).toMatchObject({
      symbol: "AAA",
      side: "buy",
      quantity: 24,
      orderClass: "oto",
      entry: { type: "stop", stopPrice: usd(20.3) },
      stopLoss: { stopPrice: usd(19.95) },
      takeProfit: null,
    });
  });

  it("stops the published 10% ATR stop at the cost gate under the default cost model", () => {
    const { gate } = decide({ kind: "atrFraction", fraction: 0.1 });
    // The same $0.0506 against a $0.15 stop is 0.34R.
    expect(gate).toMatchObject({ passed: false, reason: "COST_TO_RISK_ABOVE_MAX", costToRisk: 3_374 });
  });
});
