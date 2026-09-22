/**
 * Builds the broker order for a sized trade plan.
 *
 * One entry order with its exits attached: a stop-loss always, a take-profit when the plan has a
 * target. With both exits it is Alpaca's "bracket" class. With the stop alone, for a position that runs
 * to the EOD flatten, it is "oto". Either way the protective stop lives at the broker from the moment
 * the entry fills, so no position exists without one.
 *
 * Nothing is corrected. A price off the tick grid, a stop or target on the wrong side of entry or
 * within a penny of it, or a quantity that is not a positive whole number comes back as a rejection
 * listing every reason. Sizing ran on the plan's exact prices, so nudging one here would change the
 * risk that was approved.
 *
 * The rules are Alpaca's: whole shares, time in force day, exits at least $0.01 beyond the entry price
 * on the correct side, two decimals at or above $1.00 and four below.
 *
 * The client order id is a pure function of the trade's identity (setup, version, symbol, session,
 * direction, entry type, prices, signal minute), so asking again for the same trade yields the same id
 * and the idempotency layer can dedupe a retry. Quantity is left out on purpose: the same trade resized
 * after an equity change is still the same trade.
 */

import type { BracketEntry, BracketOrder } from "@trader/contracts";
import { PENNY, add, roundToTick, sub } from "./money.js";
import type { TradePlan } from "./setup.js";

export type { BracketEntry, BracketOrder };

/** Every rejection code, in the order a result reports them. Stable. */
export const BRACKET_REJECTION_REASONS = [
  "INVALID_IDENTITY",
  "INVALID_QUANTITY",
  "INVALID_PRICE",
  "PRICE_OFF_TICK",
  "STOP_GEOMETRY",
  "TARGET_GEOMETRY",
] as const;

export type BracketRejectionReason = (typeof BRACKET_REJECTION_REASONS)[number];

export interface BracketInput {
  readonly plan: TradePlan;
  /** Whole shares from sizing. */
  readonly shares: number;
}

export type BracketResult =
  | { readonly ok: true; readonly order: BracketOrder }
  | { readonly ok: false; readonly reasons: readonly BracketRejectionReason[] };

/** Alpaca's documented limit is longer. 48 keeps ids readable and safe under any of its endpoints. */
export const MAX_CLIENT_ORDER_ID_LENGTH = 48;

const SESSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** FNV-1a over UTF-16 code units, as eight hex digits. Not cryptographic. Only has to be stable. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Derives the deterministic client order id: setup, symbol, trade date, and a hash of the rest of the
 * trade's identity, e.g. "orb-AAPL-20260921-1a2b3c4d".
 */
export function clientOrderIdFor(plan: TradePlan): string {
  const { signal, stop, target } = plan;
  const identity = [
    signal.setupId,
    signal.setupVersion,
    signal.symbol,
    signal.session,
    signal.minuteOfSession,
    signal.direction,
    signal.entryType,
    signal.entry,
    stop,
    target ?? "none",
  ].join("|");
  return `${signal.setupId}-${signal.symbol}-${signal.session.replaceAll("-", "")}-${fnv1a(identity)}`;
}

function isPrice(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Builds the order, or rejects the plan with every reason that applies.
 *
 * STOP_GEOMETRY and TARGET_GEOMETRY mean the exit is not at least $0.01 beyond entry on its correct
 * side: below for a long's stop and above for its target, mirrored for a short. Tick and geometry are
 * only checked once every price is a positive whole number of units.
 */
export function buildBracket(input: BracketInput): BracketResult {
  const { plan, shares } = input;
  const { signal, stop, target } = plan;
  const long = signal.direction === "long";
  const clientOrderId = clientOrderIdFor(plan);
  const prices = target === null ? [signal.entry, stop] : [signal.entry, stop, target];
  const pricesValid = prices.every(isPrice);

  const failed: Record<BracketRejectionReason, boolean> = {
    INVALID_IDENTITY:
      signal.setupId.length === 0 ||
      signal.symbol.length === 0 ||
      !SESSION_PATTERN.test(signal.session) ||
      clientOrderId.length > MAX_CLIENT_ORDER_ID_LENGTH,
    INVALID_QUANTITY: !Number.isSafeInteger(shares) || shares < 1,
    INVALID_PRICE: !pricesValid,
    PRICE_OFF_TICK: pricesValid && prices.some((price) => roundToTick(price, "nearest") !== price),
    STOP_GEOMETRY: pricesValid && (long ? stop > sub(signal.entry, PENNY) : stop < add(signal.entry, PENNY)),
    TARGET_GEOMETRY:
      pricesValid &&
      target !== null &&
      (long ? target < add(signal.entry, PENNY) : target > sub(signal.entry, PENNY)),
  };
  const reasons = BRACKET_REJECTION_REASONS.filter((reason) => failed[reason]);
  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  const entry: BracketEntry =
    signal.entryType === "stop"
      ? { type: "stop", stopPrice: signal.entry }
      : signal.entryType === "limit"
        ? { type: "limit", limitPrice: signal.entry }
        : { type: "market" };
  return {
    ok: true,
    order: {
      clientOrderId,
      symbol: signal.symbol,
      side: long ? "buy" : "sell",
      quantity: shares,
      timeInForce: "day",
      orderClass: target === null ? "oto" : "bracket",
      entry,
      stopLoss: { stopPrice: stop },
      takeProfit: target === null ? null : { limitPrice: target },
    },
  };
}
