import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fixed, fromNumber, ratio, type Fixed, type Ratio } from "./money.js";
import {
  BREAKER_ARMED,
  DEFAULT_RISK_CONFIG,
  RISK_CONFIG_BOUNDS,
  RISK_VETO_REASONS,
  RiskError,
  assertRiskConfig,
  evaluateBreaker,
  evaluateOrder,
  type AccountState,
  type BreakerState,
  type Exposure,
  type PortfolioState,
  type ProposedEntry,
  type RiskConfig,
} from "./riskRules.js";
import type { Direction } from "./sizing.js";

const usd = fromNumber;
const TRIPPED: BreakerState = { tripped: true };

// Defaults at $2,500: $625 position cap, $2,500 gross cap, 4 concurrent, $50 open risk, $125 daily limit.
function account(equity = 2_500, realizedPnlToday = 0): AccountState {
  return { equity: usd(equity), startOfDayEquity: usd(2_500), realizedPnlToday: usd(realizedPnlToday) };
}

function portfolio(
  exposures: readonly Exposure[] = [],
  acct = account(),
  breaker = BREAKER_ARMED,
): PortfolioState {
  return { account: acct, exposures, breaker };
}

function held(
  symbol: string,
  shares: number,
  entry: number,
  stop: number | null,
  direction: Direction = "long",
): Exposure {
  return { symbol, direction, shares, entry: usd(entry), stop: stop === null ? null : usd(stop) };
}

function entry(
  symbol: string,
  shares: number,
  price: number,
  stop: number,
  direction: Direction = "long",
): ProposedEntry {
  return { intent: "entry", symbol, direction, shares, entry: usd(price), stop: usd(stop) };
}

const decide = (order: ProposedEntry, state = portfolio(), config = DEFAULT_RISK_CONFIG) =>
  evaluateOrder(order, state, config);

describe("evaluateOrder on a clean entry", () => {
  it("allows the sizing worked example and reports what it measured", () => {
    expect(decide(entry("AAA", 25, 20, 19.6))).toEqual({
      allowed: true,
      reasons: [],
      measures: {
        concurrentPositions: 1,
        symbolNotional: usd(500),
        positionCap: usd(625),
        grossNotional: usd(500),
        grossCap: usd(2_500),
        openRisk: usd(10),
        openRiskCeiling: usd(50),
        dailyRiskUsed: usd(10),
        dailyLossLimit: usd(125),
      },
    });
  });

  it("treats a short symmetrically", () => {
    const long = decide(entry("AAA", 25, 20, 19.6));
    const short = decide(entry("AAA", 25, 20, 20.4, "short"));
    expect(short).toEqual(long);
  });
});

describe("POSITION_CAP", () => {
  it("allows a position exactly at the cap and vetoes one share more", () => {
    expect(decide(entry("AAA", 25, 25, 24.9)).allowed).toBe(true);
    expect(decide(entry("AAA", 26, 25, 24.9)).reasons).toEqual(["POSITION_CAP"]);
  });

  it("counts shares already held or working in the same symbol", () => {
    const state = portfolio([held("AAA", 20, 25, 24.9)]);
    const atCap = decide(entry("AAA", 5, 25, 24.9), state);
    expect(atCap.allowed).toBe(true);
    expect(atCap.measures?.symbolNotional).toBe(usd(625));
    expect(atCap.measures?.concurrentPositions).toBe(1);
    expect(decide(entry("AAA", 6, 25, 24.9), state).reasons).toEqual(["POSITION_CAP"]);
  });
});

describe("MAX_CONCURRENT_POSITIONS", () => {
  const three = [held("AAA", 1, 20, 19.9), held("BBB", 1, 20, 19.9), held("CCC", 1, 20, 19.9)];
  const four = [...three, held("DDD", 1, 20, 19.9)];

  it("allows the entry that reaches the limit and vetoes the next symbol", () => {
    expect(decide(entry("DDD", 1, 20, 19.9), portfolio(three)).allowed).toBe(true);
    expect(decide(entry("EEE", 1, 20, 19.9), portfolio(four)).reasons).toEqual(["MAX_CONCURRENT_POSITIONS"]);
  });

  it("does not count adding to a held symbol as a new position", () => {
    expect(decide(entry("DDD", 1, 20, 19.9), portfolio(four)).allowed).toBe(true);
  });
});

