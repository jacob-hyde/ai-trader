import type { Fixed, Ratio } from "@trader/contracts";
import { describe, expect, it } from "vitest";
import { type MarketTape, type Signal, measureSignal, sampleSignals, summarize } from "./costCheck.js";
import { LATENCY_MS, type Print, type Quote, firstThrough } from "./fills.js";
import type { TradeRecord } from "./records.js";

const OPEN = Date.parse("2019-05-14T13:30:00Z");
const at = (minute: number, ms = 0) => OPEN + minute * 60_000 + ms;
const units = (dollars: number) => Math.round(dollars * 10_000) as Fixed;

/** A tape from lists, answering like the Alpaca one. */
function tape(prints: Print[], quotes: Quote[]): MarketTape & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    prints: (_symbol, from, to) => {
      asked.push(`prints ${String((from - OPEN) / 60_000)}`);
      return Promise.resolve(prints.filter((p) => p.at >= from && p.at < to));
    },
    quoteAt: (_symbol, time) => {
      asked.push(`quote ${String(time - OPEN)}`);
      return Promise.resolve([...quotes].reverse().find((q) => q.at <= time) ?? null);
    },
  };
}

function trade(exit: string, overrides: Partial<TradeRecord>): TradeRecord {
  return {
    variant: exit,
    symbol: "AMRX",
    session: "2019-05-14",
    direction: "long",
    rank: 3,
    entry: units(9.57),
    stop: units(9.17),
    target: units(10.37),
    gatePassed: true,
    entryOutcome: "filled",
    entryMinute: 10,
    entryReference: units(9.57),
    entryFill: units(9.595),
    ...overrides,
  } as TradeRecord;
}

describe("the first print that could trigger a stop", () => {
  it("skips odd lots and other reports that do not set the last sale", () => {
    const prints: Print[] = [
      { at: 1, price: 9.6, conditions: [" ", "I"] },
      { at: 2, price: 9.58, conditions: ["Z"] },
      { at: 3, price: 9.57, conditions: [" "] },
    ];
    expect(firstThrough(prints, 9.57, "up")?.at).toBe(3);
    expect(firstThrough(prints, 9.57, "down")?.at).toBe(3);
    expect(firstThrough(prints, 9.7, "up")).toBeNull();
  });
});

