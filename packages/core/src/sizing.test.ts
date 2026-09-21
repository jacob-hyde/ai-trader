import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fixed, fromNumber, ratio, type Fixed, type Ratio } from "./money.js";
import {
  SizingError,
  assertSizingConfig,
  sizePosition,
  type Direction,
  type SizedPosition,
  type SizingConfig,
  type SizingInput,
  type SizingRegime,
  type SizingRejection,
} from "./sizing.js";

const usd = fromNumber;

const PROVEN: SizingConfig = {
  riskPerTrade: ratio(100),
  maxPositionPct: ratio(2_000),
  regime: { kind: "proven" },
};
const VALIDATION: SizingConfig = {
  ...PROVEN,
  regime: { kind: "validation", maxShares: 2, maxNotional: usd(50) },
};

// The spec's worked example: $2,500 equity, 1% risk, 20% cap, entry $20.00, stop $19.60.
const EXAMPLE: SizingInput = {
  direction: "long",
  entry: usd(20),
  stop: usd(19.6),
  equity: usd(2_500),
  buyingPower: usd(2_500),
  roundTripCostPerShare: usd(0.05),
};

function accepted(input: SizingInput, config: SizingConfig): SizedPosition {
  const result = sizePosition(input, config);
  if (!result.accepted) {
    throw new Error(`expected a sized position, got ${result.reason}`);
  }
  return result;
}

function rejected(input: SizingInput, config: SizingConfig): SizingRejection {
  const result = sizePosition(input, config);
  if (result.accepted) {
    throw new Error(`expected a rejection, got ${String(result.shares)} shares`);
  }
  return result;
}

describe("sizePosition in the proven regime", () => {
  it("matches the worked example", () => {
    expect(accepted(EXAMPLE, PROVEN)).toEqual({
      accepted: true,
      shares: 25,
      notional: usd(500),
      riskDollars: usd(10),
      riskOfEquity: ratio(40),
      stopDistance: usd(0.4),
      bindingConstraint: "notionalCap",
      limits: { risk: 62, notionalCap: 25, buyingPower: 125, microShares: null, microNotional: null },
    });
  });

  it("is symmetric for a short with the stop above entry", () => {
    const short: SizingInput = { ...EXAMPLE, direction: "short", stop: usd(20.4) };
    expect(sizePosition(short, PROVEN)).toEqual(sizePosition(EXAMPLE, PROVEN));
  });

  it("lets the risk budget bind on a wide stop", () => {
    const sized = accepted({ ...EXAMPLE, stop: usd(15) }, PROVEN);
    expect(sized.shares).toBe(5);
    expect(sized.bindingConstraint).toBe("risk");
    expect(sized.riskDollars).toBe(usd(25));
    expect(sized.riskOfEquity).toBe(ratio(100));
  });

  it("lets buying power bind", () => {
    const sized = accepted({ ...EXAMPLE, buyingPower: usd(310) }, PROVEN);
    expect(sized.shares).toBe(15);
    expect(sized.bindingConstraint).toBe("buyingPower");
  });

  it("names the earlier constraint on a tie", () => {
    // A $1.00 stop makes the risk budget and the notional cap both 25 shares.
    expect(accepted({ ...EXAMPLE, stop: usd(19) }, PROVEN).bindingConstraint).toBe("risk");
  });

  it("rounds riskOfEquity up", () => {
    // 1 share risking $0.40 on $2,500 is 1.6 bps.
    const sized = accepted({ ...EXAMPLE, buyingPower: usd(20) }, PROVEN);
    expect(sized.shares).toBe(1);
    expect(sized.riskOfEquity).toBe(ratio(2));
  });
});

describe("sizePosition in the validation regime", () => {
  it("clamps to the micro share cap when the formula says hundreds of shares", () => {
    const rich: SizingInput = { ...EXAMPLE, equity: usd(100_000), buyingPower: usd(100_000) };
    expect(accepted(rich, PROVEN).shares).toBe(1_000);
    const sized = accepted(rich, VALIDATION);
    expect(sized.shares).toBe(2);
    expect(sized.bindingConstraint).toBe("microShares");
    expect(sized.limits).toEqual({
      risk: 2_500,
      notionalCap: 1_000,
      buyingPower: 5_000,
      microShares: 2,
      microNotional: 2,
    });
  });

  it("clamps to the micro notional cap when it is tighter than the share cap", () => {
    const sized = accepted({ ...EXAMPLE, entry: usd(30), stop: usd(29.6) }, VALIDATION);
    expect(sized.shares).toBe(1);
    expect(sized.bindingConstraint).toBe("microNotional");
  });

  it("rejects a share price above the micro notional cap", () => {
    const result = rejected({ ...EXAMPLE, entry: usd(60), stop: usd(59.4) }, VALIDATION);
    expect(result.reason).toBe("BELOW_ONE_SHARE");
    expect(result.bindingConstraint).toBe("microNotional");
    expect(result.limits?.microNotional).toBe(0);
  });

  it("never sizes above the formula", () => {
    // The formula allows 1 share here, below the 2 share micro cap.
    const sized = accepted({ ...EXAMPLE, buyingPower: usd(25) }, VALIDATION);
    expect(sized.shares).toBe(1);
    expect(sized.bindingConstraint).toBe("buyingPower");
  });
});

