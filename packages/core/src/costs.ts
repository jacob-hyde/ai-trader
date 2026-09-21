/**
 * Models what a fill costs, for backtest and paper accounting.
 *
 * A buy fills at the ask plus a slippage allowance and a sell at the bid minus one, which is the
 * midpoint plus or minus the half-spread with slippage on top. No fill kind is free: config validation
 * rejects a zero allowance, so even a locked quote gives up something against the midpoint.
 *
 * Slippage depends on what triggered the order. "market" covers every order that is not stop-triggered
 * (EOD flatten, panic exits, target exits, non-stop entries). "stopEntry" and "stopExit" are stop orders
 * that become market orders into momentum, and each carries its own pessimistic allowance. The stopEntry
 * allowance is the number live-small exists to calibrate.
 *
 * No size-dependent impact term. At this account size an order is far below displayed size, so the touch
 * is a fair anchor. Is where an impact term goes once size grows.
 *
 * Bad config, bad quotes, and bad share counts are bugs or bad ticks rather than trading decisions, so
 * they throw CostModelError. A crossed quote throws MoneyError CROSSED_MARKET from the spread helper.
 */

import {
  type Fixed,
  type Ratio,
  add,
  divInt,
  max,
  mulInt,
  mulRatio,
  ratio,
  spread,
  sub,
  tickSize,
} from "./money.js";

export type Side = "buy" | "sell";

/** What triggered the order. Decides which slippage allowance applies. */
export type FillKind = "market" | "stopEntry" | "stopExit";

export interface Quote {
  readonly bid: Fixed;
  readonly ask: Fixed;
}

/** Per-share slippage beyond the touch: the larger of bps of price and a whole number of ticks. */
export interface SlippageAllowance {
  readonly bps: Ratio;
  readonly ticks: number;
}

/** Full quoted spread to assume when there is no real quote: the larger of bps of price and minTicks. */
export interface SpreadModel {
  readonly bps: Ratio;
  readonly minTicks: number;
}

export interface CommissionInput {
  readonly side: Side;
  readonly shares: number;
  readonly price: Fixed;
}

/**
 * Returns the total commission and fees for one fill, never negative.
 *
 * Alpaca charges no commission, so the default is noCommission. The hook exists for the sell-side
 * regulatory fees (SEC, FINRA TAF) and CAT, which Alpaca accrues intraday and rounds up to the cent at
 * end of day. Their rates change, so none are baked in here.
 */
export type CommissionHook = (fill: CommissionInput) => Fixed;

export const noCommission: CommissionHook = () => 0 as Fixed;

export interface CostModelConfig {
  readonly spread: SpreadModel;
  readonly slippage: Readonly<Record<FillKind, SlippageAllowance>>;
  readonly commission: CommissionHook;
}

/**
 * Engineering defaults. Assumptions, not measurements, until live-small replaces them.
 *
 * spread: 10 bps, at least one tick. Only used when a fill has no real quote (bar-only backtest).
 * In-play $5 to $100 names quote wider in the first minutes after the open than their midday penny
 * spread. 10 bps is 2 cents on a $20 name and 5 cents on a $50 name.
 *
 * market: 2 bps or one tick. A small order takes the touch. The allowance covers the quote moving
 * between the decision and the fill.
 *
 * stopEntry: 10 bps or two ticks. The ORB entry is a buy stop at the 5-minute high, which triggers
 * alongside every other breakout trader and fills as a market order into a rising ask. Deliberately
 * pessimistic, because the whole edge question hinges on it.
 *
 * stopExit: same as stopEntry. The ORB wins about 17% of the time and most of the rest end at the
 * protective stop, so modeling it at the market allowance would flatter most losers.
 *
 * Together on a $20 name: 2 cents of spread plus 2 cents on each stop leg is a 6 cent round trip,
 * against a typical 10 to 20 cent ORB stop.
 */
