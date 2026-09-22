/**
 * Plays one trade plan forward over closed one-minute bars and reports what it would have made.
 *
 * Is the mechanics the golden cases, the synthetic-path harness, and the backtest adapter share. Pure:
 * bars in, outcome out. Every fill goes through the cost model, so no outcome is frictionless.
 *
 * A bar only says where price went, not in what order, so every ambiguity resolves against the trade:
 *
 * - A bar that reaches both the stop and anything favorable is a stop-out. That includes the entry bar:
 *   a bar that triggers the entry and also reaches the stop is an entry and a loss.
 * - A gap through a level fills at the bar's open, never at the level. A gap through the entry buys
 *   higher and a gap through the stop sells lower.
 * - A target never fills better than its limit price, and still pays the market allowance.
 * - A move to breakeven arms on the bar that reaches its threshold and protects from the next bar on,
 *   because the monitor that moves the stop cannot act inside the bar that woke it.
 *
 * R is always measured against the plan's entry-to-stop distance, so a gap shows up as more than -1R
 * and slippage shows up as the gap between gross and net. Both floor, so rounding never flatters.
 *
 * The order cannot exist before its signal, so only bars after the signal's minute are read. Bars that
 * are still forming, malformed, or from another session are skipped. There is no bad-tick filter here:
 * a spike through the entry fills it, as it would at the broker. Filtering bad prints is upstream work.
 *
 * Only stop entries are simulated, which is the only kind ORB produces. A plan whose stop is not on the
 * risk side of entry comes back unfilled as INVALID_PLAN, since it has no R to measure in.
 */

import { type Bar, isWellFormedBar } from "./bars.js";
import { type CostModelConfig, type FillKind, type Side, modelFill, quoteFromReference } from "./costs.js";
import { type Fixed, type Ratio, add, divToRatio, max, min, mulInt, mulRatio, neg, sub } from "./money.js";
import type { TradePlan } from "./setup.js";

export interface SimulationOptions {
  readonly shares: number;
  readonly costModel: CostModelConfig;
  /** An entry that has not filled before this minute never fills. */
  readonly lastEntryMinute: number;
  /** An open position is flattened at the open of the first bar at or after this minute. */
  readonly flattenMinute: number;
}

export type ExitReason = "stop" | "breakevenStop" | "target" | "eod";

export type UnfilledReason = "NEVER_TRIGGERED" | "UNSUPPORTED_ENTRY_TYPE" | "INVALID_PLAN";

export interface UnfilledTrade {
  readonly filled: false;
  readonly reason: UnfilledReason;
}

export interface FilledTrade {
  readonly filled: true;
  readonly shares: number;
  /** The plan's entry-to-stop distance per share. The R every result is measured in. */
  readonly riskPerShare: Fixed;
  readonly entryMinute: number;
  /** The price the entry acted at before costs: the trigger, or the bar's open on a gap through it. */
  readonly entryReference: Fixed;
  readonly entryFill: Fixed;
  readonly exitMinute: number;
  readonly exitReason: ExitReason;
  /** The price the exit acted at before costs. */
  readonly exitReference: Fixed;
  readonly exitFill: Fixed;
  /** Reference to reference, in dollars. What the bars gave. */
  readonly grossPnl: Fixed;
  /** Fill to fill, less commissions, in dollars. What the account kept. */
  readonly netPnl: Fixed;
  /** In basis points of R, floored. -10 000 is a full 1R loss. */
  readonly grossR: Ratio;
  readonly netR: Ratio;
}

export type TradeOutcome = UnfilledTrade | FilledTrade;

interface Leg {
  readonly minute: number;
  readonly reference: Fixed;
  readonly kind: FillKind;
}

/**
 * Simulates the plan over the bars that follow its signal.
 *
 * A position still open when the bars run out exits at the last bar's close as "eod", so a half day or
 * a truncated series still flattens. Throws whatever the cost model throws on a bad config or shares.
 */
