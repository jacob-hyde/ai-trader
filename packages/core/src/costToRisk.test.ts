import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  COST_TO_RISK_BOUNDS,
  DEFAULT_COST_TO_RISK,
  assertCostToRiskConfig,
  evaluateCostToRisk,
  type CostToRiskConfig,
} from "./costToRisk.js";
import {
  CostModelError,
  DEFAULT_COST_MODEL,
  noCommission,
  roundTripCostPerShare,
  type CostModelConfig,
  type Quote,
} from "./costs.js";
import { fixed, fromNumber, ratio, type Fixed, type Ratio } from "./money.js";

const usd = fromNumber;
const quote = (bid: number, ask: number): Quote => ({ bid: usd(bid), ask: usd(ask) });

const evaluate = (q: Quote, stopDistance: Fixed, config: CostToRiskConfig = DEFAULT_COST_TO_RISK) =>
  evaluateCostToRisk({ quote: q, stopDistance }, config, DEFAULT_COST_MODEL);

describe("evaluateCostToRisk", () => {
  // Default model at $20.00 / $20.02: $0.02 spread plus $0.0201 on each stop leg is $0.0602.
  const q = quote(20.0, 20.02);

  it("passes exactly at the threshold and rejects one unit of stop distance below it", () => {
    // $0.0602 over $0.4014 is 0.14998R, which rounds up to 0.15R.
    expect(evaluate(q, usd(0.4014))).toEqual({
      passed: true,
      costPerShare: usd(0.0602),
      costToRisk: ratio(1_500),
      maxCostToRisk: ratio(1_500),
    });
    // $0.0602 over $0.4013 is 0.15001R.
    expect(evaluate(q, usd(0.4013))).toEqual({
      passed: false,
      reason: "COST_TO_RISK_ABOVE_MAX",
      costPerShare: usd(0.0602),
      costToRisk: ratio(1_501),
      maxCostToRisk: ratio(1_500),
    });
  });

  it("reproduces the plan's example: an $0.08 round trip is 0.8R on a $0.10 stop and 0.16R on $0.50", () => {
    const flatTicks: CostModelConfig = {
      spread: DEFAULT_COST_MODEL.spread,
      slippage: {
        market: { bps: ratio(0), ticks: 1 },
        stopEntry: { bps: ratio(0), ticks: 2 },
        stopExit: { bps: ratio(0), ticks: 2 },
      },
      commission: noCommission,
    };
    const wide = quote(20.0, 20.04);
    const tight = evaluateCostToRisk(
      { quote: wide, stopDistance: usd(0.1) },
      DEFAULT_COST_TO_RISK,
      flatTicks,
    );
    expect(tight.costPerShare).toBe(usd(0.08));
    expect(tight.costToRisk).toBe(ratio(8_000));
    expect(tight.passed).toBe(false);
    const wider = evaluateCostToRisk(
      { quote: wide, stopDistance: usd(0.5) },
      DEFAULT_COST_TO_RISK,
      flatTicks,
    );
    expect(wider.costToRisk).toBe(ratio(1_600));
    expect(wider.passed).toBe(false);
  });

  it("passes a high-ATR, tight-spread name", () => {
    // $50.00 / $50.01 with a $1.00 stop: $0.01 spread plus $0.0501 on each leg is 0.1102R.
    const result = evaluate(quote(50.0, 50.01), usd(1));
    expect(result.passed).toBe(true);
    expect(result.costToRisk).toBe(ratio(1_102));
  });

  it("rejects a low-ATR, wide-spread name", () => {
    // $8.00 / $8.04 with a $0.06 stop: $0.04 spread plus two ticks on each leg is 1.33R.
    const result = evaluate(quote(8.0, 8.04), usd(0.06));
    expect(result.passed).toBe(false);
    expect(result.costToRisk).toBe(ratio(13_334));
  });

  it("prices the legs with the configured fill kinds", () => {
    const marketExit: CostToRiskConfig = { ...DEFAULT_COST_TO_RISK, exitKind: "market" };
    expect(evaluate(q, usd(1), marketExit).costPerShare).toBe(usd(0.0501));
    const marketBoth: CostToRiskConfig = { ...marketExit, entryKind: "market" };
    expect(evaluate(q, usd(1), marketBoth).costPerShare).toBe(usd(0.04));
  });

  it("honors a configured threshold", () => {
    const loose: CostToRiskConfig = { ...DEFAULT_COST_TO_RISK, maxCostToRisk: ratio(7_000) };
    expect(evaluate(q, usd(0.1), loose).passed).toBe(true);
    expect(evaluate(q, usd(0.1)).passed).toBe(false);
  });

  it("rejects a stop distance it cannot evaluate, without throwing", () => {
    for (const bad of [usd(0), usd(-0.1), Number.NaN as Fixed, 0.5 as Fixed]) {
      expect(evaluate(q, bad)).toEqual({
        passed: false,
        reason: "INVALID_STOP_DISTANCE",
        costPerShare: null,
        costToRisk: null,
        maxCostToRisk: ratio(1_500),
      });
    }
  });

  it("rejects a crossed, non-positive, or malformed quote, without throwing", () => {
    const bad: readonly Quote[] = [
      quote(20.02, 20.0),
      { bid: usd(0), ask: usd(1) },
      { bid: Number.NaN as Fixed, ask: usd(1) },
      { bid: usd(1), ask: Number.NaN as Fixed },
    ];
    for (const badQuote of bad) {
      const result = evaluate(badQuote, usd(0.5));
      expect(result.passed).toBe(false);
      expect(result).toMatchObject({ reason: "INVALID_QUOTE", costPerShare: null, costToRisk: null });
    }
  });

  it("accepts a locked quote", () => {
    expect(evaluate(quote(20, 20), usd(1)).passed).toBe(true);
  });

  it("throws on a bad gate config or a bad cost model", () => {
    const zeroMarket: CostModelConfig = {
      ...DEFAULT_COST_MODEL,
      slippage: { ...DEFAULT_COST_MODEL.slippage, market: { bps: ratio(0), ticks: 0 } },
    };
    expect(() =>
      evaluateCostToRisk({ quote: q, stopDistance: usd(1) }, DEFAULT_COST_TO_RISK, zeroMarket),
    ).toThrow(CostModelError);
    expect(() => evaluate(q, usd(1), { ...DEFAULT_COST_TO_RISK, maxCostToRisk: ratio(0) })).toThrow(
      CostModelError,
    );
  });
});

