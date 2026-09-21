/**
 * Sizes a position in whole shares.
 *
 * Shares are the smallest of three limits: the risk budget over the stop distance, the per-position
 * notional cap, and buying power. Every division floors, so rounding never pushes a position past a
 * limit. The result names the limit that set the size. At small equity the notional cap binds long
 * before the risk budget does, and the decision log needs to show that.
 *
 * Two regimes. "validation" also clamps to a micro cap (max shares and max notional) no matter what the
 * formula says, because its trades exist to measure fills, not to make money. "proven" is the formula
 * alone. The regime is a required input with no default, so full size is never reached by omission.
 *
 * R stays defined as entry to stop. Costs do not shrink the share count. They only reject: a stop no
 * wider than the modeled round-trip cost loses more than 1R to friction before the trade can work. Is
 * the hard floor under the tunable cost-to-risk gate.
 *
 * Market-driven problems come back as a rejection with an enumerated reason and never throw. A bad
 * config or a malformed number is a bug and throws SizingError.
 *
 * Symmetric for shorts: the stop sits above entry and the distance is the same absolute value.
 */

import {
  type Fixed,
  type Ratio,
  ONE_HUNDRED_PERCENT,
  divToCount,
  divToRatio,
  mulInt,
  mulRatio,
  sub,
} from "./money.js";

export type Direction = "long" | "short";

export type SizingRegime =
  | { readonly kind: "validation"; readonly maxShares: number; readonly maxNotional: Fixed }
  | { readonly kind: "proven" };

export interface SizingConfig {
  /** Fraction of equity risked between entry and stop. */
  readonly riskPerTrade: Ratio;
  /** Per-position notional cap as a fraction of equity. */
  readonly maxPositionPct: Ratio;
  readonly regime: SizingRegime;
}

export interface SizingInput {
  readonly direction: Direction;
  /** Expected entry price. For a stop entry, the trigger. */
  readonly entry: Fixed;
  readonly stop: Fixed;
  readonly equity: Fixed;
  /** What the caller allows this position to spend. Self-imposed 1x is enforced by the caller. */
  readonly buyingPower: Fixed;
  /** Modeled per-share cost of entering and exiting, from the cost model. */
  readonly roundTripCostPerShare: Fixed;
}

/** The limits on share count, in formula order. Ties on the binding constraint go to the earlier one. */
export const SIZING_CONSTRAINTS = [
  "risk",
  "notionalCap",
  "buyingPower",
  "microShares",
  "microNotional",
] as const;

export type SizingConstraint = (typeof SIZING_CONSTRAINTS)[number];

/** Whole-share limit from each constraint. The micro entries are null in the proven regime. */
export type SizingLimits = Readonly<Record<SizingConstraint, number | null>>;

export type SizingRejectionReason =
  "NON_POSITIVE_EQUITY" | "INVALID_PRICE" | "STOP_ON_WRONG_SIDE" | "COST_EXCEEDS_STOP" | "BELOW_ONE_SHARE";

export interface SizedPosition {
  readonly accepted: true;
  readonly shares: number;
  readonly notional: Fixed;
  /** shares times stop distance. Excludes costs. */
  readonly riskDollars: Fixed;
  /** riskDollars over equity, rounded up. */
  readonly riskOfEquity: Ratio;
  readonly stopDistance: Fixed;
  readonly bindingConstraint: SizingConstraint;
  readonly limits: SizingLimits;
}

export interface SizingRejection {
  readonly accepted: false;
  readonly reason: SizingRejectionReason;
  /** Set only for BELOW_ONE_SHARE, where a limit is what rejected the trade. */
  readonly bindingConstraint: SizingConstraint | null;
  readonly limits: SizingLimits | null;
}

export type SizingResult = SizedPosition | SizingRejection;

export class SizingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SizingError";
  }
}

function isFraction(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= ONE_HUNDRED_PERCENT;
}

/**
 * Throws SizingError on a config that cannot size anything sensibly.
 *
 * Both fractions must be above 0 and at most 100%. The micro cap needs a whole maxShares of at least 1
 * and a positive maxNotional.
 *
 * Runs on every sizePosition call. Call it at boot too, so a bad config fails before the first signal.
 */
