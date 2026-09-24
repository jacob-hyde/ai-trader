import { describe, expect, it } from "vitest";
import type { Bar, BracketOrder, Fill, Order } from "@trader/contracts";
import { fixed, ratio } from "@trader/contracts";
import {
  DEFAULT_COST_MODEL,
  DEFAULT_PATH_CONFIG,
  SCRIPTED_SCENARIOS,
  type Scenario,
  type SetupSignal,
  type SymbolState,
  type TradePlan,
  buildBracket,
  generatePath,
  loadSetup,
  orbSetupDefinition,
  planTrade,
  simulateTrade,
} from "@trader/core";
import { AdapterError } from "./adapter.js";
import { labelClock } from "./clock.js";
import { SimulatedExecution } from "./simulatedExecution.js";
import { SyntheticAdapter } from "./synthetic.js";

const SESSION = "2026-01-05";
const CASH = fixed(1_000_000_000);
const SHARES = 10;
const LAST_ENTRY_MINUTE = 360;
const FLATTEN_MINUTE = 380;

const VARIANTS = {
  eod: {},
  target: { exit: { kind: "fixedR", targetR: 2, breakevenAtR: 1 } },
} as const;

/**
 * The engine in miniature: submits the bracket at the range close, moves the stop to breakeven when the
 * plan says so, cancels an unfilled entry at the last entry minute, and flattens at the flatten minute.
 * Everything it does happens inside a bar handler, so it rests until the next bar, as at a real broker.
 */
async function driveThroughAdapter(
  plan: TradePlan,
  path: Parameters<typeof generatePath>[0],
): Promise<{
  fills: Fill[];
  orders: Order[];
  cash: number;
  exitLeg: string | null;
  breakevenMoved: boolean;
}> {
  const adapter = new SyntheticAdapter({
    session: SESSION,
    symbols: [{ symbol: "SYN", path }],
    costModel: DEFAULT_COST_MODEL,
    startingCash: CASH,
  });
  const bars = (adapter.data.paths.get("SYN") as { bars: readonly Bar[] }).bars;
  const built = buildBracket({ plan, shares: SHARES });
  if (!built.ok) {
    throw new Error(`bracket refused: ${built.reasons.join(", ")}`);
  }
  const order: BracketOrder = built.order;
  const fills: Fill[] = [];
  const orders: Order[] = [];
  let entryId: string | null = null;
  let stopLossId: string | null = null;
  let breakevenMoved = false;
  let entered = false;
  let closed = false;
  const long = plan.signal.direction === "long";
  const risk = long ? plan.signal.entry - plan.stop : plan.stop - plan.signal.entry;
  const breakevenTrigger =
    plan.management.breakevenAtR === null
      ? null
      : long
        ? plan.signal.entry + Math.ceil((risk * plan.management.breakevenAtR) / 10_000)
        : plan.signal.entry - Math.ceil((risk * plan.management.breakevenAtR) / 10_000);

  adapter.execution.on("fill", (fill) => fills.push(fill));
  // Ids come from the broker's own updates, as a real engine would learn them, replacements included.
  adapter.execution.on("orderUpdate", (update) => {
    orders.push(update);
    if (update.leg === "entry" && update.status === "accepted") {
      entryId = update.id;
    }
    if (update.leg === "entry" && update.status === "filled") {
      entered = true;
    }
    if (update.leg === "stopLoss" && update.status === "accepted") {
      stopLossId = update.id;
    }
    if (update.leg !== "entry" && update.status === "filled") {
      closed = true;
    }
  });
  await adapter.connect();
  await adapter.data.subscribe(["SYN"]);

  adapter.data.on("bar", (bar) => {
    const minute = bar.minuteOfSession;
    const next = bars.find((b) => b.minuteOfSession > minute);
    if (minute === plan.signal.minuteOfSession) {
      void adapter.execution.submitBracket(order);
    }
    if (entered && !closed && breakevenTrigger !== null && !breakevenMoved) {
      const reached = long ? bar.high >= breakevenTrigger : bar.low <= breakevenTrigger;
      if (reached) {
        breakevenMoved = true;
        void adapter.execution.replace(stopLossId as string, { stopPrice: plan.signal.entry });
      }
    }
    const lastBefore = (limit: number): boolean =>
      minute < limit && (next === undefined || next.minuteOfSession >= limit);
    if (!entered && entryId !== null && lastBefore(LAST_ENTRY_MINUTE)) {
      void adapter.execution.cancel(entryId);
    }
    if (entered && !closed && lastBefore(FLATTEN_MINUTE)) {
      void adapter.execution.flattenAll();
    }
  });
  await adapter.replay();
  const account = await adapter.execution.getAccount();
  const exit = fills[1];
  const exitLeg = exit === undefined ? null : (orders.find((o) => o.id === exit.orderId) as Order).leg;
  return { fills, orders, cash: account.cash, exitLeg, breakevenMoved };
}