describe("sizePosition rejections", () => {
  it("rejects a stop no wider than the round-trip cost", () => {
    const atStop = rejected({ ...EXAMPLE, roundTripCostPerShare: usd(0.4) }, PROVEN);
    expect(atStop).toEqual({
      accepted: false,
      reason: "COST_EXCEEDS_STOP",
      bindingConstraint: null,
      limits: null,
    });
    expect(rejected({ ...EXAMPLE, roundTripCostPerShare: usd(1) }, PROVEN).reason).toBe("COST_EXCEEDS_STOP");
    expect(accepted({ ...EXAMPLE, roundTripCostPerShare: usd(0.3999) }, PROVEN).shares).toBe(25);
  });

  it("rejects a stop on the wrong side of entry, or at entry, in both directions", () => {
    expect(rejected({ ...EXAMPLE, stop: usd(20.4) }, PROVEN).reason).toBe("STOP_ON_WRONG_SIDE");
    expect(rejected({ ...EXAMPLE, stop: usd(20) }, PROVEN).reason).toBe("STOP_ON_WRONG_SIDE");
    expect(rejected({ ...EXAMPLE, direction: "short" }, PROVEN).reason).toBe("STOP_ON_WRONG_SIDE");
    expect(rejected({ ...EXAMPLE, direction: "short", stop: usd(20) }, PROVEN).reason).toBe(
      "STOP_ON_WRONG_SIDE",
    );
  });

  it("rejects non-positive equity and prices", () => {
    expect(rejected({ ...EXAMPLE, equity: usd(0) }, PROVEN).reason).toBe("NON_POSITIVE_EQUITY");
    expect(rejected({ ...EXAMPLE, equity: usd(-100) }, PROVEN).reason).toBe("NON_POSITIVE_EQUITY");
    expect(rejected({ ...EXAMPLE, entry: usd(0) }, PROVEN).reason).toBe("INVALID_PRICE");
    expect(rejected({ ...EXAMPLE, stop: usd(-1) }, PROVEN).reason).toBe("INVALID_PRICE");
  });

  it("rejects below one share and names the constraint that floored to zero", () => {
    const broke = rejected({ ...EXAMPLE, buyingPower: usd(19.99) }, PROVEN);
    expect(broke.reason).toBe("BELOW_ONE_SHARE");
    expect(broke.bindingConstraint).toBe("buyingPower");
    expect(broke.limits?.buyingPower).toBe(0);

    const overdrawn = rejected({ ...EXAMPLE, buyingPower: usd(-500) }, PROVEN);
    expect(overdrawn.bindingConstraint).toBe("buyingPower");
    expect(overdrawn.limits?.buyingPower).toBe(0);

    // $25 of risk budget against a $30 stop distance.
    const wide = rejected({ ...EXAMPLE, entry: usd(100), stop: usd(70) }, PROVEN);
    expect(wide.bindingConstraint).toBe("risk");
  });
});

describe("sizing config and malformed inputs", () => {
  const withRegime = (regime: SizingRegime): SizingConfig => ({ ...PROVEN, regime });

  it("accepts the fixtures", () => {
    expect(() => assertSizingConfig(PROVEN)).not.toThrow();
    expect(() => assertSizingConfig(VALIDATION)).not.toThrow();
    expect(() => assertSizingConfig({ ...PROVEN, maxPositionPct: ratio(10_000) })).not.toThrow();
  });

  it("throws on fractions outside (0, 100%]", () => {
    for (const bad of [0, -1, 10_001, 0.5, Number.NaN]) {
      expect(() => assertSizingConfig({ ...PROVEN, riskPerTrade: bad as Ratio })).toThrow(SizingError);
      expect(() => assertSizingConfig({ ...PROVEN, maxPositionPct: bad as Ratio })).toThrow(SizingError);
    }
  });

  it("throws on a malformed micro cap", () => {
    for (const maxShares of [0, -1, 1.5, Number.NaN]) {
      const regime: SizingRegime = { kind: "validation", maxShares, maxNotional: usd(50) };
      expect(() => assertSizingConfig(withRegime(regime))).toThrow(SizingError);
    }
    for (const maxNotional of [0, -1, 0.5, Number.NaN]) {
      const regime: SizingRegime = { kind: "validation", maxShares: 2, maxNotional: maxNotional as Fixed };
      expect(() => assertSizingConfig(withRegime(regime))).toThrow(SizingError);
    }
  });

  it("throws from sizePosition on a bad config, a malformed number, or a negative cost", () => {
    expect(() => sizePosition(EXAMPLE, { ...PROVEN, riskPerTrade: ratio(0) })).toThrow(SizingError);
    expect(() => sizePosition({ ...EXAMPLE, entry: Number.NaN as Fixed }, PROVEN)).toThrow(SizingError);
    expect(() => sizePosition({ ...EXAMPLE, equity: 0.5 as Fixed }, PROVEN)).toThrow(SizingError);
    expect(() => sizePosition({ ...EXAMPLE, roundTripCostPerShare: fixed(-1) }, PROVEN)).toThrow(SizingError);
  });
});

