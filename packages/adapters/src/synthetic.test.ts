import { describe, expect, it } from "vitest";
import type { BracketOrder } from "@trader/contracts";
import { fixed } from "@trader/contracts";
import { DEFAULT_COST_MODEL, DEFAULT_PATH_CONFIG } from "@trader/core";
import { AdapterError } from "./adapter.js";
import { labelClock } from "./clock.js";
import { SyntheticAdapter } from "./synthetic.js";

const SESSION = "2026-01-05";

function adapter(minutes = 390): SyntheticAdapter {
  return new SyntheticAdapter({
    session: SESSION,
    symbols: [
      { symbol: "AAA", path: { ...DEFAULT_PATH_CONFIG, scenario: "driftlessWalk", seed: 1, minutes } },
      { symbol: "BBB", path: { ...DEFAULT_PATH_CONFIG, scenario: "haltAndReopen", seed: 2, minutes } },
    ],
    costModel: DEFAULT_COST_MODEL,
    startingCash: fixed(1_000_000_000),
  });
}

describe("labelClock", () => {
  it("labels minutes from 13:30Z", () => {
    expect(labelClock("2026-01-05", 0)).toBe("2026-01-05T13:30:00.000Z");
    expect(labelClock("2026-01-05", 389)).toBe("2026-01-05T19:59:00.000Z");
  });
});