function orbPlan(bars: readonly Bar[], params: Record<string, unknown>, dailyAtr: number): TradePlan | null {
  const setup = loadSetup(orbSetupDefinition, { allowShort: true, ...params });
  const range = bars.filter((bar) => bar.minuteOfSession < 5);
  const last = range.at(-1) as Bar;
  const state: SymbolState = {
    symbol: "SYN",
    session: SESSION,
    minuteOfSession: last.minuteOfSession,
    lastClose: last.close,
    dailyAtr: fixed(dailyAtr),
    rsi: null,
    sessionVwap: null,
    openingRvol: ratio(20_000),
    runningRvol: null,
  };
  const signal: SetupSignal | null = setup.detectTrigger(state, range, null);
  return signal === null ? null : planTrade(setup, signal, state);
}

describe("the simulated broker agrees with the trade simulator on the same bars", () => {
  const seeds = Array.from({ length: 25 }, (_, i) => i + 1);
  const scenarios: readonly Scenario[] = ["driftlessWalk", ...SCRIPTED_SCENARIOS];

  for (const scenario of scenarios) {
    for (const [variant, params] of Object.entries(VARIANTS)) {
      it(`${scenario}, ${variant} exit`, async () => {
        let compared = 0;
        let exits: Record<string, number> = {};
        for (const seed of seeds) {
          const stopDistance = 1_500;
          const path = {
            ...DEFAULT_PATH_CONFIG,
            scenario,
            seed,
            volatilityBps: scenario === "driftlessWalk" ? 60 : DEFAULT_PATH_CONFIG.volatilityBps,
            stopDistance: fixed(stopDistance),
          };
          const generated = generatePath({ ...path, session: SESSION });
          const plan = orbPlan(generated.bars, params, stopDistance * 10);
          if (plan === null) {
            continue;
          }
          const expected = simulateTrade(plan, generated.bars, {
            shares: SHARES,
            costModel: DEFAULT_COST_MODEL,
            lastEntryMinute: LAST_ENTRY_MINUTE,
            flattenMinute: FLATTEN_MINUTE,
          });
          const actual = await driveThroughAdapter(plan, path);
          const where = `${scenario} ${variant} seed ${String(seed)}`;
          if (!expected.filled) {
            expect(actual.fills, where).toEqual([]);
            expect(actual.cash, where).toBe(CASH);
            continue;
          }
          compared += 1;
          exits = { ...exits, [expected.exitReason]: (exits[expected.exitReason] ?? 0) + 1 };
          expect(actual.fills.length, where).toBe(2);
          const [entry, exit] = actual.fills as [Fill, Fill];
          expect(entry.price, where).toBe(expected.entryFill);
          expect(entry.at, where).toBe(labelClock(SESSION, expected.entryMinute));
          expect(exit.price, where).toBe(expected.exitFill);
          expect(exit.at, where).toBe(labelClock(SESSION, expected.exitMinute));
          const legFor = {
            stop: "stopLoss",
            breakevenStop: "stopLoss",
            target: "takeProfit",
            eod: "flatten",
          } as const;
          expect(actual.exitLeg, where).toBe(legFor[expected.exitReason]);
          expect(actual.breakevenMoved, where).toBe(
            expected.exitReason === "breakevenStop" || (variant === "target" && actual.breakevenMoved),
          );
          expect(actual.cash - CASH, where).toBe(expected.netPnl);
        }
        expect(compared).toBeGreaterThan(5);
        if (scenario === "driftlessWalk") {
          expect(Object.keys(exits).length).toBeGreaterThan(1);
        }
      });
    }
  }

  it("covers every exit reason and both directions across the runs", async () => {
    const reasons = new Set<string>();
    const directions = new Set<string>();
    for (let seed = 1; seed <= 60; seed += 1) {
      const path = { ...DEFAULT_PATH_CONFIG, scenario: "driftlessWalk" as const, seed, volatilityBps: 60 };
      const generated = generatePath({ ...path, session: SESSION });
      const plan = orbPlan(generated.bars, VARIANTS.target, 15_000);
      if (plan === null) {
        continue;
      }
      const expected = simulateTrade(plan, generated.bars, {
        shares: SHARES,
        costModel: DEFAULT_COST_MODEL,
        lastEntryMinute: LAST_ENTRY_MINUTE,
        flattenMinute: FLATTEN_MINUTE,
      });
      if (expected.filled) {
        reasons.add(expected.exitReason);
        directions.add(plan.signal.direction);
        const actual = await driveThroughAdapter(plan, path);
        expect(actual.cash - CASH).toBe(expected.netPnl);
      }
    }
    // EOD exits are covered by the eod-variant runs above, where the flatten is the only way out.
    expect([...reasons].sort()).toEqual(["breakevenStop", "stop", "target"]);
    expect([...directions].sort()).toEqual(["long", "short"]);
  });
});

