/**
 * What a run records: one row per signal per variant, and every fill.
 *
 * R is measured the way the trade simulator measures it, against the plan's entry-to-stop distance:
 * gross from reference to reference (what the bars gave), net from fill to fill less fees (what the
 * account kept). Both floor to basis points of R, so rounding never flatters a result.
 */

import type { Direction, Fill, Fixed, Ratio, SessionDate } from "@trader/contracts";
import type { FillKind } from "@trader/core";
import { add, divToRatio, mulInt, neg, sub } from "@trader/core";

export type EntryOutcome = "refused" | "filled" | "canceled" | "expired";

/**
 * How a filled trade ended. "flatten" is the engine's own flatten before the close. "close" is the
 * broker closing what the engine left open at the bell, which happens only when a symbol printed no bar
 * after the flatten minute: it exits at its last close, as the trade simulator does when bars run out.
 */
export type ExitReason = "stop" | "breakevenStop" | "target" | "flatten" | "close";

export interface TradeRecord {
  readonly variant: string;
  readonly symbol: string;
  readonly session: SessionDate;
  readonly direction: Direction;
  readonly rank: number;
  readonly openingRvol: Ratio;
  readonly dailyAtr: Fixed;
  readonly priorClose: Fixed;
  /** The minute that proved the opening range closed. */
  readonly signalMinute: number;
  readonly entry: Fixed;
  /** Null when the setup could not state a plan for the signal (refusal "plan: ..."). */
  readonly stop: Fixed | null;
  readonly target: Fixed | null;
  readonly costPerShare: Fixed | null;
  /** Basis points of R, rounded up by the gate. Null when the gate could not evaluate the signal. */
  readonly costToRisk: Ratio | null;
  readonly gatePassed: boolean;
  /** Why no order went in, as "stage: reasons". Null when one did. */
  readonly refusal: string | null;
  readonly shares: number;
  readonly entryOutcome: EntryOutcome;
  readonly entryMinute: number | null;
  readonly entryReference: Fixed | null;
  readonly entryFill: Fixed | null;
  readonly exitMinute: number | null;
  readonly exitReason: ExitReason | null;
  readonly exitReference: Fixed | null;
  readonly exitFill: Fixed | null;
  readonly grossPnl: Fixed | null;
  readonly netPnl: Fixed | null;
  readonly grossR: Ratio | null;
  readonly netR: Ratio | null;
}

export interface FillRecord {
  readonly fillId: string;
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly leg: string;
  readonly symbol: string;
  readonly side: Fill["side"];
  readonly quantity: number;
  readonly price: Fixed;
  readonly reference: Fixed;
  readonly kind: FillKind;
  readonly fees: Fixed;
  readonly at: string;
  /** Minute of the session the fill happened in. Not persisted: the timestamp carries it. */
  readonly minute: number;
}

export interface TradeResult {
  readonly grossPnl: Fixed;
  readonly netPnl: Fixed;
  readonly grossR: Ratio;
  readonly netR: Ratio;
}

/** P&L and R of a round trip. Same arithmetic as simulateTrade. */
export function resultOf(
  direction: Direction,
  plannedEntry: Fixed,
  stop: Fixed,
  entry: FillRecord,
  exit: FillRecord,
): TradeResult {
  const long = direction === "long";
  const signed = (value: Fixed): Fixed => (long ? value : neg(value));
  const riskPerShare = long ? sub(plannedEntry, stop) : sub(stop, plannedEntry);
  const shares = entry.quantity;
  const grossPnl = mulInt(signed(sub(exit.reference, entry.reference)), shares);
  const netPnl = sub(mulInt(signed(sub(exit.price, entry.price)), shares), add(entry.fees, exit.fees));
  const riskDollars = mulInt(riskPerShare, shares);
  return {
    grossPnl,
    netPnl,
    grossR: divToRatio(grossPnl, riskDollars, "floor"),
    netR: divToRatio(netPnl, riskDollars, "floor"),
  };
}