export const DEFAULT_COST_MODEL: CostModelConfig = {
  spread: { bps: ratio(10), minTicks: 1 },
  slippage: {
    market: { bps: ratio(2), ticks: 1 },
    stopEntry: { bps: ratio(10), ticks: 2 },
    stopExit: { bps: ratio(10), ticks: 2 },
  },
  commission: noCommission,
};

export type CostModelErrorCode =
  "INVALID_CONFIG" | "INVALID_QUOTE" | "INVALID_SHARES" | "INVALID_COMMISSION" | "NON_POSITIVE_FILL";

export class CostModelError extends Error {
  readonly code: CostModelErrorCode;

  constructor(code: CostModelErrorCode, message: string) {
    super(message);
    this.name = "CostModelError";
    this.code = code;
  }
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertAllowance(name: string, bps: number, ticks: number): void {
  if (!isCount(bps) || !isCount(ticks)) {
    throw new CostModelError("INVALID_CONFIG", `${name} needs non-negative integer bps and ticks`);
  }
  if (bps === 0 && ticks === 0) {
    throw new CostModelError("INVALID_CONFIG", `${name} is zero, which would make a fill free`);
  }
}

/**
 * Throws CostModelError when a config could produce a free or an optimistic fill.
 *
 * Every allowance and the spread model must be non-zero. Both stop kinds must be at least the market
 * allowance in bps and in ticks, and stopEntry must exceed it in at least one. A stopEntry fill is
 * strictly worse than a market fill at every price of $1 or more only when it exceeds in both, which
 * the defaults do.
 *
 * Runs on every modelFill call. Call it at boot too, so a bad config fails before the first fill.
 */
export function assertCostModelConfig(config: CostModelConfig): void {
  assertAllowance("spread model", config.spread.bps, config.spread.minTicks);
  const { market, stopEntry, stopExit } = config.slippage;
  assertAllowance("market slippage", market.bps, market.ticks);
  assertAllowance("stopEntry slippage", stopEntry.bps, stopEntry.ticks);
  assertAllowance("stopExit slippage", stopExit.bps, stopExit.ticks);
  if (stopEntry.bps < market.bps || stopEntry.ticks < market.ticks) {
    throw new CostModelError("INVALID_CONFIG", "stopEntry slippage is below market slippage");
  }
  if (stopEntry.bps === market.bps && stopEntry.ticks === market.ticks) {
    throw new CostModelError("INVALID_CONFIG", "stopEntry slippage must exceed market slippage");
  }
  if (stopExit.bps < market.bps || stopExit.ticks < market.ticks) {
    throw new CostModelError("INVALID_CONFIG", "stopExit slippage is below market slippage");
  }
}

function assertQuote(quote: Quote): void {
  if (!Number.isSafeInteger(quote.bid) || !Number.isSafeInteger(quote.ask) || quote.bid <= 0) {
    throw new CostModelError("INVALID_QUOTE", `quote needs a positive bid, got ${String(quote.bid)}`);
  }
  spread(quote.bid, quote.ask);
}

/** Per-share slippage at a price, rounded up to $0.0001 so rounding never favors the fill. */
export function slippagePerShare(price: Fixed, allowance: SlippageAllowance): Fixed {
  return max(mulRatio(price, allowance.bps, "ceil"), mulInt(tickSize(price), allowance.ticks));
}

/**
 * Builds a synthetic quote around a reference price, for fills that have no real quote.
 *
 * The reference is whatever price the simulator says the order acted at: a bar price, a stop trigger,
 * or the open after a gap through the trigger. The half-spread rounds up, so the synthetic spread is
 * never narrower than the model asks for.
 */
export function quoteFromReference(reference: Fixed, model: SpreadModel): Quote {
  assertAllowance("spread model", model.bps, model.minTicks);
  if (!Number.isSafeInteger(reference) || reference <= 0) {
    throw new CostModelError("INVALID_QUOTE", `reference price must be positive, got ${String(reference)}`);
  }
  const width = max(mulRatio(reference, model.bps, "ceil"), mulInt(tickSize(reference), model.minTicks));
  const half = divInt(width, 2, "ceil");
  const bid = sub(reference, half);
  if (bid <= 0) {
    throw new CostModelError("INVALID_QUOTE", "modeled spread is wider than the reference price");
  }
  return { bid, ask: add(reference, half) };
}

export interface FillRequest {
  readonly side: Side;
  readonly kind: FillKind;
  readonly quote: Quote;
  readonly shares: number;
}

export interface ModeledFill {
  readonly side: Side;
  readonly kind: FillKind;
  readonly shares: number;
  /** Ask for a buy, bid for a sell. */
  readonly touch: Fixed;
  /** Per share, beyond the touch. */
  readonly slippage: Fixed;
  /** Per share, after spread and slippage. */
  readonly price: Fixed;
  /** price times shares. Excludes commission. */
  readonly notional: Fixed;
  readonly commission: Fixed;
  /** Total dollars given up against the midpoint, commission included. Always positive. */
  readonly costVsMid: Fixed;
}

/**
 * Prices one fill against a quote.
 *
 * For a stop-triggered fill in a bar-only backtest, pass quoteFromReference(trigger). The quote sits
 * around the trigger, so the fill pays the half-spread beyond it and then the stop allowance.
 *
 * Throws NON_POSITIVE_FILL when a sell's slippage reaches the bid. Only reachable on sub-penny prices.
 */
export function modelFill(request: FillRequest, config: CostModelConfig): ModeledFill {
  assertCostModelConfig(config);
  assertQuote(request.quote);
  const { side, kind, quote, shares } = request;
  if (!Number.isSafeInteger(shares) || shares < 1) {
    throw new CostModelError("INVALID_SHARES", `shares must be a positive integer, got ${String(shares)}`);
  }
  const touch = side === "buy" ? quote.ask : quote.bid;
  const slippage = slippagePerShare(touch, config.slippage[kind]);
  const price = side === "buy" ? add(touch, slippage) : sub(touch, slippage);
  if (price <= 0) {
    throw new CostModelError("NON_POSITIVE_FILL", "slippage is at least the bid, fill price is not positive");
  }
  const commission = config.commission({ side, shares, price });
  if (!Number.isSafeInteger(commission) || commission < 0) {
    throw new CostModelError("INVALID_COMMISSION", `commission hook returned ${String(commission)}`);
  }
  // Twice the per-share distance from the midpoint, so an odd spread stays exact until the final halving.
  const twiceMid = add(quote.bid, quote.ask);
  const twiceGap = side === "buy" ? sub(mulInt(price, 2), twiceMid) : sub(twiceMid, mulInt(price, 2));
  const costVsMid = add(divInt(mulInt(twiceGap, shares), 2, "ceil"), commission);
  return {
    side,
    kind,
    shares,
    touch,
    slippage,
    price,
    notional: mulInt(price, shares),
    commission,
    costVsMid,
  };
}

/**
 * Expected per-share cost of entering and exiting at a quote: the full spread plus both slippage legs.
 *
 * Is the numerator of the cost-to-risk gate and the cost input to sizing. Excludes commission, which is
 * not per-share. Both legs are evaluated at the ask, the higher price, so it is never below what
 * modelFill charges for the same round trip at that quote, long or short.
 */
export function roundTripCostPerShare(
  quote: Quote,
  entryKind: FillKind,
  exitKind: FillKind,
  config: CostModelConfig,
): Fixed {
  assertCostModelConfig(config);
  assertQuote(quote);
  const entry = slippagePerShare(quote.ask, config.slippage[entryKind]);
  const exit = slippagePerShare(quote.ask, config.slippage[exitKind]);
  return add(spread(quote.bid, quote.ask), add(entry, exit));
}