export function simulateTrade(
  plan: TradePlan,
  bars: readonly Bar[],
  options: SimulationOptions,
): TradeOutcome {
  const { signal, target, management } = plan;
  if (signal.entryType !== "stop") {
    return { filled: false, reason: "UNSUPPORTED_ENTRY_TYPE" };
  }
  const long = signal.direction === "long";
  const riskPerShare = long ? sub(signal.entry, plan.stop) : sub(plan.stop, signal.entry);
  if (riskPerShare <= 0) {
    return { filled: false, reason: "INVALID_PLAN" };
  }
  // Everything below is written for a long. A short is the same logic on mirrored prices.
  const beyond = (price: Fixed, level: Fixed): boolean => (long ? price >= level : price <= level);
  const favorable = (bar: Bar): Fixed => (long ? bar.high : bar.low);
  const adverse = (bar: Bar): Fixed => (long ? bar.low : bar.high);
  const worseOf = (a: Fixed, b: Fixed): Fixed => (long ? min(a, b) : max(a, b));
  const costlierOf = (a: Fixed, b: Fixed): Fixed => (long ? max(a, b) : min(a, b));

  const breakevenTrigger =
    management.breakevenAtR === null
      ? null
      : long
        ? add(signal.entry, mulRatio(riskPerShare, management.breakevenAtR, "ceil"))
        : sub(signal.entry, mulRatio(riskPerShare, management.breakevenAtR, "ceil"));

  const live = bars.filter(
    (bar) =>
      bar.closed &&
      isWellFormedBar(bar) &&
      bar.session === signal.session &&
      bar.minuteOfSession > signal.minuteOfSession,
  );

  let entry: Leg | null = null;
  let exit: (Leg & { readonly reason: ExitReason }) | null = null;
  let stop = plan.stop;
  let atBreakeven = false;
  let last: Bar | null = null;

  for (const bar of live) {
    if (entry === null) {
      if (bar.minuteOfSession >= Math.min(options.lastEntryMinute, options.flattenMinute)) {
        break;
      }
      if (!beyond(favorable(bar), signal.entry)) {
        continue;
      }
      entry = {
        minute: bar.minuteOfSession,
        reference: costlierOf(signal.entry, bar.open),
        kind: "stopEntry",
      };
    } else if (bar.minuteOfSession >= options.flattenMinute) {
      exit = { minute: bar.minuteOfSession, reference: bar.open, kind: "market", reason: "eod" };
      break;
    }
    last = bar;

    // Entry bar or not, the stop is checked first: the pessimistic ordering.
    if (beyond(stop, adverse(bar))) {
      // On the entry bar the open came before the entry, so only a later bar can gap through the stop.
      const gapped = bar.minuteOfSession === entry.minute ? stop : worseOf(stop, bar.open);
      exit = {
        minute: bar.minuteOfSession,
        reference: gapped,
        kind: "stopExit",
        reason: atBreakeven ? "breakevenStop" : "stop",
      };
      break;
    }
    if (target !== null && beyond(favorable(bar), target)) {
      exit = { minute: bar.minuteOfSession, reference: target, kind: "market", reason: "target" };
      break;
    }
    if (breakevenTrigger !== null && !atBreakeven && beyond(favorable(bar), breakevenTrigger)) {
      stop = signal.entry;
      atBreakeven = true;
    }
  }

  if (entry === null) {
    return { filled: false, reason: "NEVER_TRIGGERED" };
  }
  // Bars ran out with the position open: flatten at the last close seen.
  const closing = exit ?? {
    minute: (last as Bar).minuteOfSession,
    reference: (last as Bar).close,
    kind: "market" as const,
    reason: "eod" as const,
  };

  const entrySide: Side = long ? "buy" : "sell";
  const exitSide: Side = long ? "sell" : "buy";
  const fill = (side: Side, leg: Leg) =>
    modelFill(
      {
        side,
        kind: leg.kind,
        quote: quoteFromReference(leg.reference, options.costModel.spread),
        shares: options.shares,
      },
      options.costModel,
    );
  const entryFill = fill(entrySide, entry);
  const exitFill = fill(exitSide, closing);

  const signed = (value: Fixed): Fixed => (long ? value : neg(value));
  const grossPerShare = signed(sub(closing.reference, entry.reference));
  const netPerShare = signed(sub(exitFill.price, entryFill.price));
  const grossPnl = mulInt(grossPerShare, options.shares);
  const netPnl = sub(mulInt(netPerShare, options.shares), add(entryFill.commission, exitFill.commission));
  const riskDollars = mulInt(riskPerShare, options.shares);

  return {
    filled: true,
    shares: options.shares,
    riskPerShare,
    entryMinute: entry.minute,
    entryReference: entry.reference,
    entryFill: entryFill.price,
    exitMinute: closing.minute,
    exitReason: closing.reason,
    exitReference: closing.reference,
    exitFill: exitFill.price,
    grossPnl,
    netPnl,
    grossR: divToRatio(grossPnl, riskDollars, "floor"),
    netR: divToRatio(netPnl, riskDollars, "floor"),
  };
}