describe("GROSS_EXPOSURE", () => {
  // A 40% position cap lets two $1,000 positions sit under the $2,500 gross cap.
  const config: RiskConfig = { ...DEFAULT_RISK_CONFIG, maxPositionPct: ratio(4_000) };
  const state = portfolio([held("AAA", 50, 20, 19.9), held("BBB", 50, 20, 19.9)]);

  it("allows gross exactly at 1x and vetoes one share more", () => {
    const atCap = decide(entry("CCC", 25, 20, 19.9), state, config);
    expect(atCap.allowed).toBe(true);
    expect(atCap.measures?.grossNotional).toBe(usd(2_500));
    expect(decide(entry("CCC", 26, 20, 19.9), state, config).reasons).toEqual(["GROSS_EXPOSURE"]);
  });
});

describe("OPEN_RISK_CEILING", () => {
  it("allows open risk exactly at the ceiling and vetoes a hair more", () => {
    const state = portfolio([held("AAA", 25, 20, 18.4)]);
    const atCeiling = decide(entry("BBB", 25, 20, 19.6), state);
    expect(atCeiling.allowed).toBe(true);
    expect(atCeiling.measures?.openRisk).toBe(usd(50));
    const over = decide(entry("BBB", 25, 20, 19.59), state);
    expect(over.reasons).toEqual(["OPEN_RISK_CEILING"]);
    expect(over.measures?.openRisk).toBe(usd(50.25));
  });

  it("measures a short's risk from the stop above entry", () => {
    const state = portfolio([held("AAA", 25, 20, 21.6, "short")]);
    expect(decide(entry("BBB", 25, 20, 19.6), state).measures?.openRisk).toBe(usd(50));
  });

  it("counts no risk for a stop at or beyond entry", () => {
    const state = portfolio([
      held("AAA", 25, 20, 20.5),
      held("BBB", 25, 20, 19, "short"),
      held("CCC", 1, 20, 20),
    ]);
    const result = decide(entry("DDD", 25, 20, 18), state);
    expect(result.allowed).toBe(true);
    expect(result.measures?.openRisk).toBe(usd(50));
  });
});

describe("DAILY_RISK_BUDGET", () => {
  it("allows realized loss plus open risk exactly at the limit and vetoes a hair more", () => {
    // Down $100 realized, $15 already at risk. $10 more makes exactly the $125 limit.
    const state = portfolio([held("AAA", 25, 20, 19.4)], account(2_400, -100));
    const atLimit = decide(entry("BBB", 25, 20, 19.6), state);
    expect(atLimit.allowed).toBe(true);
    expect(atLimit.measures?.dailyRiskUsed).toBe(usd(125));
    expect(decide(entry("BBB", 25, 20, 19.59), state).reasons).toEqual(["DAILY_RISK_BUDGET"]);
  });

  it("does not let realized gains widen the budget", () => {
    const config: RiskConfig = { ...DEFAULT_RISK_CONFIG, maxOpenRisk: ratio(1_000) };
    const state = portfolio([held("AAA", 25, 20, 15.2)], account(2_700, 200));
    const result = decide(entry("BBB", 25, 20, 19.6), state, config);
    expect(result.reasons).toEqual(["DAILY_RISK_BUDGET"]);
    expect(result.measures?.dailyRiskUsed).toBe(usd(130));
  });
});