describe("pricing a signal from the market", () => {
  const prints: Print[] = [
    { at: at(10, 500), price: 9.43, conditions: [" "] },
    // The trigger: a print at the level, with the ask still under it.
    { at: at(10, 2_500), price: 9.57, conditions: [" "] },
    { at: at(93, 1_000), price: 9.2, conditions: [" "] },
    { at: at(93, 4_000), price: 9.16, conditions: [" "] },
  ];
  const quotes: Quote[] = [
    { at: at(10, 2_000), bid: 9.42, ask: 9.47 },
    { at: at(10, 2_700), bid: 9.44, ask: 9.48 },
    { at: at(93, 3_900), bid: 9.15, ask: 9.18 },
    { at: at(380, 100), bid: 9.9, ask: 9.93 },
  ];
  const signal: Signal = {
    symbol: "AMRX",
    session: "2019-05-14",
    openAt: OPEN,
    trades: {
      A: trade("A", {
        exitReason: "flatten",
        exitMinute: 380,
        exitFill: units(9.88),
        netR: 7_125 as Ratio,
        grossR: 8_000 as Ratio,
      }),
      B: trade("B", {
        exitReason: "stop",
        exitMinute: 93,
        exitFill: units(9.145),
        netR: -11_250 as Ratio,
        grossR: -10_000 as Ratio,
      }),
    },
  };

  it("fills the stop entry at the ask a moment after the trigger print, and each exit its own way", async () => {
    const t = tape(prints, quotes);
    const m = await measureSignal(t, signal);
    expect(m.risk).toBeCloseTo(0.4, 10);
    // Triggered at 2.5 s; the order reaches the market 250 ms later, where the ask is 9.48.
    expect(m.entry).toMatchObject({ modeled: 9.595, real: 9.48, why: null });
    // The flatten: the bid 250 ms into minute 380.
    expect(m.exits["A"]?.leg).toMatchObject({ modeled: 9.88, real: 9.9 });
    // The stop: first print at or under 9.17 is at 4 s, the bid then is 9.15.
    expect(m.exits["B"]?.leg).toMatchObject({ modeled: 9.145, real: 9.15 });
    expect(t.asked).toEqual([
      "prints 10",
      `quote ${String(10 * 60_000 + 2_500 + LATENCY_MS)}`,
      `quote ${String(380 * 60_000 + LATENCY_MS)}`,
      "prints 93",
      `quote ${String(93 * 60_000 + 4_000 + LATENCY_MS)}`,
    ]);
  });

  it("sums the sample: real against modeled net R and cost, per exit", async () => {
    const m = await measureSignal(tape(prints, quotes), signal);
    const s = summarize([m]);
    expect(s.sampled).toBe(1);
    expect(s.unmeasured).toEqual({});
    const [a, b] = s.exits;
    // A: (9.90 - 9.48) / 0.40 = 1.05R real against 0.7125R modeled; gross 0.8R.
    expect(a).toMatchObject({ exit: "A", measured: 1 });
    expect(a?.realNetR).toBeCloseTo(1.05, 10);
    expect(a?.modeledNetR).toBeCloseTo(0.7125, 10);
    expect(a?.realCostR).toBeCloseTo(0.8 - 1.05, 10);
    // B: (9.15 - 9.48) / 0.40 = -0.825R.
    expect(b?.realNetR).toBeCloseTo(-0.825, 10);
    expect(s.entryCostBps.real).toBeCloseTo(((9.48 - 9.57) / 9.57) * 10_000, 8);
    expect(s.entryCostBps.modeled).toBeCloseTo(((9.595 - 9.57) / 9.57) * 10_000, 8);
    expect(s.entrySpreadBps.median).toBeCloseTo((0.04 / 9.46) * 10_000, 8);
  });

  it("gives a stop on the entry bar only prints after the entry, and a target its limit", async () => {
    const sameBar: Signal = {
      ...signal,
      trades: {
        B: trade("B", {
          exitReason: "stop",
          exitMinute: 10,
          exitFill: units(9.145),
          netR: 0 as Ratio,
          grossR: 0 as Ratio,
        }),
        T: trade("T", {
          exitReason: "target",
          exitMinute: 200,
          exitFill: units(10.34),
          netR: 0 as Ratio,
          grossR: 0 as Ratio,
        }),
      },
    };
    const early: Print[] = [{ at: at(10, 100), price: 9.1, conditions: [" "] }, ...prints.slice(1)];
    const m = await measureSignal(tape(early, quotes), sameBar);
    // The 9.10 print came before the entry, so it cannot stop the trade out.
    expect(m.exits["B"]?.leg).toMatchObject({ real: null, why: "no trigger print" });
    expect(m.exits["T"]?.leg).toMatchObject({ real: 10.37, why: null });
    expect(summarize([m]).unmeasured).toEqual({ "exit B stop: no trigger print": 1 });
  });

  it("says why a leg could not be priced", async () => {
    const m = await measureSignal(tape([], quotes), signal);
    expect(m.entry).toMatchObject({ real: null, why: "no trigger print" });
    const quiet = await measureSignal(tape(prints, []), signal);
    expect(quiet.entry).toMatchObject({ real: null, why: "no quote" });
    expect(summarize([quiet]).exits.every((e) => e.measured === 0)).toBe(true);
  });
});

describe("the sample", () => {
  const signals = ["2016", "2017"].flatMap((year) =>
    Array.from({ length: 30 }, (_, i) => ({
      session: `${year}-03-${String((i % 28) + 1).padStart(2, "0")}`,
      symbol: `S${String(i)}`,
    })),
  );

  it("takes the same draw from each year for the same seed, whatever order the signals come in", () => {
    const picked = sampleSignals(signals, 5, 7);
    expect(picked).toHaveLength(10);
    expect(picked.filter((s) => s.session.startsWith("2016"))).toHaveLength(5);
    expect(sampleSignals([...signals].reverse(), 5, 7)).toEqual(picked);
    expect(sampleSignals(signals, 5, 8)).not.toEqual(picked);
    expect(sampleSignals(signals, 100, 7)).toHaveLength(60);
  });
});
