/**
 * Decides whether a proposed order may go out.
 *
 * Every entry passes through here, whatever proposed it: a setup, the approval queue, or the LLM. The
 * proposer proposes, this disposes. The verdict is allow or a veto carrying every rule that failed, as
 * enumerated codes the decision log and the GUI can aggregate.
 *
 * Only entries are gated. An exit is allowed before anything else is looked at, including the config, so
 * a flatten can never be blocked by a tripped breaker, a bad config, or garbage state. Labeling an order
 * as an exit is the caller's responsibility.
 *
 * Entries fail closed. State or a proposal that cannot be evaluated is a veto, never an allow and never
 * a throw. A config outside RISK_CONFIG_BOUNDS is a bug and throws RiskError.
 *
 * Caps are dollars floored from current equity, and a value exactly at a cap is allowed. The breaker and
 * the daily budget use start-of-day equity so their thresholds do not drift intraday.
 *
 * The rules recompute notional and risk from shares, entry, and stop. Nothing a proposer claims about
 * its own risk is trusted.
 */

import { type Fixed, type Ratio, ZERO, add, max, mulInt, mulRatio, ratio, sub } from "./money.js";
import type { Direction } from "./sizing.js";

export interface RiskConfig {
  /** Per-symbol notional cap as a fraction of equity. */
  readonly maxPositionPct: Ratio;
  /** Total notional cap as a fraction of equity. 100% is the self-imposed 1x. */
  readonly maxGrossExposure: Ratio;
  /** Distinct symbols held or working at once. */
  readonly maxConcurrentPositions: number;
  /** Ceiling on summed entry-to-stop risk across all exposures, as a fraction of equity. */
  readonly maxOpenRisk: Ratio;
  /** Day loss, as a fraction of start-of-day equity, that trips the breaker. Also the daily risk budget. */
  readonly dailyLossLimit: Ratio;
  /** Whether a tripped breaker also asks the engine to flatten. Halting new entries is unconditional. */
  readonly flattenOnBreaker: boolean;
}

/** Inclusive bounds every RiskConfig must sit within. Is what the config UI enforces. */
export const RISK_CONFIG_BOUNDS = {
  maxPositionPct: { min: ratio(100), max: ratio(10_000) },
  maxGrossExposure: { min: ratio(100), max: ratio(40_000) },
  maxConcurrentPositions: { min: 1, max: 20 },
  maxOpenRisk: { min: ratio(1), max: ratio(1_000) },
  dailyLossLimit: { min: ratio(10), max: ratio(1_000) },
} as const;

/**
 * The plan's target posture at its conservative ends: 25% per position, 1x gross, 4 concurrent, 2% open
 * risk, 5% daily loss. Flatten is off because the plan makes it optional and every position already
 * carries a broker-side stop.
 */
export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxPositionPct: ratio(2_500),
  maxGrossExposure: ratio(10_000),
  maxConcurrentPositions: 4,
  maxOpenRisk: ratio(200),
  dailyLossLimit: ratio(500),
  flattenOnBreaker: false,
};

export interface AccountState {
  /** Marked to market now. */
  readonly equity: Fixed;
  readonly startOfDayEquity: Fixed;
  /** Closed-trade P&L for the session. Open positions are covered by open risk instead. */
  readonly realizedPnlToday: Fixed;
}

/**
 * An open position or a working entry order. Both count, because a working stop entry can fill at any
 * moment. A null stop marks a position with no protective stop at the broker.
 */
export interface Exposure {
  readonly symbol: string;
  readonly direction: Direction;
  readonly shares: number;
  readonly entry: Fixed;
  readonly stop: Fixed | null;
}

/** Latched for the session once tripped. The engine starts each session from BREAKER_ARMED. */
export interface BreakerState {
  readonly tripped: boolean;
}

export const BREAKER_ARMED: BreakerState = { tripped: false };

export interface PortfolioState {
  readonly account: AccountState;
  readonly exposures: readonly Exposure[];
  readonly breaker: BreakerState;
}

export interface ProposedEntry {
  readonly intent: "entry";
  readonly symbol: string;
  readonly direction: Direction;
  readonly shares: number;
  readonly entry: Fixed;
  readonly stop: Fixed;
}

export interface ProposedExit {
  readonly intent: "exit";
  readonly symbol: string;
}

export type ProposedOrder = ProposedEntry | ProposedExit;

/** Every veto code, in the order a decision reports them. Stable: the decision log aggregates on these. */
export const RISK_VETO_REASONS = [
  "INVALID_STATE",
  "INVALID_PROPOSAL",
  "DAILY_LOSS_BREAKER",
  "UNPROTECTED_POSITION",
  "MAX_CONCURRENT_POSITIONS",
  "POSITION_CAP",
  "GROSS_EXPOSURE",
  "OPEN_RISK_CEILING",
  "DAILY_RISK_BUDGET",
] as const;