describe("DAILY_LOSS_BREAKER in evaluateOrder", () => {
  const order = entry("AAA", 1, 20, 19.9);

  it("allows one unit above the threshold and vetoes exactly at it", () => {
    expect(decide(order, portfolio([], account(2_375.0001))).allowed).toBe(true);
    expect(decide(order, portfolio([], account(2_375))).reasons).toEqual(["DAILY_LOSS_BREAKER"]);
    expect(decide(order, portfolio([], account(2_000))).reasons).toEqual(["DAILY_LOSS_BREAKER"]);
  });

  it("stays vetoed on a latched breaker after equity recovers", () => {
    expect(decide(order, portfolio([], account(2_600), TRIPPED)).reasons).toEqual(["DAILY_LOSS_BREAKER"]);
  });
});

describe("UNPROTECTED_POSITION", () => {
  it("vetoes every entry while any position has no stop", () => {
    const state = portfolio([held("AAA", 1, 20, null)]);
    expect(decide(entry("BBB", 1, 20, 19.9), state).reasons).toEqual(["UNPROTECTED_POSITION"]);
  });
});

describe("unevaluable input", () => {
  const good = entry("AAA", 1, 20, 19.9);

  it("vetoes a malformed proposal", () => {
    const bad: readonly ProposedEntry[] = [
      { ...good, symbol: "" },
      { ...good, shares: 0 },
      { ...good, shares: 1.5 },
      { ...good, shares: Number.NaN },
      { ...good, shares: 9_000_000_000_000_000 },
      { ...good, entry: usd(0) },
      { ...good, entry: Number.NaN as Fixed },
      { ...good, stop: usd(0) },
      { ...good, stop: usd(20) },
      { ...good, stop: usd(20.1) },
      { ...good, direction: "short" },
      { ...good, direction: "short", stop: fixed(9_000_000_000_000_000), shares: 2 },
    ];
    for (const order of bad) {
      expect(decide(order)).toEqual({ allowed: false, reasons: ["INVALID_PROPOSAL"], measures: null });
    }
  });

  it("vetoes on malformed account or exposure state", () => {
    const states: readonly PortfolioState[] = [
      portfolio([], { ...account(), equity: usd(0) }),
      portfolio([], { ...account(), equity: Number.NaN as Fixed }),
      portfolio([], { ...account(), startOfDayEquity: usd(0) }),
      portfolio([], { ...account(), realizedPnlToday: Number.NaN as Fixed }),
      portfolio([{ ...held("BBB", 1, 20, 19.9), symbol: "" }]),
      portfolio([held("BBB", 0, 20, 19.9)]),
      portfolio([{ ...held("BBB", 1, 20, 19.9), entry: Number.NaN as Fixed }]),
      portfolio([held("BBB", 1, 20, 0)]),
      portfolio([held("BBB", 9_000_000_000_000_000, 20, 19.9)]),
    ];
    for (const state of states) {
      expect(decide(good, state)).toEqual({ allowed: false, reasons: ["INVALID_STATE"], measures: null });
    }
  });

  it("vetoes when totals leave the safe integer range", () => {
    const huge: Exposure = {
      ...held("BBB", 1, 20, 19.9),
      entry: fixed(5_000_000_000_000_000),
      stop: fixed(1),
    };
    const state = portfolio([huge, { ...huge, symbol: "CCC" }]);
    expect(decide(good, state)).toEqual({ allowed: false, reasons: ["INVALID_STATE"], measures: null });
  });

  it("reports both when state and proposal are malformed", () => {
    const state = portfolio([], { ...account(), equity: usd(0) });
    expect(decide({ ...good, shares: 0 }, state).reasons).toEqual(["INVALID_STATE", "INVALID_PROPOSAL"]);
  });
});

describe("veto reasons", () => {
  it("are enumerated and stable", () => {
    expect(RISK_VETO_REASONS).toEqual([
      "INVALID_STATE",
      "INVALID_PROPOSAL",
      "DAILY_LOSS_BREAKER",
      "UNPROTECTED_POSITION",
      "MAX_CONCURRENT_POSITIONS",
      "POSITION_CAP",
      "GROSS_EXPOSURE",
      "OPEN_RISK_CEILING",
      "DAILY_RISK_BUDGET",
    ]);
  });

  it("reports every failed rule, in enumeration order", () => {
    const state = portfolio(
      [held("AAA", 25, 25, 24), held("BBB", 25, 25, 24), held("CCC", 25, 25, 24), held("DDD", 25, 25, null)],
      account(2_450, -50),
      TRIPPED,
    );
    const result = decide(entry("EEE", 30, 25, 24), state);
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(RISK_VETO_REASONS.slice(2));
  });
});