describe("SyntheticAdapter", () => {
  it("replays every symbol's bars in time order, the broker before the engine", async () => {
    const a = adapter(60);
    const seen: string[] = [];
    await a.connect();
    await a.data.subscribe(["AAA", "BBB"]);
    a.data.on("bar", (bar) => seen.push(`${bar.symbol}@${String(bar.minuteOfSession)}`));
    a.data.on("quote", (event) => {
      expect(event.at).toBe(labelClock(SESSION, Number(seen.at(-1)?.split("@")[1])));
      expect(event.quote.ask).toBeGreaterThan(event.quote.bid);
    });
    expect(a.remaining).toBeGreaterThan(100);
    await a.replay();
    expect(a.remaining).toBe(0);
    expect(seen.slice(0, 4)).toEqual(["AAA@0", "BBB@0", "AAA@1", "BBB@1"]);
    // BBB halts after its breakout bar, so for a stretch only AAA's bars arrive.
    const minutes = seen.map((s) => Number(s.split("@")[1]));
    expect(minutes.every((m, i) => i === 0 || m >= (minutes[i - 1] as number))).toBe(true);
    expect(seen.filter((s) => s.startsWith("BBB")).length).toBeLessThan(
      seen.filter((s) => s.startsWith("AAA")).length,
    );
    expect(a.now).toBe(labelClock(SESSION, 59));
  });

  it("raises events only for subscribed symbols, but the broker sees every bar", async () => {
    const a = adapter(60);
    const seen = new Set<string>();
    await a.connect();
    await a.data.subscribe(["AAA", "BBB"]);
    await a.data.unsubscribe(["BBB", "ZZZ"]);
    expect(a.data.subscriptions()).toEqual(["AAA"]);
    a.data.on("bar", (bar) => seen.add(bar.symbol));
    const order: BracketOrder = {
      clientOrderId: "bbb-entry",
      symbol: "BBB",
      side: "buy",
      quantity: 1,
      timeInForce: "day",
      orderClass: "oto",
      entry: { type: "market" },
      stopLoss: { stopPrice: fixed(10_000) },
      takeProfit: null,
    };
    await a.execution.submitBracket(order);
    await a.replay();
    expect([...seen]).toEqual(["AAA"]);
    expect((await a.execution.getPositions()).map((p) => [p.symbol, p.state])).toEqual([["BBB", "open"]]);
  });

  it("serves historical minute bars by labeled instant and snapshots of what has replayed", async () => {
    const a = adapter(60);
    await a.connect();
    const early = await a.data.getHistoricalBars({
      symbol: "AAA",
      timeframe: "1Min",
      from: labelClock(SESSION, 0),
      to: labelClock(SESSION, 5),
    });
    expect(early.map((bar) => bar.minuteOfSession)).toEqual([0, 1, 2, 3, 4]);
    expect(early[0]?.symbol).toBe("AAA");
    expect(await a.data.getHistoricalBars({ symbol: "ZZZ", timeframe: "1Min", from: "", to: "9" })).toEqual(
      [],
    );
    await expect(
      a.data.getHistoricalBars({ symbol: "AAA", timeframe: "1Day", from: "", to: "9" }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(await a.data.getSnapshots(["AAA"])).toEqual([]);
    for (let i = 0; i < 6; i += 1) {
      a.step();
    }
    const [snapshot] = await a.data.getSnapshots(["AAA", "ZZZ"]);
    expect(snapshot).toMatchObject({ symbol: "AAA", asOf: labelClock(SESSION, 2) });
    expect(snapshot?.minuteBar?.minuteOfSession).toBe(2);
    expect(snapshot?.quote?.ask).toBeGreaterThanOrEqual(snapshot?.quote?.bid ?? 0);
    expect(await a.data.getNews({})).toEqual([]);
  });

  it("ranks the screener by volume replayed so far", async () => {
    const a = adapter(60);
    await a.connect();
    expect(await a.data.getScreener("mostActives", 5)).toEqual([]);
    await a.replay();
    const rows = await a.data.getScreener("mostActives", 5);
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(rows[0]?.volume).toBeGreaterThanOrEqual(rows[1]?.volume ?? 0);
    expect((await a.data.getScreener("mostActives", 1)).length).toBe(1);
    // Equal volumes rank by symbol, so two symbols on the same seed come back in name order.
    const twins = new SyntheticAdapter({
      session: SESSION,
      symbols: [
        { symbol: "ZED", path: { ...DEFAULT_PATH_CONFIG, scenario: "driftlessWalk", seed: 9, minutes: 60 } },
        { symbol: "ABE", path: { ...DEFAULT_PATH_CONFIG, scenario: "driftlessWalk", seed: 9, minutes: 60 } },
      ],
      costModel: DEFAULT_COST_MODEL,
      startingCash: fixed(1),
    });
    await twins.connect();
    await twins.replay();
    expect((await twins.data.getScreener("mostActives", 2)).map((r) => r.symbol)).toEqual(["ABE", "ZED"]);
  });

  it("requires connect before subscribing and rejects a symbol listed twice", async () => {
    const a = adapter(60);
    await expect(a.data.subscribe(["AAA"])).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    await a.close();
    expect(
      () =>
        new SyntheticAdapter({
          session: SESSION,
          symbols: [
            { symbol: "AAA", path: { ...DEFAULT_PATH_CONFIG, scenario: "driftlessWalk", seed: 1 } },
            { symbol: "AAA", path: { ...DEFAULT_PATH_CONFIG, scenario: "driftlessWalk", seed: 2 } },
          ],
          costModel: DEFAULT_COST_MODEL,
          startingCash: fixed(1),
        }),
    ).toThrow(AdapterError);
  });

  it("lets an async handler's work land before the next bar", async () => {
    const a = adapter(60);
    await a.connect();
    await a.data.subscribe(["AAA"]);
    const filledAt: number[] = [];
    a.execution.on("fill", (fill) => filledAt.push(Number(fill.at.slice(14, 16))));
    a.data.on("bar", (bar) => {
      if (bar.minuteOfSession === 10) {
        void Promise.resolve().then(() =>
          a.execution.submitBracket({
            clientOrderId: "late",
            symbol: "AAA",
            side: "buy",
            quantity: 1,
            timeInForce: "day",
            orderClass: "oto",
            entry: { type: "market" },
            stopLoss: { stopPrice: fixed(10_000) },
            takeProfit: null,
          }),
        );
      }
    });
    await a.replay();
    // Submitted after bar 10 through a promise, filled at the open of bar 11: 13:30 plus 11 minutes.
    expect(filledAt).toEqual([41]);
  });
});