export type RiskVetoReason = (typeof RISK_VETO_REASONS)[number];

/** What the rules measured, with the entry included. Shows how close a decision was. */
export interface RiskMeasures {
  readonly concurrentPositions: number;
  readonly symbolNotional: Fixed;
  readonly positionCap: Fixed;
  readonly grossNotional: Fixed;
  readonly grossCap: Fixed;
  readonly openRisk: Fixed;
  readonly openRiskCeiling: Fixed;
  /** Realized loss today plus openRisk. Realized gains do not offset it. */
  readonly dailyRiskUsed: Fixed;
  readonly dailyLossLimit: Fixed;
}

export interface RiskAllow {
  readonly allowed: true;
  readonly reasons: readonly [];
  /** Null for exits, which are never measured. */
  readonly measures: RiskMeasures | null;
}

export interface RiskVeto {
  readonly allowed: false;
  readonly reasons: readonly RiskVetoReason[];
  /** Null when state or the proposal could not be evaluated. */
  readonly measures: RiskMeasures | null;
}

export type RiskDecision = RiskAllow | RiskVeto;

export type RiskErrorCode = "INVALID_CONFIG" | "INVALID_STATE";

export class RiskError extends Error {
  readonly code: RiskErrorCode;

  constructor(code: RiskErrorCode, message: string) {
    super(message);
    this.name = "RiskError";
    this.code = code;
  }
}

/** Throws RiskError INVALID_CONFIG unless every value is a whole number within RISK_CONFIG_BOUNDS. */
export function assertRiskConfig(config: RiskConfig): void {
  for (const [name, { min, max: upper }] of Object.entries(RISK_CONFIG_BOUNDS)) {
    const value = config[name as keyof typeof RISK_CONFIG_BOUNDS];
    if (!Number.isSafeInteger(value) || value < min || value > upper) {
      throw new RiskError(
        "INVALID_CONFIG",
        `${name} must be a whole number within [${String(min)}, ${String(upper)}], got ${String(value)}`,
      );
    }
  }
  if (typeof config.flattenOnBreaker !== "boolean") {
    throw new RiskError("INVALID_CONFIG", "flattenOnBreaker must be a boolean");
  }
}

