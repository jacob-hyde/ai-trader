import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CostModelError,
  DEFAULT_COST_MODEL,
  assertCostModelConfig,
  modelFill,
  noCommission,
  quoteFromReference,
  roundTripCostPerShare,
  slippagePerShare,
  type CostModelConfig,
  type FillKind,
  type Quote,
  type Side,
} from "./costs.js";
import { MoneyError, fixed, fromNumber, ratio, type Fixed } from "./money.js";

const KINDS: readonly FillKind[] = ["market", "stopEntry", "stopExit"];
const SIDES: readonly Side[] = ["buy", "sell"];

const usd = fromNumber;
const quote = (bid: number, ask: number): Quote => ({ bid: usd(bid), ask: usd(ask) });

function withSlippage(kind: FillKind, bps: number, ticks: number): CostModelConfig {
  return {
    ...DEFAULT_COST_MODEL,
    slippage: { ...DEFAULT_COST_MODEL.slippage, [kind]: { bps: ratio(bps), ticks } },
  };
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CostModelError);
    expect((error as CostModelError).code).toBe(code);
    return;
  }
  throw new Error(`expected CostModelError ${code}`);
}

// Quotes at or above $1.00 with spreads up to $0.50, the domain the strategy trades in.
const quoteArb = fc
  .tuple(fc.integer({ min: 10_000, max: 5_000_000 }), fc.integer({ min: 0, max: 5_000 }))
  .map(([bid, width]): Quote => ({ bid: fixed(bid), ask: fixed(bid + width) }));
const sharesArb = fc.integer({ min: 1, max: 10_000 });
const kindArb = fc.constantFrom(...KINDS);
const sideArb = fc.constantFrom(...SIDES);

// Configs where both stop kinds exceed the market allowance in bps and in ticks.
const pessimisticConfigArb = fc
  .record({
    marketBps: fc.integer({ min: 0, max: 50 }),
    marketTicks: fc.integer({ min: 1, max: 5 }),
    extraBps: fc.integer({ min: 1, max: 100 }),
    extraTicks: fc.integer({ min: 1, max: 10 }),
  })
  .map(({ marketBps, marketTicks, extraBps, extraTicks }): CostModelConfig => {
    const stop = { bps: ratio(marketBps + extraBps), ticks: marketTicks + extraTicks };
    return {
      spread: DEFAULT_COST_MODEL.spread,
      slippage: { market: { bps: ratio(marketBps), ticks: marketTicks }, stopEntry: stop, stopExit: stop },
      commission: noCommission,
    };
  });

describe("DEFAULT_COST_MODEL", () => {
  it("passes its own validation", () => {
    expect(() => assertCostModelConfig(DEFAULT_COST_MODEL)).not.toThrow();
  });

  it("charges no commission", () => {
    expect(noCommission({ side: "sell", shares: 100, price: usd(20) })).toBe(0);
  });
});

describe("slippagePerShare", () => {
  it("takes the larger of bps and ticks", () => {
    // 2 bps of $20.02 is $0.004004, below one tick.
    expect(slippagePerShare(usd(20.02), { bps: ratio(2), ticks: 1 })).toBe(usd(0.01));
    // 10 bps of $20.02 is $0.02002, rounded up to $0.0201, above two ticks.
    expect(slippagePerShare(usd(20.02), { bps: ratio(10), ticks: 2 })).toBe(usd(0.0201));
  });

  it("uses the sub-penny tick below $1.00", () => {
    expect(slippagePerShare(usd(0.5), { bps: ratio(0), ticks: 3 })).toBe(usd(0.0003));
  });

  it("never decreases when either parameter grows", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 20 }),
        (price, bps, ticks, moreBps, moreTicks) => {
          const base = slippagePerShare(fixed(price), { bps: ratio(bps), ticks });
          const grown = slippagePerShare(fixed(price), {
            bps: ratio(bps + moreBps),
            ticks: ticks + moreTicks,
          });
          expect(grown).toBeGreaterThanOrEqual(base);
        },
      ),
    );
  });
});