describe("exits", () => {
  const exit = { intent: "exit", symbol: "AAA" } as const;
  const allowed = { allowed: true, reasons: [], measures: null };

  it("pass a tripped breaker, an unprotected position, and a full book", () => {
    const state = portfolio(
      [held("AAA", 100, 25, null), held("BBB", 100, 25, 20), held("CCC", 1, 20, 19), held("DDD", 1, 20, 19)],
      account(2_000, -500),
      TRIPPED,
    );
    expect(evaluateOrder(exit, state, DEFAULT_RISK_CONFIG)).toEqual(allowed);
  });

  it("pass garbage state and a config that would throw for an entry", () => {
    const garbage = portfolio([held("AAA", Number.NaN, 0, 0)], {
      equity: Number.NaN as Fixed,
      startOfDayEquity: usd(0),
      realizedPnlToday: Number.NaN as Fixed,
    });
    const badConfig: RiskConfig = { ...DEFAULT_RISK_CONFIG, maxConcurrentPositions: 0 };
    expect(() => evaluateOrder(entry("AAA", 1, 20, 19.9), garbage, badConfig)).toThrow(RiskError);
    expect(evaluateOrder(exit, garbage, badConfig)).toEqual(allowed);
  });
});

describe("evaluateBreaker", () => {
  it("stays armed above the threshold", () => {
    expect(evaluateBreaker(BREAKER_ARMED, account(2_375.0001), DEFAULT_RISK_CONFIG)).toEqual({
      state: { tripped: false },
      trippedNow: false,
      flatten: false,
      dayPnl: usd(-124.9999),
      dailyLossLimit: usd(125),
    });
  });

  it("trips exactly at the threshold and reports the transition once", () => {
    const first = evaluateBreaker(BREAKER_ARMED, account(2_375), DEFAULT_RISK_CONFIG);
    expect(first.state).toEqual({ tripped: true });
    expect(first.trippedNow).toBe(true);
    const second = evaluateBreaker(first.state, account(2_375), DEFAULT_RISK_CONFIG);
    expect(second.state).toEqual({ tripped: true });
    expect(second.trippedNow).toBe(false);
  });

  it("stays tripped for the session after equity recovers", () => {
    const recovered = evaluateBreaker(TRIPPED, account(2_600), DEFAULT_RISK_CONFIG);
    expect(recovered.state).toEqual({ tripped: true });
    expect(recovered.dayPnl).toBe(usd(100));
  });

  it("asks for a flatten only when configured, and only while tripped", () => {
    const flattening: RiskConfig = { ...DEFAULT_RISK_CONFIG, flattenOnBreaker: true };
    expect(evaluateBreaker(BREAKER_ARMED, account(2_375), DEFAULT_RISK_CONFIG).flatten).toBe(false);
    expect(evaluateBreaker(BREAKER_ARMED, account(2_375), flattening).flatten).toBe(true);
    expect(evaluateBreaker(BREAKER_ARMED, account(2_500), flattening).flatten).toBe(false);
  });

  it("floors the limit, so rounding can only trip it earlier", () => {
    // 5% of $2,500.0001 is $125.000005, floored to $125.0000.
    const start = fixed(25_000_001);
    const acct: AccountState = {
      equity: fixed(25_000_001 - 1_250_000),
      startOfDayEquity: start,
      realizedPnlToday: usd(0),
    };
    const result = evaluateBreaker(BREAKER_ARMED, acct, DEFAULT_RISK_CONFIG);
    expect(result.dailyLossLimit).toBe(usd(125));
    expect(result.state.tripped).toBe(true);
  });

  it("throws on a bad config or a malformed account", () => {
    expect(() =>
      evaluateBreaker(BREAKER_ARMED, account(), { ...DEFAULT_RISK_CONFIG, dailyLossLimit: ratio(0) }),
    ).toThrow(RiskError);
    expect(() =>
      evaluateBreaker(BREAKER_ARMED, { ...account(), equity: usd(0) }, DEFAULT_RISK_CONFIG),
    ).toThrow(RiskError);
  });

  it("latches over any equity path: tripped exactly when some update reached the limit", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 20_000_000, max: 27_000_000 }), { maxLength: 30 }), (path) => {
        let state = BREAKER_ARMED;
        let transitions = 0;
        let reached = false;
        for (const equity of path) {
          const acct: AccountState = { ...account(), equity: fixed(equity) };
          const result = evaluateBreaker(state, acct, DEFAULT_RISK_CONFIG);
          reached = reached || equity <= 23_750_000;
          transitions += result.trippedNow ? 1 : 0;
          expect(result.state.tripped).toBe(reached);
          expect(state.tripped && !result.state.tripped).toBe(false);
          state = result.state;
        }
        expect(transitions).toBe(reached ? 1 : 0);
      }),
    );
  });
});