describe("SimulatedExecution orders", () => {
  const bracket: BracketOrder = {
    clientOrderId: "orb-SYN-20260105-abc",
    symbol: "SYN",
    side: "buy",
    quantity: 10,
    timeInForce: "day",
    orderClass: "bracket",
    entry: { type: "stop", stopPrice: fixed(203_000) },
    stopLoss: { stopPrice: fixed(199_500) },
    takeProfit: { limitPrice: fixed(210_000) },
  };
  const broker = () =>
    new SimulatedExecution({
      costModel: DEFAULT_COST_MODEL,
      startingCash: CASH,
      clock: labelClock,
      start: { session: SESSION, minuteOfSession: 0 },
    });
  const bar = (minute: number, open: number, high: number, low: number, close: number) => ({
    symbol: "SYN",
    session: SESSION,
    minuteOfSession: minute,
    open: fixed(open),
    high: fixed(high),
    low: fixed(low),
    close: fixed(close),
    volume: 1_000,
    vwap: null,
    closed: true,
  });

  it("accepts a bracket as three legs, the exits held until the entry fills", async () => {
    const b = broker();
    const legs = await b.submitBracket(bracket);
    expect(legs.map((leg) => [leg.leg, leg.status])).toEqual([
      ["entry", "accepted"],
      ["stopLoss", "new"],
      ["takeProfit", "new"],
    ]);
    expect((await b.getOpenOrders()).length).toBe(3);
    expect(await b.getPositions()).toMatchObject([
      { state: "pendingEntry", quantity: 0, averageEntryPrice: 203_000 },
    ]);
    // A working entry holds nothing, so it marks nothing and commits no buying power yet.
    expect(await b.getAccount()).toMatchObject({ equity: CASH, cash: CASH, buyingPower: CASH });
  });

  it("is idempotent on clientOrderId", async () => {
    const b = broker();
    const first = await b.submitBracket(bracket);
    const second = await b.submitBracket({ ...bracket, quantity: 99 });
    expect(second).toEqual(first);
    expect((await b.getOpenOrders()).length).toBe(3);
  });

  it("fills the entry, activates the exits, marks the position, and books the cash", async () => {
    const b = broker();
    const events: string[] = [];
    b.on("orderUpdate", (o) => events.push(`${o.leg}:${o.status}`));
    b.on("fill", (f) => events.push(`fill:${f.side}@${String(f.price)}`));
    await b.submitBracket(bracket);
    events.length = 0;
    b.onBar(bar(5, 202_500, 203_500, 202_400, 203_300));
    // The ask is the trigger plus a 102 half-spread, and the stop-entry allowance is 10 bps of that, 204.
    expect(events).toEqual(["entry:filled", "fill:buy@203306", "stopLoss:accepted", "takeProfit:accepted"]);
    const [position] = await b.getPositions();
    expect(position).toMatchObject({
      state: "open",
      quantity: 10,
      averageEntryPrice: 203_306,
      stopPrice: 199_500,
      takeProfitPrice: 210_000,
      marketValue: 2_033_000,
      unrealizedPnl: -60,
    });
    const account = await b.getAccount();
    expect(account.cash).toBe(CASH - 2_033_060);
    expect(account.equity).toBe(CASH - 60);
    expect(account.buyingPower).toBe(CASH - 60 - 2_033_000);
  });

  it("cancels the whole bracket when the entry is canceled, and reports a terminal cancel unchanged", async () => {
    const b = broker();
    const [entry] = await b.submitBracket(bracket);
    const canceled = await b.cancel((entry as Order).id);
    expect(canceled.status).toBe("canceled");
    expect(await b.getOpenOrders()).toEqual([]);
    expect(await b.getPositions()).toEqual([]);
    expect((await b.cancel((entry as Order).id)).status).toBe("canceled");
  });

  it("replaces a working stop and retires the original", async () => {
    const b = broker();
    const [, stopLoss] = await b.submitBracket(bracket);
    b.onBar(bar(5, 202_500, 203_500, 202_400, 203_300));
    const replacement = await b.replace((stopLoss as Order).id, { stopPrice: fixed(203_000) });
    expect(replacement).toMatchObject({
      leg: "stopLoss",
      status: "accepted",
      stopPrice: 203_000,
      replaces: (stopLoss as Order).id,
    });
    const open = await b.getOpenOrders();
    expect(open.map((o) => o.id)).toContain(replacement.id);
    expect(open.map((o) => o.id)).not.toContain((stopLoss as Order).id);
    expect((await b.getPositions())[0]?.stopPrice).toBe(203_000);
    b.onBar(bar(6, 203_200, 203_400, 202_900, 203_100));
    expect(await b.getPositions()).toEqual([]);
    await expect(b.replace(replacement.id, { stopPrice: fixed(1) })).rejects.toMatchObject({
      code: "ORDER_NOT_OPEN",
    });
  });

  it("refuses to replace an unknown, terminal, or flatten order, or to grow one", async () => {
    const b = broker();
    await expect(b.replace("nope", {})).rejects.toBeInstanceOf(AdapterError);
    await expect(b.cancel("nope")).rejects.toMatchObject({ code: "UNKNOWN_ORDER" });
    const [entry] = await b.submitBracket(bracket);
    await expect(b.replace((entry as Order).id, { quantity: 11 })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    b.onBar(bar(5, 202_500, 203_500, 202_400, 203_300));
    const [flatten] = await b.flattenAll();
    await expect(b.replace((flatten as Order).id, {})).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("flattens at the next open, cancels the exits, and does nothing the second time", async () => {
    const b = broker();
    await b.submitBracket(bracket);
    b.onBar(bar(5, 202_500, 203_500, 202_400, 203_300));
    const flattens = await b.flattenAll();
    expect(flattens.map((o) => [o.leg, o.side, o.quantity, o.status])).toEqual([
      ["flatten", "sell", 10, "accepted"],
    ]);
    expect((await b.getPositions())[0]?.state).toBe("exiting");
    expect(await b.flattenAll()).toEqual([]);
    const fills: Fill[] = [];
    b.on("fill", (f) => fills.push(f));
    b.onBar(bar(6, 204_000, 204_500, 203_800, 204_200));
    // The bid is the open less a 102 half-spread, and the market allowance is one tick.
    expect(fills.map((f) => [f.side, f.price])).toEqual([["sell", 203_798]]);
    expect(await b.getPositions()).toEqual([]);
    expect(await b.getOpenOrders()).toEqual([]);
  });

  it("cancels a pending bracket on flattenAll and lets a canceled flatten leave the position open", async () => {
    const b = broker();
    await b.submitBracket(bracket);
    expect(await b.flattenAll()).toEqual([]);
    expect(await b.getOpenOrders()).toEqual([]);
    const c = broker();
    await c.submitBracket(bracket);
    c.onBar(bar(5, 202_500, 203_500, 202_400, 203_300));
    const [flatten] = await c.flattenAll();
    await c.cancel((flatten as Order).id);
    expect((await c.getPositions())[0]?.state).toBe("open");
    expect(await c.flattenAll()).toHaveLength(1);
  });

  it("fills a limit entry at its limit and a market entry at the open, and mirrors a short", async () => {
    const b = broker();
    await b.submitBracket({
      ...bracket,
      clientOrderId: "lim",
      entry: { type: "limit", limitPrice: fixed(202_000) },
    });
    await b.submitBracket({ ...bracket, clientOrderId: "mkt", entry: { type: "market" } });
    await b.submitBracket({
      ...bracket,
      clientOrderId: "sht",
      side: "sell",
      entry: { type: "stop", stopPrice: fixed(201_000) },
      stopLoss: { stopPrice: fixed(204_500) },
      takeProfit: { limitPrice: fixed(195_000) },
    });
    const fills: Fill[] = [];
    b.on("fill", (f) => fills.push(f));
    b.onBar(bar(5, 202_500, 203_500, 200_900, 203_300));
    expect(fills.map((f) => [f.clientOrderId, f.side, f.price])).toEqual([
      ["lim", "buy", 202_201],
      ["mkt", "buy", 202_702],
      ["sht", "sell", 200_698],
    ]);
    b.onBar(bar(6, 203_000, 205_000, 202_900, 204_800));
    const short = fills.find((f) => f.clientOrderId === "sht" && f.side === "buy");
    // The short's stop at 204_500: ask 204_603 plus the stop-exit allowance of 205.
    expect(short?.price).toBe(204_808);
  });

  it("rejects a bad cost model or starting cash at construction", () => {
    expect(
      () =>
        new SimulatedExecution({
          costModel: {
            ...DEFAULT_COST_MODEL,
            slippage: { ...DEFAULT_COST_MODEL.slippage, market: { bps: ratio(0), ticks: 0 } },
          },
          startingCash: CASH,
          clock: labelClock,
          start: { session: SESSION, minuteOfSession: 0 },
        }),
    ).toThrow();
    expect(
      () =>
        new SimulatedExecution({
          costModel: DEFAULT_COST_MODEL,
          startingCash: fixed(0),
          clock: labelClock,
          start: { session: SESSION, minuteOfSession: 0 },
        }),
    ).toThrow(AdapterError);
  });

  it("replaces the take-profit's limit and the entry's trigger, each on its own leg", async () => {
    const b = broker();
    const [entry, , takeProfit] = (await b.submitBracket(bracket)) as [Order, Order, Order];
    const movedEntry = await b.replace(entry.id, { stopPrice: fixed(204_000), limitPrice: fixed(1) });
    expect(movedEntry).toMatchObject({
      leg: "entry",
      stopPrice: 204_000,
      limitPrice: null,
      replaces: entry.id,
    });
    b.onBar(bar(5, 202_500, 203_500, 202_400, 203_300));
    expect(await b.getPositions()).toMatchObject([{ state: "pendingEntry", averageEntryPrice: 204_000 }]);
    b.onBar(bar(6, 203_500, 204_200, 203_400, 204_100));
    const movedTarget = await b.replace(takeProfit.id, { limitPrice: fixed(205_000), stopPrice: fixed(1) });
    expect(movedTarget).toMatchObject({ leg: "takeProfit", limitPrice: 205_000, stopPrice: null });
    // A resize alone keeps the prices.
    const resized = await b.replace(movedTarget.id, { quantity: 5 });
    expect(resized).toMatchObject({ quantity: 5, limitPrice: 205_000 });
    const stop = (await b.getOpenOrders()).find((o) => o.leg === "stopLoss") as Order;
    expect(await b.replace(stop.id, { quantity: 5 })).toMatchObject({ quantity: 5, stopPrice: 199_500 });
    expect((await b.getPositions())[0]?.takeProfitPrice).toBe(205_000);
    const fills: Fill[] = [];
    b.on("fill", (f) => fills.push(f));
    b.onBar(bar(7, 204_100, 205_500, 204_000, 205_200));
    expect(fills.map((f) => [f.orderId, f.quantity])).toEqual([[resized.id, 5]]);
    expect(await b.flattenAll()).toEqual([]);
  });

  it("leaves a position unprotected when its exit legs are canceled, and never fills them after", async () => {
    const b = broker();
    const [, stopLoss, takeProfit] = (await b.submitBracket(bracket)) as [Order, Order, Order];
    b.onBar(bar(5, 202_500, 203_500, 202_400, 203_300));
    await b.cancel(takeProfit.id);
    await b.cancel(stopLoss.id);
    expect((await b.getPositions())[0]).toMatchObject({
      state: "open",
      stopPrice: null,
      takeProfitPrice: null,
    });
    const fills: Fill[] = [];
    b.on("fill", (f) => fills.push(f));
    b.onBar(bar(6, 203_000, 211_000, 198_000, 205_000));
    expect(fills).toEqual([]);
    expect((await b.getPositions())[0]?.state).toBe("open");
  });

  it("ends a session: a working entry expires with its exits, an open position exits at its last close", async () => {
    const b = broker();
    await b.submitBracket(bracket);
    await b.submitBracket({
      ...bracket,
      clientOrderId: "never",
      entry: { type: "stop", stopPrice: fixed(250_000) },
    });
    await b.submitBracket({
      ...bracket,
      clientOrderId: "other",
      symbol: "OTH",
      entry: { type: "market" },
      stopLoss: { stopPrice: fixed(40_000) },
      takeProfit: { limitPrice: fixed(60_000) },
    });
    expect(b.activeSymbols()).toEqual(["OTH", "SYN"]);
    b.onBar(bar(5, 202_500, 203_500, 202_400, 203_300));
    b.onBar({ ...bar(5, 50_000, 50_500, 49_900, 50_200), symbol: "OTH" });
    b.onBar(bar(6, 203_300, 204_000, 203_100, 203_900));
    const updates: Order[] = [];
    const fills: Fill[] = [];
    b.on("orderUpdate", (o) => updates.push(o));
    b.on("fill", (f) => fills.push(f));
    const end = b.endSession({ session: SESSION, minuteOfSession: 390 });
    // Each exits at the close of the last bar its own symbol printed, at the market allowance.
    expect(fills.map((f) => [f.clientOrderId, f.side, f.price, f.at])).toEqual([
      [bracket.clientOrderId, "sell", 203_698, labelClock(SESSION, 6)],
      ["other", "sell", 50_050, labelClock(SESSION, 5)],
    ]);
    expect(end.closed.map((o) => [o.clientOrderId, o.leg, o.status])).toEqual([
      [bracket.clientOrderId, "flatten", "filled"],
      ["other", "flatten", "filled"],
    ]);
    expect(end.expired.map((o) => [o.clientOrderId, o.leg, o.status])).toEqual([
      ["never", "entry", "expired"],
    ]);
    expect(updates.filter((o) => o.clientOrderId === "never").map((o) => [o.leg, o.status])).toEqual([
      ["entry", "expired"],
      ["stopLoss", "expired"],
      ["takeProfit", "expired"],
    ]);
    expect(await b.getOpenOrders()).toEqual([]);
    expect(await b.getPositions()).toEqual([]);
    expect(b.activeSymbols()).toEqual([]);
    expect(b.now).toBe(labelClock(SESSION, 390));
    expect(b.endSession({ session: SESSION, minuteOfSession: 390 })).toEqual({ closed: [], expired: [] });
  });

  it("tells what each fill acted at before costs and which allowance priced it", async () => {
    const b = broker();
    const fills: Fill[] = [];
    b.on("fill", (f) => fills.push(f));
    await b.submitBracket(bracket);
    await b.submitBracket({ ...bracket, clientOrderId: "held", takeProfit: null });
    // Gaps through the 203_000 trigger: both entries act at the open.
    b.onBar(bar(5, 203_500, 204_000, 203_400, 203_900));
    b.onBar(bar(6, 204_000, 210_500, 203_900, 210_000));
    await b.flattenAll();
    b.onBar(bar(7, 209_000, 209_500, 208_000, 208_500));
    expect(fills.map((f) => [f.clientOrderId, b.fillBasis(f.id)])).toEqual([
      [bracket.clientOrderId, { reference: 203_500, kind: "stopEntry" }],
      ["held", { reference: 203_500, kind: "stopEntry" }],
      // The take-profit acts at its limit, never better, at the market allowance.
      [bracket.clientOrderId, { reference: 210_000, kind: "market" }],
      ["held", { reference: 209_000, kind: "market" }],
    ]);
    expect(fills.every((f) => f.price !== b.fillBasis(f.id)?.reference)).toBe(true);
    expect(b.fillBasis("fill-99")).toBeUndefined();
  });

  it("fills a flatten still waiting for a bar at the close, the same as a flatten the close forced", async () => {
    const waiting = broker();
    const forced = broker();
    for (const b of [waiting, forced]) {
      await b.submitBracket(bracket);
      b.onBar(bar(5, 202_500, 203_500, 202_400, 203_300));
    }
    const [flatten] = await waiting.flattenAll();
    const fromWaiting = waiting.endSession({ session: SESSION, minuteOfSession: 390 });
    const fromForced = forced.endSession({ session: SESSION, minuteOfSession: 390 });
    expect(fromWaiting.closed.map((o) => o.id)).toEqual([(flatten as Order).id]);
    expect(fromWaiting.closed[0]?.averageFillPrice).toBe(fromForced.closed[0]?.averageFillPrice);
    expect((await waiting.getAccount()).cash).toBe((await forced.getAccount()).cash);
  });

  it("never lets an order placed while a bar is being handed out fill on that bar", async () => {
    const b = broker();
    b.on("fill", (f) => {
      if (f.clientOrderId === bracket.clientOrderId && f.side === "buy") {
        void b.submitBracket({ ...bracket, clientOrderId: "reentry", entry: { type: "market" } });
      }
    });
    await b.submitBracket(bracket);
    b.onBar(bar(5, 202_500, 203_500, 202_400, 203_300));
    expect((await b.getPositions()).map((p) => [p.clientOrderId, p.state])).toEqual([
      [bracket.clientOrderId, "open"],
      ["reentry", "pendingEntry"],
    ]);
  });

  it("holds and marks a short, pending and open, and fills a short limit entry", async () => {
    const b = broker();
    await b.submitBracket({
      ...bracket,
      clientOrderId: "short-limit",
      side: "sell",
      orderClass: "oto",
      entry: { type: "limit", limitPrice: fixed(203_000) },
      stopLoss: { stopPrice: fixed(205_000) },
      takeProfit: null,
    });
    await b.submitBracket({ ...bracket, clientOrderId: "market-later", entry: { type: "market" } });
    expect((await b.getPositions()).map((p) => [p.direction, p.state, p.averageEntryPrice])).toEqual([
      ["short", "pendingEntry", 203_000],
      ["long", "pendingEntry", 0],
    ]);
    b.onBar(bar(5, 202_500, 203_500, 202_400, 203_300));
    const positions = await b.getPositions();
    const short = positions.find((p) => p.direction === "short");
    // Sold at the limit less the half-spread less one tick, marked at the close.
    expect(short).toMatchObject({
      state: "open",
      quantity: 10,
      averageEntryPrice: 202_798,
      marketValue: -2_033_000,
    });
    expect(short?.unrealizedPnl).toBe((202_798 - 203_300) * 10);
    const account = await b.getAccount();
    const longValue = 2_033_000;
    expect(account.equity).toBe(account.cash + longValue - 2_033_000);
    expect(account.buyingPower).toBe(Math.max(account.equity - 2 * 2_033_000, 0));
  });
});