describe("quoteFromReference", () => {
  it("centers the modeled spread on the reference", () => {
    // 10 bps of $20.00 is $0.02, above the one-tick floor.
    expect(quoteFromReference(usd(20), DEFAULT_COST_MODEL.spread)).toEqual(quote(19.99, 20.01));
  });

  it("falls back to the tick floor on cheap names", () => {
    // 10 bps of $5.00 is $0.005, below one tick.
    expect(quoteFromReference(usd(5), DEFAULT_COST_MODEL.spread)).toEqual(quote(4.995, 5.005));
  });

  it("rounds the half-spread up so the spread is never narrower than modeled", () => {
    fc.assert(
      fc.property(fc.integer({ min: 10_000, max: 5_000_000 }), (reference) => {
        const synthetic = quoteFromReference(fixed(reference), DEFAULT_COST_MODEL.spread);
        const modeled = Math.max(Math.ceil(reference / 1_000), 100);
        expect(synthetic.ask - synthetic.bid).toBeGreaterThanOrEqual(modeled);
        expect(synthetic.bid).toBeLessThan(reference);
        expect(synthetic.ask).toBeGreaterThan(reference);
      }),
    );
  });

  it("rejects a bad reference, a zero spread model, and a spread wider than the price", () => {
    expectCode(() => quoteFromReference(usd(0), DEFAULT_COST_MODEL.spread), "INVALID_QUOTE");
    expectCode(() => quoteFromReference(Number.NaN as Fixed, DEFAULT_COST_MODEL.spread), "INVALID_QUOTE");
    expectCode(() => quoteFromReference(usd(20), { bps: ratio(0), minTicks: 0 }), "INVALID_CONFIG");
    expectCode(() => quoteFromReference(usd(0.0001), { bps: ratio(0), minTicks: 2 }), "INVALID_QUOTE");
  });
});