export function assertSizingConfig(config: SizingConfig): void {
  if (!isFraction(config.riskPerTrade)) {
    throw new SizingError(`riskPerTrade must be within (0, 100%], got ${String(config.riskPerTrade)} bps`);
  }
  if (!isFraction(config.maxPositionPct)) {
    throw new SizingError(
      `maxPositionPct must be within (0, 100%], got ${String(config.maxPositionPct)} bps`,
    );
  }
  const { regime } = config;
  if (regime.kind === "validation") {
    if (!Number.isSafeInteger(regime.maxShares) || regime.maxShares < 1) {
      throw new SizingError(`micro cap maxShares must be a whole number of at least 1`);
    }
    if (!Number.isSafeInteger(regime.maxNotional) || regime.maxNotional <= 0) {
      throw new SizingError(`micro cap maxNotional must be positive`);
    }
  }
}

function reject(
  reason: SizingRejectionReason,
  bindingConstraint: SizingConstraint | null = null,
  limits: SizingLimits | null = null,
): SizingRejection {
  return { accepted: false, reason, bindingConstraint, limits };
}

/** Floors a dollar budget into whole shares at a per-share amount. A negative budget buys nothing. */
function sharesWithin(budget: Fixed, perShare: Fixed): number {
  return Math.max(0, divToCount(budget, perShare, "floor"));
}

/**
 * Sizes one candidate position, or rejects it with a reason.
 *
 * COST_EXCEEDS_STOP fires when roundTripCostPerShare is at least the stop distance. BELOW_ONE_SHARE
 * carries the constraint that floored to zero, e.g. a share price above the micro notional cap.
 */
export function sizePosition(input: SizingInput, config: SizingConfig): SizingResult {
  assertSizingConfig(config);
  const { direction, entry, stop, equity, buyingPower, roundTripCostPerShare } = input;
  for (const [name, value] of Object.entries({ entry, stop, equity, buyingPower, roundTripCostPerShare })) {
    if (!Number.isSafeInteger(value)) {
      throw new SizingError(`${name} must be a safe integer of $0.0001 units, got ${String(value)}`);
    }
  }
  if (roundTripCostPerShare < 0) {
    throw new SizingError("roundTripCostPerShare cannot be negative");
  }

  if (equity <= 0) {
    return reject("NON_POSITIVE_EQUITY");
  }
  if (entry <= 0 || stop <= 0) {
    return reject("INVALID_PRICE");
  }
  const stopDistance = direction === "long" ? sub(entry, stop) : sub(stop, entry);
  if (stopDistance <= 0) {
    return reject("STOP_ON_WRONG_SIDE");
  }
  if (roundTripCostPerShare >= stopDistance) {
    return reject("COST_EXCEEDS_STOP");
  }

  const { regime } = config;
  const riskShares = sharesWithin(mulRatio(equity, config.riskPerTrade, "floor"), stopDistance);
  const limits: SizingLimits = {
    risk: riskShares,
    notionalCap: sharesWithin(mulRatio(equity, config.maxPositionPct, "floor"), entry),
    buyingPower: sharesWithin(buyingPower, entry),
    microShares: regime.kind === "validation" ? regime.maxShares : null,
    microNotional: regime.kind === "validation" ? sharesWithin(regime.maxNotional, entry) : null,
  };

  let bindingConstraint: SizingConstraint = "risk";
  let shares = riskShares;
  for (const constraint of SIZING_CONSTRAINTS) {
    const limit = limits[constraint];
    if (limit !== null && limit < shares) {
      bindingConstraint = constraint;
      shares = limit;
    }
  }

  if (shares < 1) {
    return reject("BELOW_ONE_SHARE", bindingConstraint, limits);
  }
  const riskDollars = mulInt(stopDistance, shares);
  return {
    accepted: true,
    shares,
    notional: mulInt(entry, shares),
    riskDollars,
    riskOfEquity: divToRatio(riskDollars, equity, "ceil"),
    stopDistance,
    bindingConstraint,
    limits,
  };
}
