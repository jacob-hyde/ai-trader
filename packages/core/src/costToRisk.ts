/**
 * Gates a candidate on what its round trip costs relative to its stop.
 *
 * The ratio is the modeled per-share round-trip cost over the per-share stop distance, which is the cost
 * of the trade in R. Independent of account size and share count. Is the dominant survival filter for a
 * tight-stop strategy: an $0.08 round trip against a $0.10 stop is 0.8R, and against a $0.50 stop it is
 * 0.16R. In effect it prefers high-ATR, tight-spread names.
 *
 * Both legs default to the stop-triggered allowances. The entry is a stop order by construction, and
 * most ORB losers leave at the protective stop, so the market allowance on the exit would understate the
 * typical trade. Both kinds are config.
 *
 * A crossed or non-positive quote, or a non-positive stop distance, is rejected with a reason rather
 * than thrown, so one bad tick never stops the scan. A bad config throws CostModelError.
 *
 * Sizing rejects at 1R of cost. This gate is the tunable threshold that sits well below that floor.
 */

import {
  type CostModelConfig,
  type FillKind,
  type Quote,
  CostModelError,
  roundTripCostPerShare,
} from "./costs.js";
import { type Fixed, type Ratio, ONE_HUNDRED_PERCENT, divToRatio, ratio } from "./money.js";

export interface CostToRiskConfig {
  /** Highest acceptable cost in basis points of R: 1 500 is 0.15R. */
  readonly maxCostToRisk: Ratio;
  readonly entryKind: FillKind;
  readonly exitKind: FillKind;
}

/** Above 1R the gate would pass candidates that sizing rejects outright. */
export const COST_TO_RISK_BOUNDS = {
  maxCostToRisk: { min: ratio(1), max: ONE_HUNDRED_PERCENT },
} as const;

/** 0.15R, from the plan. A +0.08R gross edge has no room for more. */
export const DEFAULT_COST_TO_RISK: CostToRiskConfig = {
  maxCostToRisk: ratio(1_500),
  entryKind: "stopEntry",
  exitKind: "stopExit",
};

export interface CostToRiskInput {
  readonly quote: Quote;
  /** Per-share distance from entry to stop. */
  readonly stopDistance: Fixed;
}

export type CostToRiskRejectionReason = "COST_TO_RISK_ABOVE_MAX" | "INVALID_STOP_DISTANCE" | "INVALID_QUOTE";

export interface CostToRiskPass {
  readonly passed: true;
  /** Hand this to sizing as roundTripCostPerShare. */
  readonly costPerShare: Fixed;
  /** Basis points of R, rounded up. */
  readonly costToRisk: Ratio;
  readonly maxCostToRisk: Ratio;
}

export interface CostToRiskRejection {
  readonly passed: false;
  readonly reason: CostToRiskRejectionReason;
  /** Null when the input could not be evaluated. */
  readonly costPerShare: Fixed | null;
  readonly costToRisk: Ratio | null;
  readonly maxCostToRisk: Ratio;
}

export type CostToRiskResult = CostToRiskPass | CostToRiskRejection;

/** Throws CostModelError INVALID_CONFIG when the threshold is outside COST_TO_RISK_BOUNDS. */
export function assertCostToRiskConfig(config: CostToRiskConfig): void {
  const { min, max } = COST_TO_RISK_BOUNDS.maxCostToRisk;
  const value = config.maxCostToRisk;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new CostModelError(
      "INVALID_CONFIG",
      `maxCostToRisk must be within [${String(min)}, ${String(max)}] bps of R, got ${String(value)}`,
    );
  }
}

/**
 * Evaluates one candidate. Passes when cost over stop distance is at or below the threshold.
 *
 * The ratio rounds up, which never flips a verdict because the threshold is a whole number of basis
 * points. The result always carries the ratio when it could be computed, so the decision log shows how
 * close a candidate was.
 */
export function evaluateCostToRisk(
  input: CostToRiskInput,
  config: CostToRiskConfig,
  costModel: CostModelConfig,
): CostToRiskResult {
  assertCostToRiskConfig(config);
  const { quote, stopDistance } = input;
  const { maxCostToRisk } = config;
  const unevaluated = { passed: false, costPerShare: null, costToRisk: null, maxCostToRisk } as const;

  if (!Number.isSafeInteger(stopDistance) || stopDistance <= 0) {
    return { ...unevaluated, reason: "INVALID_STOP_DISTANCE" };
  }
  const wellFormed = Number.isSafeInteger(quote.bid) && Number.isSafeInteger(quote.ask);
  if (!wellFormed || quote.bid <= 0 || quote.ask < quote.bid) {
    return { ...unevaluated, reason: "INVALID_QUOTE" };
  }

  const costPerShare = roundTripCostPerShare(quote, config.entryKind, config.exitKind, costModel);
  const costToRisk = divToRatio(costPerShare, stopDistance, "ceil");
  if (costToRisk > maxCostToRisk) {
    return { passed: false, reason: "COST_TO_RISK_ABOVE_MAX", costPerShare, costToRisk, maxCostToRisk };
  }
  return { passed: true, costPerShare, costToRisk, maxCostToRisk };
}
