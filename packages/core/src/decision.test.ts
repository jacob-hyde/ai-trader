import { describe, expect, it } from "vitest";
import { DEFAULT_COST_TO_RISK } from "./costToRisk.js";
import { DEFAULT_COST_MODEL, type Quote } from "./costs.js";
import { type DecisionConfig, type DecisionInput, decideEntry } from "./decision.js";
import { fromNumber, ratio, type Fixed } from "./money.js";
import { BREAKER_ARMED, DEFAULT_RISK_CONFIG, type PortfolioState } from "./riskRules.js";
import type { TradePlan } from "./setup.js";
import { SizingError } from "./sizing.js";

const usd = fromNumber;

const CONFIG: DecisionConfig = {
  costModel: DEFAULT_COST_MODEL,
  costToRisk: DEFAULT_COST_TO_RISK,
  sizing: { riskPerTrade: ratio(100), maxPositionPct: ratio(2_000), regime: { kind: "proven" } },
  risk: DEFAULT_RISK_CONFIG,
};

// A range-low ORB plan on a $20 name: entry 20.30, stop 19.95, no target.
function plan(overrides: Partial<TradePlan> = {}): TradePlan {
  return {
    signal: {
      setupId: "orb",
      setupVersion: "1.0.0",
      symbol: "AAA",
      direction: "long",
      session: "2026-01-05",
      minuteOfSession: 4,
      entryType: "stop",
      entry: usd(20.3),
      levels: {},
    },
    stop: usd(19.95),
    target: null,
    management: { breakevenAtR: null },
    ...overrides,
  };
}

function portfolio(equity = 2_500): PortfolioState {
  return {
    account: { equity: usd(equity), startOfDayEquity: usd(2_500), realizedPnlToday: usd(0) },
    exposures: [],
    breaker: BREAKER_ARMED,
  };
}

const quote: Quote = { bid: usd(20.21), ask: usd(20.22) };

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return { plan: plan(), quote, portfolio: portfolio(), buyingPower: usd(2_500), ...overrides };
}

describe("decideEntry", () => {
  it("approves a clean plan and carries every stage's result", () => {
    const decision = decideEntry(input(), CONFIG);
    expect(decision.approved).toBe(true);
    if (!decision.approved) {
      return;
    }
    expect(decision.costPerShare).toBe(usd(0.0506));
    expect(decision.sized).toMatchObject({ shares: 24, bindingConstraint: "notionalCap" });
    expect(decision.order).toMatchObject({
      symbol: "AAA",
      side: "buy",
      quantity: 24,
      orderClass: "oto",
      entry: { type: "stop", stopPrice: usd(20.3) },
      stopLoss: { stopPrice: usd(19.95) },
    });
  });

  it("refuses at the cost gate when the stop is too tight for the spread", () => {
    const decision = decideEntry(input({ plan: plan({ stop: usd(20.15) }) }), CONFIG);
    expect(decision).toMatchObject({ approved: false, stage: "costToRisk" });
    if (decision.approved || decision.stage !== "costToRisk") {
      return;
    }
    expect(decision.result).toMatchObject({ reason: "COST_TO_RISK_ABOVE_MAX", costToRisk: 3_374 });
  });

  it("refuses at sizing when the account cannot afford one share", () => {
    const decision = decideEntry(input({ buyingPower: usd(10) }), CONFIG);
    expect(decision).toMatchObject({ approved: false, stage: "sizing" });
    if (decision.approved || decision.stage !== "sizing") {
      return;
    }
    expect(decision.result).toMatchObject({ reason: "BELOW_ONE_SHARE", bindingConstraint: "buyingPower" });
  });

  it("refuses at the risk rules when the breaker is tripped", () => {
    const tripped: PortfolioState = { ...portfolio(), breaker: { tripped: true } };
    const decision = decideEntry(input({ portfolio: tripped }), CONFIG);
    expect(decision).toMatchObject({ approved: false, stage: "risk" });
    if (decision.approved || decision.stage !== "risk") {
      return;
    }
    expect(decision.result.reasons).toEqual(["DAILY_LOSS_BREAKER"]);
  });

  it("refuses at the bracket when a price is off the tick grid", () => {
    // The plan is a hair under 20.30, which the gate and sizing accept and the bracket refuses.
    const offTick = plan({ signal: { ...plan().signal, entry: usd(20.2999) as Fixed } });
    const decision = decideEntry(input({ plan: offTick }), CONFIG);
    expect(decision).toEqual({ approved: false, stage: "bracket", reasons: ["PRICE_OFF_TICK"] });
  });

  it("treats a short symmetrically", () => {
    const short = plan({
      signal: { ...plan().signal, direction: "short", entry: usd(19.7) },
      stop: usd(20.05),
    });
    const decision = decideEntry(input({ plan: short, quote: { bid: usd(19.78), ask: usd(19.79) } }), CONFIG);
    expect(decision.approved).toBe(true);
    if (decision.approved) {
      expect(decision.order).toMatchObject({ side: "sell", stopLoss: { stopPrice: usd(20.05) } });
    }
  });

  it("throws on a bad config, which is a bug, not a decision", () => {
    const bad: DecisionConfig = { ...CONFIG, sizing: { ...CONFIG.sizing, riskPerTrade: ratio(0) } };
    expect(() => decideEntry(input(), bad)).toThrow(SizingError);
  });
});
