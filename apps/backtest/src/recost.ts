/**
 * Prices a recorded trade's fills again under changed costs, for section 7's cost sensitivity and the
 * break-even stop-entry allowance B.
 *
 * The trades stay the same. Which trades happened and where each fill acted (its reference: the trigger,
 * the stop, the target, a gapping open, the flatten bar's open) come from the bars, not from costs, so
 * only the fill prices move. Each fill is priced the way the simulated broker prices it (core's
 * modelFill on a quote built around the reference), with the slippage changed as asked. With nothing
 * changed this reproduces every recorded fill and net R to the unit, and the diagnostics check that it
 * does before trusting anything else it says.
 *
 * The cost-to-risk gate is not run again: a signal the gate passed at the modeled costs stays in. The
 * question is how much of the measured result survives dearer fills, not which other signals would have
 * been taken.
 */

import type { Direction, Fixed, Ratio } from "@trader/contracts";
import {
  type CostModelConfig,
  type FillKind,
  add,
  divToRatio,
  mulInt,
  neg,
  quoteFromReference,
  slippagePerShare,
  sub,
} from "@trader/core";
import type { ExitReason, TradeRecord } from "./records.js";

export interface Recost {
  /** Multiplies every fill kind's per-share slippage, rounded up to $0.0001 against the fill. */
  readonly slippageScale?: number;
  /**
   * The stop entry's allowance as this many basis points of its touch, with no tick floor. Fractions of
   * a basis point are allowed, for the break-even search; the result rounds up to $0.0001.
   */
  readonly stopEntryBps?: number;
}

export interface Repriced {
  readonly entryFill: Fixed;
  readonly exitFill: Fixed;
  readonly netR: Ratio;
}

/** A protective stop fills as a stop exit; a target, a flatten, and the bell as market orders. */
export function exitKindOf(reason: ExitReason): FillKind {
  return reason === "stop" || reason === "breakevenStop" ? "stopExit" : "market";
}

function price(
  side: "buy" | "sell",
  kind: FillKind,
  reference: Fixed,
  shares: number,
  model: CostModelConfig,
  recost: Recost,
): { price: Fixed; fees: Fixed } {
  const quote = quoteFromReference(reference, model.spread);
  const touch = side === "buy" ? quote.ask : quote.bid;
  const base =
    kind === "stopEntry" && recost.stopEntryBps !== undefined
      ? (Math.ceil((touch * recost.stopEntryBps) / 10_000 - 1e-9) as Fixed)
      : slippagePerShare(touch, model.slippage[kind]);
  const slip = (recost.slippageScale === undefined ? base : Math.ceil(base * recost.slippageScale)) as Fixed;
  const filled = side === "buy" ? add(touch, slip) : sub(touch, slip);
  return { price: filled, fees: model.commission({ side, shares, price: filled }) };
}

/** Throws when the trade did not fill both ways, which leaves nothing to price. */
export function reprice(trade: TradeRecord, model: CostModelConfig, recost: Recost = {}): Repriced {
  const { entryReference, exitReference, exitReason, stop } = trade;
  if (entryReference === null || exitReference === null || exitReason === null || stop === null) {
    throw new Error(`${trade.variant} ${trade.symbol} ${trade.session} did not fill both ways`);
  }
  const long = (trade.direction as Direction) === "long";
  const entry = price(long ? "buy" : "sell", "stopEntry", entryReference, trade.shares, model, recost);
  const exit = price(
    long ? "sell" : "buy",
    exitKindOf(exitReason),
    exitReference,
    trade.shares,
    model,
    recost,
  );
  const signed = (value: Fixed): Fixed => (long ? value : neg(value));
  const riskPerShare = long ? sub(trade.entry, stop) : sub(stop, trade.entry);
  const netPnl = sub(mulInt(signed(sub(exit.price, entry.price)), trade.shares), add(entry.fees, exit.fees));
  return {
    entryFill: entry.price,
    exitFill: exit.price,
    netR: divToRatio(netPnl, mulInt(riskPerShare, trade.shares), "floor"),
  };
}
