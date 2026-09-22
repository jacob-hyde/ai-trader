import { describe, expect, it } from "vitest";
import { RUN_MODES, fixed } from "@trader/contracts";
import type { Adapter, DataEvents, ExecutionEvents } from "@trader/adapters";
import { createAdapter } from "./adapters.js";

/** The engine's use of the interface, in miniature: connect, subscribe, submit, react to events, close. */
async function exercise(adapter: Adapter): Promise<string[]> {
  const log: string[] = [];
  adapter.data.on("bar", (bar: DataEvents["bar"]) =>
    log.push(`bar ${bar.symbol} ${String(bar.minuteOfSession)}`),
  );
  adapter.execution.on("orderUpdate", (order: ExecutionEvents["orderUpdate"]) =>
    log.push(`order ${order.leg} ${order.status}`),
  );
  await adapter.connect();
  await adapter.data.subscribe(["AAPL"]);
  const legs = await adapter.execution.submitBracket({
    clientOrderId: "orb-AAPL-20260921-50e967ae",
    symbol: "AAPL",
    side: "buy",
    quantity: 24,
    timeInForce: "day",
    orderClass: "oto",
    entry: { type: "stop", stopPrice: fixed(203_000) },
    stopLoss: { stopPrice: fixed(199_500) },
    takeProfit: null,
  });
  log.push(`legs ${String(legs.length)}`);
  log.push(`open ${String((await adapter.execution.getOpenOrders()).length)}`);
  log.push(`equity ${String((await adapter.execution.getAccount()).equity)}`);
  await adapter.execution.flattenAll();
  await adapter.close();
  return log;
}

describe("createAdapter", () => {
  it("returns an adapter for every run mode that the engine can drive end to end", async () => {
    for (const mode of RUN_MODES) {
      const adapter = createAdapter(mode);
      expect(adapter.mode).toBe(mode);
      expect(await exercise(adapter)).toEqual([
        "order entry accepted",
        "order stopLoss new",
        "legs 2",
        "open 2",
        "equity 25000000",
        "order entry canceled",
        "order stopLoss canceled",
      ]);
    }
  });
});
