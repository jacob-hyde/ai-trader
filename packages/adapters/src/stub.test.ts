import { describe, expect, it } from "vitest";
import type { BracketOrder, Order } from "@trader/contracts";
import { fixed } from "@trader/contracts";
import { AdapterError } from "./adapter.js";
import { StubAdapter } from "./stub.js";

const bracket: BracketOrder = {
  clientOrderId: "orb-AAPL-20260921-50e967ae",
  symbol: "AAPL",
  side: "buy",
  quantity: 24,
  timeInForce: "day",
  orderClass: "bracket",
  entry: { type: "stop", stopPrice: fixed(203_000) },
  stopLoss: { stopPrice: fixed(199_500) },
  takeProfit: { limitPrice: fixed(210_000) },
};

describe("StubAdapter", () => {
  it("refuses to subscribe before connect and remembers subscriptions after", async () => {
    const adapter = new StubAdapter("paper");
    await expect(adapter.data.subscribe(["AAPL"])).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    await adapter.connect();
    await adapter.data.subscribe(["MSFT", "AAPL", "AAPL"]);
    expect(adapter.data.subscriptions()).toEqual(["AAPL", "MSFT"]);
    await adapter.data.unsubscribe(["AAPL", "NOPE"]);
    expect(adapter.data.subscriptions()).toEqual(["MSFT"]);
    await adapter.close();
    await expect(adapter.data.subscribe(["AAPL"])).rejects.toBeInstanceOf(AdapterError);
  });

  it("returns nothing from every data query", async () => {
    const adapter = new StubAdapter("backtest");
    const now = "2026-09-21T13:30:00.000Z";
    expect(
      await adapter.data.getHistoricalBars({ symbol: "AAPL", timeframe: "1Min", from: now, to: now }),
    ).toEqual([]);
    expect(await adapter.data.getSnapshots(["AAPL"])).toEqual([]);
    expect(await adapter.data.getScreener("mostActives", 10)).toEqual([]);
    expect(await adapter.data.getNews({})).toEqual([]);
  });

  it("lets a test push events to the engine", async () => {
    const adapter = new StubAdapter("paper");
    const seen: number[] = [];
    adapter.data.on("bar", (bar) => seen.push(bar.minuteOfSession));
    adapter.data.emit("bar", {
      symbol: "AAPL",
      session: "2026-09-21",
      minuteOfSession: 4,
      open: fixed(1),
      high: fixed(1),
      low: fixed(1),
      close: fixed(1),
      volume: 0,
      vwap: null,
      closed: true,
    });
    expect(seen).toEqual([4]);
    await adapter.close();
  });

  it("accepts a bracket idempotently and never fills it", async () => {
    const adapter = new StubAdapter("live");
    const updates: string[] = [];
    adapter.execution.on("orderUpdate", (o) => updates.push(`${o.leg}:${o.status}`));
    const legs = await adapter.execution.submitBracket(bracket);
    expect(legs.map((l) => l.leg)).toEqual(["entry", "stopLoss", "takeProfit"]);
    expect(await adapter.execution.submitBracket(bracket)).toEqual(legs);
    expect(updates).toEqual(["entry:accepted", "stopLoss:new", "takeProfit:new"]);
    expect(legs[0]).toMatchObject({ type: "stop", stopPrice: 203_000, limitPrice: null });
    const limitEntry = await adapter.execution.submitBracket({
      ...bracket,
      clientOrderId: "limit",
      orderClass: "oto",
      entry: { type: "limit", limitPrice: fixed(202_000) },
      takeProfit: null,
    });
    expect(limitEntry.map((l) => l.leg)).toEqual(["entry", "stopLoss"]);
    const short = await adapter.execution.submitBracket({ ...bracket, clientOrderId: "short", side: "sell" });
    expect(short.map((l) => l.side)).toEqual(["sell", "buy", "buy"]);
    expect(limitEntry[0]).toMatchObject({ type: "limit", limitPrice: 202_000, stopPrice: null });
    expect(await adapter.execution.getPositions()).toEqual([]);
    expect((await adapter.execution.getAccount()).equity).toBe(25_000_000);
  });

  it("cancels, replaces, and flattens its in-memory orders, and errors on unknown ids", async () => {
    const adapter = new StubAdapter("paper");
    const [entry, stopLoss] = (await adapter.execution.submitBracket(bracket)) as [Order, Order, Order];
    const replaced = await adapter.execution.replace(stopLoss.id, { stopPrice: fixed(203_000) });
    expect(replaced).toMatchObject({ replaces: stopLoss.id, stopPrice: 203_000, status: "accepted" });
    const resized = await adapter.execution.replace(replaced.id, { quantity: 10, limitPrice: fixed(1) });
    expect(resized).toMatchObject({ quantity: 10, limitPrice: 1, stopPrice: 203_000 });
    await expect(adapter.execution.replace(stopLoss.id, {})).rejects.toMatchObject({
      code: "ORDER_NOT_OPEN",
    });
    const canceled = await adapter.execution.cancel(entry.id);
    expect(canceled.status).toBe("canceled");
    expect((await adapter.execution.cancel(entry.id)).status).toBe("canceled");
    await expect(adapter.execution.cancel("nope")).rejects.toMatchObject({ code: "UNKNOWN_ORDER" });
    await expect(adapter.execution.replace("nope", {})).rejects.toMatchObject({ code: "UNKNOWN_ORDER" });
    expect(await adapter.execution.flattenAll()).toEqual([]);
    expect(await adapter.execution.getOpenOrders()).toEqual([]);
  });
});