describe("modelFill", () => {
  const q = quote(20.0, 20.02);

  it("fills a market buy at the ask plus the market allowance", () => {
    const fill = modelFill({ side: "buy", kind: "market", quote: q, shares: 100 }, DEFAULT_COST_MODEL);
    expect(fill.touch).toBe(usd(20.02));
    expect(fill.slippage).toBe(usd(0.01));
    expect(fill.price).toBe(usd(20.03));
    expect(fill.notional).toBe(usd(2003));
    expect(fill.commission).toBe(0);
    // $0.02 per share above the $20.01 midpoint.
    expect(fill.costVsMid).toBe(usd(2));
  });

  it("fills a stop entry at the ask plus the pessimistic allowance", () => {
    const fill = modelFill({ side: "buy", kind: "stopEntry", quote: q, shares: 25 }, DEFAULT_COST_MODEL);
    expect(fill.slippage).toBe(usd(0.0201));
    expect(fill.price).toBe(usd(20.0401));
  });

  it("fills a stop exit at the bid minus the pessimistic allowance", () => {
    const fill = modelFill({ side: "sell", kind: "stopExit", quote: q, shares: 25 }, DEFAULT_COST_MODEL);
    expect(fill.touch).toBe(usd(20));
    expect(fill.price).toBe(usd(19.98));
    // $0.03 per share below the $20.01 midpoint.
    expect(fill.costVsMid).toBe(usd(0.75));
  });

  it("keeps an odd spread exact and rounds the cost up", () => {
    // Midpoint is $20.00005. One share bought at $20.0101 gives up $0.01005, rounded up to $0.0101.
    const odd: Quote = { bid: usd(20), ask: usd(20.0001) };
    const fill = modelFill({ side: "buy", kind: "market", quote: odd, shares: 1 }, DEFAULT_COST_MODEL);
    expect(fill.costVsMid).toBe(usd(0.0101));
  });

  it("still charges slippage on a locked quote", () => {
    const fill = modelFill(
      { side: "sell", kind: "market", quote: quote(20, 20), shares: 10 },
      DEFAULT_COST_MODEL,
    );
    expect(fill.price).toBe(usd(19.99));
    expect(fill.costVsMid).toBe(usd(0.1));
  });

  it("adds the commission hook's result to the cost", () => {
    const config: CostModelConfig = {
      ...DEFAULT_COST_MODEL,
      commission: ({ side, shares }) => (side === "sell" ? fixed(shares * 2) : fixed(0)),
    };
    const sell = modelFill({ side: "sell", kind: "market", quote: q, shares: 100 }, config);
    expect(sell.commission).toBe(200);
    expect(sell.costVsMid).toBe(usd(2) + 200);
    const buy = modelFill({ side: "buy", kind: "market", quote: q, shares: 100 }, config);
    expect(buy.commission).toBe(0);
  });

  it("rejects a commission hook that returns a negative or non-integer amount", () => {
    const request = { side: "buy", kind: "market", quote: q, shares: 1 } as const;
    expectCode(
      () => modelFill(request, { ...DEFAULT_COST_MODEL, commission: () => -1 as Fixed }),
      "INVALID_COMMISSION",
    );
    expectCode(
      () => modelFill(request, { ...DEFAULT_COST_MODEL, commission: () => 0.5 as Fixed }),
      "INVALID_COMMISSION",
    );
  });

  it("rejects bad share counts", () => {
    for (const shares of [0, -1, 1.5, Number.NaN]) {
      expectCode(
        () => modelFill({ side: "buy", kind: "market", quote: q, shares }, DEFAULT_COST_MODEL),
        "INVALID_SHARES",
      );
    }
  });

  it("rejects a non-positive or non-integer quote and a crossed one", () => {
    const fill = (bad: Quote) => () =>
      modelFill({ side: "buy", kind: "market", quote: bad, shares: 1 }, DEFAULT_COST_MODEL);
    expectCode(fill({ bid: usd(0), ask: usd(1) }), "INVALID_QUOTE");
    expectCode(fill({ bid: Number.NaN as Fixed, ask: usd(1) }), "INVALID_QUOTE");
    expectCode(fill({ bid: usd(1), ask: Number.NaN as Fixed }), "INVALID_QUOTE");
    expect(fill(quote(20.02, 20.0))).toThrow(MoneyError);
  });

  it("rejects a sell whose slippage reaches the bid", () => {
    expectCode(
      () =>
        modelFill(
          { side: "sell", kind: "market", quote: { bid: usd(0.0001), ask: usd(0.0002) }, shares: 1 },
          DEFAULT_COST_MODEL,
        ),
      "NON_POSITIVE_FILL",
    );
  });

  it("is never free and never better than the touch", () => {
    fc.assert(
      fc.property(quoteArb, sharesArb, kindArb, sideArb, (anyQuote, shares, kind, side) => {
        const fill = modelFill({ side, kind, quote: anyQuote, shares }, DEFAULT_COST_MODEL);
        if (side === "buy") {
          expect(fill.price).toBeGreaterThan(anyQuote.ask);
        } else {
          expect(fill.price).toBeLessThan(anyQuote.bid);
        }
        expect(fill.costVsMid).toBeGreaterThan(0);
        expect(fill.notional).toBe(fill.price * shares);
      }),
    );
  });

  it("makes a stop entry strictly worse than a market fill for the same quote", () => {
    fc.assert(
      fc.property(quoteArb, sharesArb, sideArb, pessimisticConfigArb, (anyQuote, shares, side, config) => {
        const market = modelFill({ side, kind: "market", quote: anyQuote, shares }, config);
        const stopEntry = modelFill({ side, kind: "stopEntry", quote: anyQuote, shares }, config);
        if (side === "buy") {
          expect(stopEntry.price).toBeGreaterThan(market.price);
        } else {
          expect(stopEntry.price).toBeLessThan(market.price);
        }
        expect(stopEntry.costVsMid).toBeGreaterThan(market.costVsMid);
      }),
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(quoteArb, sharesArb, kindArb, sideArb, (anyQuote, shares, kind, side) => {
        const request = { side, kind, quote: anyQuote, shares };
        expect(modelFill(request, DEFAULT_COST_MODEL)).toEqual(modelFill(request, DEFAULT_COST_MODEL));
      }),
    );
  });
});