describe("assertRiskConfig", () => {
  it("accepts the default and every bound", () => {
    expect(() => assertRiskConfig(DEFAULT_RISK_CONFIG)).not.toThrow();
    for (const [name, { min, max }] of Object.entries(RISK_CONFIG_BOUNDS)) {
      expect(() => assertRiskConfig({ ...DEFAULT_RISK_CONFIG, [name]: min })).not.toThrow();
      expect(() => assertRiskConfig({ ...DEFAULT_RISK_CONFIG, [name]: max })).not.toThrow();
    }
  });

  it("rejects values outside the bounds or not whole numbers", () => {
    for (const [name, { min, max }] of Object.entries(RISK_CONFIG_BOUNDS)) {
      for (const bad of [min - 1, max + 1, min + 0.5, Number.NaN]) {
        expect(() => assertRiskConfig({ ...DEFAULT_RISK_CONFIG, [name]: bad })).toThrow(RiskError);
      }
    }
  });

  it("rejects a non-boolean flatten flag", () => {
    expect(() => assertRiskConfig({ ...DEFAULT_RISK_CONFIG, flattenOnBreaker: "yes" as never })).toThrow(
      RiskError,
    );
  });
});

describe("evaluateOrder properties", () => {
  const SCALE = 10_000n;
  const symbolArb = fc.constantFrom("AAA", "BBB", "CCC", "DDD", "EEE", "FFF");
  const directionArb = fc.constantFrom<Direction>("long", "short");

  const exposureArb = fc
    .record({
      symbol: symbolArb,
      direction: directionArb,
      shares: fc.integer({ min: 1, max: 100 }),
      entry: fc.integer({ min: 50_000, max: 1_000_000 }),
      distance: fc.integer({ min: 100, max: 20_000 }),
    })
    .map(({ symbol, direction, shares, entry: price, distance }): Exposure => ({
      symbol,
      direction,
      shares,
      entry: fixed(price),
      stop: fixed(direction === "long" ? price - distance : price + distance),
    }));
  const stateArb = fc
    .record({
      start: fc.integer({ min: 10_000_000, max: 1_000_000_000 }),
      equityPct: fc.integer({ min: 9_000, max: 11_000 }),
      realizedPct: fc.integer({ min: -500, max: 500 }),
      exposures: fc.array(exposureArb, { maxLength: 5 }),
      tripped: fc.boolean(),
    })
    .map(({ start, equityPct, realizedPct, exposures, tripped }): PortfolioState => ({
      account: {
        equity: fixed(Math.floor((start * equityPct) / 10_000)),
        startOfDayEquity: fixed(start),
        realizedPnlToday: fixed(Math.floor((start * realizedPct) / 10_000)),
      },
      exposures,
      breaker: { tripped },
    }));
  const configArb = fc
    .record({
      maxPositionPct: fc.integer({ min: 100, max: 10_000 }),
      maxGrossExposure: fc.integer({ min: 100, max: 40_000 }),
      maxConcurrentPositions: fc.integer({ min: 1, max: 20 }),
      maxOpenRisk: fc.integer({ min: 1, max: 1_000 }),
      dailyLossLimit: fc.integer({ min: 10, max: 1_000 }),
      flattenOnBreaker: fc.boolean(),
    })
    .map((raw): RiskConfig => ({
      ...raw,
      maxPositionPct: ratio(raw.maxPositionPct),
      maxGrossExposure: ratio(raw.maxGrossExposure),
      maxOpenRisk: ratio(raw.maxOpenRisk),
      dailyLossLimit: ratio(raw.dailyLossLimit),
    }));
  const orderArb = exposureArb.map((exposure): ProposedEntry => ({
    intent: "entry",
    symbol: exposure.symbol,
    direction: exposure.direction,
    shares: exposure.shares,
    entry: exposure.entry,
    stop: exposure.stop as Fixed,
  }));

  const big = (value: number): bigint => BigInt(value);
  const share = (equity: Fixed, fraction: Ratio): bigint => big(equity) * big(fraction);
  const riskOf = (e: Exposure): bigint => {
    const perShare = e.direction === "long" ? e.entry - (e.stop as Fixed) : (e.stop as Fixed) - e.entry;
    return big(Math.max(perShare, 0)) * big(e.shares);
  };

  it("never allows an entry that breaks a limit", () => {
    fc.assert(
      fc.property(orderArb, stateArb, configArb, (order, state, config) => {
        const decision = evaluateOrder(order, state, config);
        if (!decision.allowed) {
          expect(decision.reasons.length).toBeGreaterThan(0);
          return;
        }
        const { account: acct, exposures } = state;
        const all: readonly Exposure[] = [...exposures, order];
        const notional = (list: readonly Exposure[]) =>
          list.reduce((sum, e) => sum + big(e.entry) * big(e.shares), 0n);
        const openRisk = all.reduce((sum, e) => sum + riskOf(e), 0n);
        const realizedLoss = big(Math.max(-acct.realizedPnlToday, 0));
        // Each limit restated as a multiplication, sharing no division or rounding with the rules.
        expect(state.breaker.tripped).toBe(false);
        expect(big(acct.startOfDayEquity - acct.equity) * SCALE).toBeLessThan(
          share(acct.startOfDayEquity, config.dailyLossLimit),
        );
        expect(new Set(all.map((e) => e.symbol)).size).toBeLessThanOrEqual(config.maxConcurrentPositions);
        expect(notional(all.filter((e) => e.symbol === order.symbol)) * SCALE).toBeLessThanOrEqual(
          share(acct.equity, config.maxPositionPct),
        );
        expect(notional(all) * SCALE).toBeLessThanOrEqual(share(acct.equity, config.maxGrossExposure));
        expect(openRisk * SCALE).toBeLessThanOrEqual(share(acct.equity, config.maxOpenRisk));
        expect((realizedLoss + openRisk) * SCALE).toBeLessThanOrEqual(
          share(acct.startOfDayEquity, config.dailyLossLimit),
        );
      }),
    );
  });

  it("never allows a larger entry where a smaller one is vetoed", () => {
    fc.assert(
      fc.property(orderArb, stateArb, configArb, (order, state, config) => {
        const larger: ProposedEntry = { ...order, shares: order.shares + 1 };
        if (evaluateOrder(larger, state, config).allowed) {
          expect(evaluateOrder(order, state, config).allowed).toBe(true);
        }
      }),
    );
  });

  it("always allows an exit", () => {
    fc.assert(
      fc.property(symbolArb, stateArb, configArb, (symbol, state, config) => {
        const decision = evaluateOrder({ intent: "exit", symbol }, state, config);
        expect(decision).toEqual({ allowed: true, reasons: [], measures: null });
      }),
    );
  });
});
