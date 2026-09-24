import { type SessionHours } from "@trader/adapters";
import { SCRIPTED_SCENARIOS, type Scenario } from "@trader/core";
import { describe, expect, it } from "vitest";
import { costModelFor } from "./config.js";
import type { TradeRecord } from "./records.js";
import { exitKindOf, reprice } from "./recost.js";
import { runBacktest } from "./run.js";
import { dependencies, halfDay, registrationFor, syntheticMarket, testConfig, weekdays } from "./testing.js";

const WARMUP = weekdays("2026-01-05", 20);
const SESSIONS: SessionHours[] = weekdays("2026-02-02", 5).map((h, i) => (i === 4 ? halfDay(h) : h));
const SYMBOLS = Array.from({ length: 12 }, (_, i) => `R${String(i).padStart(2, "0")}`);
const SCENARIOS: readonly Scenario[] = ["driftlessWalk", ...SCRIPTED_SCENARIOS];

async function filledTrades(): Promise<TradeRecord[]> {
  const market = syntheticMarket({
    symbols: SYMBOLS,
    warmup: WARMUP,
    sessions: SESSIONS,
    scenario: (symbol, session) =>
      SCENARIOS[
        (SYMBOLS.indexOf(symbol) + SESSIONS.findIndex((h) => h.session === session)) % SCENARIOS.length
      ] as Scenario,
  });
  const records: TradeRecord[] = [];
  await runBacktest(testConfig(), dependencies(market, registrationFor({ holdoutFrom: "2027-01-04" })), {
    onSession: (result) => void records.push(...result.records),
  });
  return records.filter((r) => r.entryOutcome === "filled");
}

describe("repricing a recorded trade", () => {
  const model = costModelFor(testConfig());

  it("reproduces every fill and net R the broker recorded, long and short, every way out", async () => {
    const trades = await filledTrades();
    expect(new Set(trades.map((t) => t.direction))).toEqual(new Set(["long", "short"]));
    expect(new Set(trades.map((t) => t.exitReason))).toEqual(
      new Set(["stop", "breakevenStop", "target", "flatten"]),
    );
    for (const trade of trades) {
      expect(reprice(trade, model), `${trade.variant} ${trade.symbol} ${trade.session}`).toEqual({
        entryFill: trade.entryFill,
        exitFill: trade.exitFill,
        netR: trade.netR,
      });
      expect(reprice(trade, model, { slippageScale: 1 })).toEqual(reprice(trade, model));
    }
  });

  it("costs more with dearer slippage and less with cheaper, both legs, never touching gross", async () => {
    const trades = await filledTrades();
    for (const trade of trades) {
      const [half, full, double] = [0.5, 1, 2].map((k) => reprice(trade, model, { slippageScale: k }));
      expect((half as { netR: number }).netR).toBeGreaterThanOrEqual((full as { netR: number }).netR);
      expect((double as { netR: number }).netR).toBeLessThan((full as { netR: number }).netR);
    }
  });

  it("takes a stop-entry allowance in basis points, with no tick floor, on the entry alone", async () => {
    const [trade] = (await filledTrades()).filter((t) => t.direction === "long");
    const t = trade as TradeRecord;
    const free = reprice(t, model, { stopEntryBps: 0 });
    const modeled = reprice(t, model);
    expect(free.exitFill).toBe(modeled.exitFill);
    // No slippage on the entry: it fills at the ask of the quote around its reference.
    expect(free.entryFill).toBeLessThan(modeled.entryFill);
    expect(reprice(t, model, { stopEntryBps: 500 }).netR).toBeLessThan(free.netR);
  });

  it("prices a protective stop as a stop exit and anything else as a market order", () => {
    expect(
      ["stop", "breakevenStop", "target", "flatten", "close"].map((r) => exitKindOf(r as never)),
    ).toEqual(["stopExit", "stopExit", "market", "market", "market"]);
  });

  it("refuses a trade that did not fill both ways", () => {
    expect(() => reprice({ exitReference: null } as TradeRecord, model)).toThrow(/did not fill both ways/);
  });
});