describe("roundTripCostPerShare", () => {
  it("adds the full spread and both slippage legs", () => {
    // $0.02 spread, $0.0201 stop entry, $0.01 market exit.
    expect(roundTripCostPerShare(quote(20.0, 20.02), "stopEntry", "market", DEFAULT_COST_MODEL)).toBe(
      usd(0.0501),
    );
  });

  it("validates its inputs", () => {
    expectCode(
      () => roundTripCostPerShare({ bid: usd(0), ask: usd(1) }, "market", "market", DEFAULT_COST_MODEL),
      "INVALID_QUOTE",
    );
    expectCode(
      () => roundTripCostPerShare(quote(20, 20.02), "market", "market", withSlippage("market", 0, 0)),
      "INVALID_CONFIG",
    );
  });

  it("is never below what modelFill charges for the same round trip, long or short", () => {
    fc.assert(
      fc.property(
        quoteArb,
        kindArb,
        kindArb,
        pessimisticConfigArb,
        (anyQuote, entryKind, exitKind, config) => {
          const estimate = roundTripCostPerShare(anyQuote, entryKind, exitKind, config);
          const buy = (kind: FillKind) =>
            modelFill({ side: "buy", kind, quote: anyQuote, shares: 1 }, config);
          const sell = (kind: FillKind) =>
            modelFill({ side: "sell", kind, quote: anyQuote, shares: 1 }, config);
          const longLoss = buy(entryKind).price - sell(exitKind).price;
          const shortLoss = buy(exitKind).price - sell(entryKind).price;
          expect(longLoss).toBeGreaterThan(anyQuote.ask - anyQuote.bid);
          expect(longLoss).toBeLessThanOrEqual(estimate);
          expect(shortLoss).toBeLessThanOrEqual(estimate);
        },
      ),
    );
  });
});

describe("assertCostModelConfig", () => {
  it("rejects a zero spread model or a zero allowance for any kind", () => {
    expectCode(
      () => assertCostModelConfig({ ...DEFAULT_COST_MODEL, spread: { bps: ratio(0), minTicks: 0 } }),
      "INVALID_CONFIG",
    );
    for (const kind of KINDS) {
      expectCode(() => assertCostModelConfig(withSlippage(kind, 0, 0)), "INVALID_CONFIG");
    }
  });

  it("rejects negative or non-integer parameters", () => {
    expectCode(() => assertCostModelConfig(withSlippage("market", -1, 1)), "INVALID_CONFIG");
    expectCode(() => assertCostModelConfig(withSlippage("market", 2, 0.5)), "INVALID_CONFIG");
    expectCode(
      () => assertCostModelConfig({ ...DEFAULT_COST_MODEL, spread: { bps: ratio(10), minTicks: -1 } }),
      "INVALID_CONFIG",
    );
  });

  it("rejects a stop entry that is not worse than a market fill", () => {
    expectCode(() => assertCostModelConfig(withSlippage("stopEntry", 1, 2)), "INVALID_CONFIG");
    expectCode(() => assertCostModelConfig(withSlippage("stopEntry", 10, 0)), "INVALID_CONFIG");
    expectCode(() => assertCostModelConfig(withSlippage("stopEntry", 2, 1)), "INVALID_CONFIG");
  });

  it("rejects a stop exit below the market allowance but allows it equal", () => {
    expectCode(() => assertCostModelConfig(withSlippage("stopExit", 1, 2)), "INVALID_CONFIG");
    expectCode(() => assertCostModelConfig(withSlippage("stopExit", 10, 0)), "INVALID_CONFIG");
    expect(() => assertCostModelConfig(withSlippage("stopExit", 2, 1))).not.toThrow();
  });

  it("accepts a stop entry that exceeds the market allowance in only one parameter", () => {
    expect(() => assertCostModelConfig(withSlippage("stopEntry", 2, 2))).not.toThrow();
    expect(() => assertCostModelConfig(withSlippage("stopEntry", 3, 1))).not.toThrow();
  });
});