describe("assertCostToRiskConfig", () => {
  it("accepts the default and both bounds", () => {
    const { min, max } = COST_TO_RISK_BOUNDS.maxCostToRisk;
    expect(() => assertCostToRiskConfig(DEFAULT_COST_TO_RISK)).not.toThrow();
    expect(() => assertCostToRiskConfig({ ...DEFAULT_COST_TO_RISK, maxCostToRisk: min })).not.toThrow();
    expect(() => assertCostToRiskConfig({ ...DEFAULT_COST_TO_RISK, maxCostToRisk: max })).not.toThrow();
  });

  it("rejects a threshold outside the bounds or not a whole number of basis points", () => {
    for (const bad of [0, -1, 10_001, 0.5, Number.NaN]) {
      expect(() => assertCostToRiskConfig({ ...DEFAULT_COST_TO_RISK, maxCostToRisk: bad as Ratio })).toThrow(
        CostModelError,
      );
    }
  });
});

describe("evaluateCostToRisk properties", () => {
  const quoteArb = fc
    .tuple(fc.integer({ min: 10_000, max: 5_000_000 }), fc.integer({ min: 0, max: 5_000 }))
    .map(([bid, width]): Quote => ({ bid: fixed(bid), ask: fixed(bid + width) }));
  const stopArb = fc.integer({ min: 1, max: 200_000 }).map(fixed);
  const configArb = fc
    .integer({ min: 1, max: 10_000 })
    .map((max): CostToRiskConfig => ({ ...DEFAULT_COST_TO_RISK, maxCostToRisk: ratio(max) }));

  it("passes exactly when cost is within the threshold's share of the stop distance", () => {
    fc.assert(
      fc.property(quoteArb, stopArb, configArb, (anyQuote, stopDistance, config) => {
        const result = evaluateCostToRisk({ quote: anyQuote, stopDistance }, config, DEFAULT_COST_MODEL);
        const cost = roundTripCostPerShare(anyQuote, config.entryKind, config.exitKind, DEFAULT_COST_MODEL);
        // Restated as a multiplication so the check shares no division or rounding with the gate.
        const within = BigInt(cost) * 10_000n <= BigInt(config.maxCostToRisk) * BigInt(stopDistance);
        expect(result.passed).toBe(within);
        expect(result.costPerShare).toBe(cost);
      }),
    );
  });

  it("never turns a pass into a rejection when the stop widens", () => {
    fc.assert(
      fc.property(
        quoteArb,
        stopArb,
        fc.integer({ min: 0, max: 100_000 }),
        (anyQuote, stopDistance, extra) => {
          const wider = fixed(stopDistance + extra);
          if (evaluate(anyQuote, stopDistance).passed) {
            expect(evaluate(anyQuote, wider).passed).toBe(true);
          }
        },
      ),
    );
  });

  it("never turns a rejection into a pass when the spread widens", () => {
    fc.assert(
      fc.property(quoteArb, stopArb, fc.integer({ min: 0, max: 5_000 }), (anyQuote, stopDistance, extra) => {
        const wider: Quote = { bid: anyQuote.bid, ask: fixed(anyQuote.ask + extra) };
        if (!evaluate(anyQuote, stopDistance).passed) {
          expect(evaluate(wider, stopDistance).passed).toBe(false);
        }
      }),
    );
  });
});