function isPositiveUnits(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isValidAccount(account: AccountState): boolean {
  return (
    isPositiveUnits(account.equity) &&
    isPositiveUnits(account.startOfDayEquity) &&
    Number.isSafeInteger(account.realizedPnlToday)
  );
}

/**
 * Checks an exposure's fields, and that its notional and stop value fit the safe integer range.
 *
 * A float product of two safe integers is itself a safe integer only when the exact product is, so the
 * plain multiplications here are a sound overflow test.
 */
function isValidExposure(exposure: Exposure): boolean {
  return (
    exposure.symbol.length > 0 &&
    isPositiveUnits(exposure.shares) &&
    isPositiveUnits(exposure.entry) &&
    Number.isSafeInteger(exposure.shares * exposure.entry) &&
    (exposure.stop === null ||
      (isPositiveUnits(exposure.stop) && Number.isSafeInteger(exposure.shares * exposure.stop)))
  );
}

function isValidEntry(order: ProposedEntry): boolean {
  if (!isValidExposure(order)) {
    return false;
  }
  return order.direction === "long" ? order.stop < order.entry : order.stop > order.entry;
}

/** Entry-to-stop dollars at risk. Zero once the stop is at or beyond entry, and for a missing stop. */
function riskOf(exposure: Exposure): Fixed {
  if (exposure.stop === null) {
    return ZERO;
  }
  const perShare =
    exposure.direction === "long" ? sub(exposure.entry, exposure.stop) : sub(exposure.stop, exposure.entry);
  return mulInt(max(perShare, ZERO), exposure.shares);
}

function lossLimitDollars(account: AccountState, config: RiskConfig): Fixed {
  return mulRatio(account.startOfDayEquity, config.dailyLossLimit, "floor");
}

function isAtLossLimit(account: AccountState, config: RiskConfig): boolean {
  return sub(account.startOfDayEquity, account.equity) >= lossLimitDollars(account, config);
}

function notionalOf(exposure: Exposure): Fixed {
  return mulInt(exposure.entry, exposure.shares);
}

function measure(order: ProposedEntry, state: PortfolioState, config: RiskConfig): RiskMeasures {
  const { account } = state;
  const all: readonly Exposure[] = [...state.exposures, order];
  const realizedLoss = max(sub(ZERO, account.realizedPnlToday), ZERO);
  const openRisk = all.map(riskOf).reduce(add, ZERO);
  return {
    concurrentPositions: new Set(all.map((exposure) => exposure.symbol)).size,
    symbolNotional: all
      .filter((exposure) => exposure.symbol === order.symbol)
      .map(notionalOf)
      .reduce(add, ZERO),
    positionCap: mulRatio(account.equity, config.maxPositionPct, "floor"),
    grossNotional: all.map(notionalOf).reduce(add, ZERO),
    grossCap: mulRatio(account.equity, config.maxGrossExposure, "floor"),
    openRisk,
    openRiskCeiling: mulRatio(account.equity, config.maxOpenRisk, "floor"),
    dailyRiskUsed: add(realizedLoss, openRisk),
    dailyLossLimit: lossLimitDollars(account, config),
  };
}

const veto = (reasons: readonly RiskVetoReason[], measures: RiskMeasures | null): RiskVeto => ({
  allowed: false,
  reasons,
  measures,
});

/**
 * Evaluates one proposed order against the portfolio.
 *
 * DAILY_LOSS_BREAKER fires on the latched state and also on the live equity, so an engine that missed a
 * breaker update still cannot enter below the threshold.
 *
 * DAILY_RISK_BUDGET keeps realized loss plus all open risk within the daily loss limit. If every stop
 * holds, stops alone cannot take the day past the breaker threshold. Realized gains do not widen it.
 *
 * UNPROTECTED_POSITION blocks all entries while any position lacks a stop. Its risk cannot be bounded.
 *
 * Adding to a held symbol counts against that symbol's cap and does not add a concurrent position.
 * Notional is shares times entry price, not marked to market.
 */
export function evaluateOrder(order: ProposedOrder, state: PortfolioState, config: RiskConfig): RiskDecision {
  if (order.intent === "exit") {
    return { allowed: true, reasons: [], measures: null };
  }
  assertRiskConfig(config);

  const unevaluable: RiskVetoReason[] = [];
  if (!isValidAccount(state.account) || !state.exposures.every(isValidExposure)) {
    unevaluable.push("INVALID_STATE");
  }
  if (!isValidEntry(order)) {
    unevaluable.push("INVALID_PROPOSAL");
  }
  if (unevaluable.length > 0) {
    return veto(unevaluable, null);
  }

  let measures: RiskMeasures;
  try {
    measures = measure(order, state, config);
  } catch {
    // Totals beyond the safe integer range. Nothing real is that large, so the state is garbage. Anything
    // else that throws here fails closed the same way.
    return veto(["INVALID_STATE"], null);
  }

  const failed: Record<RiskVetoReason, boolean> = {
    INVALID_STATE: false,
    INVALID_PROPOSAL: false,
    DAILY_LOSS_BREAKER: state.breaker.tripped || isAtLossLimit(state.account, config),
    UNPROTECTED_POSITION: state.exposures.some((exposure) => exposure.stop === null),
    MAX_CONCURRENT_POSITIONS: measures.concurrentPositions > config.maxConcurrentPositions,
    POSITION_CAP: measures.symbolNotional > measures.positionCap,
    GROSS_EXPOSURE: measures.grossNotional > measures.grossCap,
    OPEN_RISK_CEILING: measures.openRisk > measures.openRiskCeiling,
    DAILY_RISK_BUDGET: measures.dailyRiskUsed > measures.dailyLossLimit,
  };
  const reasons = RISK_VETO_REASONS.filter((reason) => failed[reason]);
  return reasons.length > 0 ? veto(reasons, measures) : { allowed: true, reasons: [], measures };
}

export interface BreakerEvaluation {
  readonly state: BreakerState;
  /** True only on the evaluation that trips it, so the engine alerts once. */
  readonly trippedNow: boolean;
  /** Tripped and the config asks for a flatten. */
  readonly flatten: boolean;
  readonly dayPnl: Fixed;
  readonly dailyLossLimit: Fixed;
}

/**
 * Advances the daily-loss breaker on an equity update.
 *
 * Trips when marked-to-market day P&L is at or below minus the limit, exactly at the threshold. Once
 * tripped it stays tripped whatever equity does next. Only a new session's BREAKER_ARMED clears it.
 *
 * The limit floors, so rounding can only trip it earlier. Throws RiskError on a bad config or on equity
 * that is not a positive whole number of units. Entries are already vetoed in that case.
 */
export function evaluateBreaker(
  state: BreakerState,
  account: AccountState,
  config: RiskConfig,
): BreakerEvaluation {
  assertRiskConfig(config);
  if (!isValidAccount(account)) {
    throw new RiskError("INVALID_STATE", "breaker needs positive equity and start-of-day equity");
  }
  const tripped = state.tripped || isAtLossLimit(account, config);
  return {
    state: { tripped },
    trippedNow: tripped && !state.tripped,
    flatten: tripped && config.flattenOnBreaker,
    dayPnl: sub(account.equity, account.startOfDayEquity),
    dailyLossLimit: lossLimitDollars(account, config),
  };
}