describe("sizePosition properties", () => {
  const SCALE = 10_000n;

  const regimeArb = fc.oneof(
    fc.constant<SizingRegime>({ kind: "proven" }),
    fc
      .record({
        maxShares: fc.integer({ min: 1, max: 10 }),
        maxNotional: fc.integer({ min: 100_000, max: 5_000_000 }),
      })
      .map(({ maxShares, maxNotional }): SizingRegime => ({
        kind: "validation",
        maxShares,
        maxNotional: fixed(maxNotional),
      })),
  );
  const configArb = fc
    .record({
      riskPerTrade: fc.integer({ min: 1, max: 500 }),
      maxPositionPct: fc.integer({ min: 100, max: 10_000 }),
      regime: regimeArb,
    })
    .map(({ riskPerTrade, maxPositionPct, regime }): SizingConfig => ({
      riskPerTrade: ratio(riskPerTrade),
      maxPositionPct: ratio(maxPositionPct),
      regime,
    }));
  // Entries from $1 to $500, stops up to $20 away, equity from $100 to $1M, buying power from overdrawn to 4x.
  const inputArb = fc
    .record({
      direction: fc.constantFrom<Direction>("long", "short"),
      entry: fc.integer({ min: 10_000, max: 5_000_000 }),
      distance: fc.integer({ min: 1, max: 200_000 }),
      equity: fc.integer({ min: 1_000_000, max: 10_000_000_000 }),
      buyingPower: fc.integer({ min: -1_000_000, max: 40_000_000_000 }),
      cost: fc.integer({ min: 0, max: 3_000 }),
    })
    .map(({ direction, entry, distance, equity, buyingPower, cost }): SizingInput => {
      const gap = Math.min(distance, entry - 1);
      return {
        direction,
        entry: fixed(entry),
        stop: fixed(direction === "long" ? entry - gap : entry + gap),
        equity: fixed(equity),
        buyingPower: fixed(buyingPower),
        roundTripCostPerShare: fixed(cost),
      };
    });

  // Every limit restated as a multiplication, so nothing here shares the implementation's divisions.
  function fits(shares: number, input: SizingInput, config: SizingConfig): boolean {
    const n = BigInt(shares);
    const entry = BigInt(input.entry);
    const distance = BigInt(Math.abs(input.entry - input.stop));
    const equity = BigInt(input.equity);
    const withinRisk = n * distance * SCALE <= equity * BigInt(config.riskPerTrade);
    const withinCap = n * entry * SCALE <= equity * BigInt(config.maxPositionPct);
    const withinBuyingPower = n * entry <= BigInt(input.buyingPower);
    const withinMicro =
      config.regime.kind === "proven" ||
      (shares <= config.regime.maxShares && n * entry <= BigInt(config.regime.maxNotional));
    return withinRisk && withinCap && withinBuyingPower && withinMicro;
  }

  it("never exceeds a limit and never leaves a share on the table", () => {
    fc.assert(
      fc.property(inputArb, configArb, (input, config) => {
        const result = sizePosition(input, config);
        if (!result.accepted) {
          if (result.reason === "BELOW_ONE_SHARE") {
            expect(fits(1, input, config)).toBe(false);
          } else {
            expect(result.reason).toBe("COST_EXCEEDS_STOP");
          }
          return;
        }
        expect(Number.isSafeInteger(result.shares)).toBe(true);
        expect(result.shares).toBeGreaterThanOrEqual(1);
        expect(fits(result.shares, input, config)).toBe(true);
        expect(fits(result.shares + 1, input, config)).toBe(false);
        expect(result.limits[result.bindingConstraint]).toBe(result.shares);
        expect(result.notional).toBe(input.entry * result.shares);
        expect(result.riskDollars).toBe(result.stopDistance * result.shares);
        expect(input.roundTripCostPerShare).toBeLessThan(result.stopDistance);
      }),
    );
  });

  it("never sizes the validation regime above the proven regime", () => {
    fc.assert(
      fc.property(inputArb, configArb, (input, config) => {
        const proven = sizePosition(input, { ...config, regime: { kind: "proven" } });
        const result = sizePosition(input, config);
        if (result.accepted) {
          expect(proven.accepted && proven.shares >= result.shares).toBe(true);
        }
      }),
    );
  });

  it("sizes a short exactly like the mirrored long", () => {
    fc.assert(
      fc.property(inputArb, configArb, (input, config) => {
        const gap = Math.abs(input.entry - input.stop);
        const long: SizingInput = { ...input, direction: "long", stop: fixed(input.entry - gap) };
        const short: SizingInput = { ...input, direction: "short", stop: fixed(input.entry + gap) };
        expect(sizePosition(short, config)).toEqual(sizePosition(long, config));
      }),
    );
  });
});
