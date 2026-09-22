/**
 * A broker that fills orders against closed bars, with every fill priced by the cost model.
 *
 * The execution half for any replay: the synthetic sessions today, stored rows in the backtest. It
 * holds orders, positions, and cash, and the replay loop hands it one bar at a time through onBar
 * before the engine sees that bar. So an order submitted after bar m first meets bar m + 1, as it would
 * at a real broker.
 *
 * Its rules are the trade simulator's, restated event by event, and a test holds the two to the same
 * answer on the same bars:
 *
 * - A stop entry fills when the bar reaches its trigger, at the trigger or at the open if the bar
 *   gapped through it. A limit entry fills at its limit, never better. A market entry fills at the open.
 * - On the bar that fills the entry, the stop-loss is checked first, at the stop, and then the
 *   take-profit. A bar that reaches both is a loss.
 * - On later bars the stop-loss fills at the stop or at the open if the bar gapped through it, and it
 *   is checked before the take-profit. A take-profit fills at its limit, never better.
 * - A flatten fills at the open of the next bar.
 * - The stop-loss pays the stop-exit allowance, everything else the market allowance, and the entry
 *   the stop-entry allowance when it was a stop.
 *
 * Whole fills only. Partial fills belong to the paper and live adapters, where the broker decides.
 *
 * Cash and equity are kept exactly. Equity is cash plus positions marked at the last close. Buying
 * power is equity not already in a position, which is the self-imposed 1x.
 */

import type {
  Account,
  BracketOrder,
  Fill,
  Fixed,
  IsoTimestamp,
  Order,
  Position,
  SessionDate,
  SymbolBar,
} from "@trader/contracts";
import { TERMINAL_ORDER_STATUSES, fixed } from "@trader/contracts";
import {
  type CostModelConfig,
  type FillKind,
  add,
  assertCostModelConfig,
  max,
  min,
  modelFill,
  mulInt,
  neg,
  quoteFromReference,
  sub,
} from "@trader/core";
import { AdapterError, type ExecutionAdapter, type ExecutionEvents, type ReplaceRequest } from "./adapter.js";
import type { SessionClock } from "./clock.js";
import { Emitter } from "./events.js";

export interface SimulatedExecutionConfig {
  readonly costModel: CostModelConfig;
  readonly startingCash: Fixed;
  readonly clock: SessionClock;
  /** Where time stands before the first bar. */
  readonly start: { readonly session: SessionDate; readonly minuteOfSession: number };
}

interface Holding {
  readonly quantity: number;
  readonly averageEntryPrice: Fixed;
  readonly openedAt: IsoTimestamp;
  lastPrice: Fixed;
}

interface Bracket {
  readonly request: BracketOrder;
  entryId: string;
  stopLossId: string;
  takeProfitId: string | null;
  flattenId: string | null;
  holding: Holding | null;
  done: boolean;
}

export class SimulatedExecution extends Emitter<ExecutionEvents> implements ExecutionAdapter {
  readonly #config: SimulatedExecutionConfig;
  readonly #orders = new Map<string, Order>();
  readonly #brackets = new Map<string, Bracket>();
  #cash: Fixed;
  #now: { session: SessionDate; minuteOfSession: number };
  #fillSequence = 0;
  #replaceSequence = 0;

  constructor(config: SimulatedExecutionConfig) {
    super();
    assertCostModelConfig(config.costModel);
    if (!Number.isSafeInteger(config.startingCash) || config.startingCash <= 0) {
      throw new AdapterError("UNSUPPORTED", "startingCash must be a positive whole number of units", false);
    }
    this.#config = config;
    this.#cash = config.startingCash;
    this.#now = { ...config.start };
  }

  /** The instant between bars, the close of the last bar seen. */
  get now(): IsoTimestamp {
    return this.#config.clock(this.#now.session, this.#now.minuteOfSession);
  }

  submitBracket(order: BracketOrder): Promise<readonly Order[]> {
    const existing = this.#brackets.get(order.clientOrderId);
    if (existing !== undefined) {
      return Promise.resolve(this.#legsOf(existing));
    }
    const exitSide = order.side === "buy" ? "sell" : "buy";
    const at = this.now;
    const base = {
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      quantity: order.quantity,
      filledQuantity: 0,
      averageFillPrice: null,
      replaces: null,
      submittedAt: at,
      updatedAt: at,
    } as const;
    const entry: Order = {
      ...base,
      id: `${order.clientOrderId}/entry`,
      leg: "entry",
      side: order.side,
      type: order.entry.type,
      limitPrice: order.entry.type === "limit" ? order.entry.limitPrice : null,
      stopPrice: order.entry.type === "stop" ? order.entry.stopPrice : null,
      status: "accepted",
    };
    const stopLoss: Order = {
      ...base,
      id: `${order.clientOrderId}/stopLoss`,
      leg: "stopLoss",
      side: exitSide,
      type: "stop",
      limitPrice: null,
      stopPrice: order.stopLoss.stopPrice,
      status: "new",
    };
    const takeProfit: Order | null =
      order.takeProfit === null
        ? null
        : {
            ...base,
            id: `${order.clientOrderId}/takeProfit`,
            leg: "takeProfit",
            side: exitSide,
            type: "limit",
            limitPrice: order.takeProfit.limitPrice,
            stopPrice: null,
            status: "new",
          };
    const bracket: Bracket = {
      request: order,
      entryId: entry.id,
      stopLossId: stopLoss.id,
      takeProfitId: takeProfit?.id ?? null,
      flattenId: null,
      holding: null,
      done: false,
    };
    this.#brackets.set(order.clientOrderId, bracket);
    for (const leg of [entry, stopLoss, ...(takeProfit === null ? [] : [takeProfit])]) {
      this.#orders.set(leg.id, leg);
      this.emit("orderUpdate", leg);
    }
    return Promise.resolve(this.#legsOf(bracket));
  }

  cancel(orderId: string): Promise<Order> {
    const order = this.#orders.get(orderId);
    if (order === undefined) {
      return Promise.reject(new AdapterError("UNKNOWN_ORDER", `no order ${orderId}`));
    }
    if (TERMINAL_ORDER_STATUSES.includes(order.status)) {
      return Promise.resolve(order);
    }
    const bracket = this.#brackets.get(order.clientOrderId) as Bracket;
    if (order.leg === "entry") {
      this.#cancelBracket(bracket);
      return Promise.resolve(this.#orders.get(orderId) as Order);
    }
    if (order.leg === "flatten") {
      bracket.flattenId = null;
    }
    return Promise.resolve(this.#update(order, { status: "canceled" }));
  }

  replace(orderId: string, changes: ReplaceRequest): Promise<Order> {
    const order = this.#orders.get(orderId);
    if (order === undefined) {
      return Promise.reject(new AdapterError("UNKNOWN_ORDER", `no order ${orderId}`));
    }
    if (TERMINAL_ORDER_STATUSES.includes(order.status)) {
      return Promise.reject(new AdapterError("ORDER_NOT_OPEN", `order ${orderId} is ${order.status}`));
    }
    if (order.leg === "flatten") {
      return Promise.reject(new AdapterError("UNSUPPORTED", "a flatten order cannot be replaced", false));
    }
    if (changes.quantity !== undefined && changes.quantity > order.quantity) {
      return Promise.reject(new AdapterError("UNSUPPORTED", "a replace cannot grow an order", false));
    }
    this.#replaceSequence += 1;
    const replacement: Order = {
      ...order,
      id: `${order.id}~${String(this.#replaceSequence)}`,
      replaces: order.id,
      stopPrice: order.type === "stop" ? (changes.stopPrice ?? order.stopPrice) : order.stopPrice,
      limitPrice: order.type === "limit" ? (changes.limitPrice ?? order.limitPrice) : order.limitPrice,
      quantity: changes.quantity ?? order.quantity,
      submittedAt: this.now,
      updatedAt: this.now,
    };
    this.#update(order, { status: "replaced" });
    this.#orders.set(replacement.id, replacement);
    const bracket = this.#brackets.get(order.clientOrderId) as Bracket;
    if (order.leg === "entry") {
      bracket.entryId = replacement.id;
    } else if (order.leg === "stopLoss") {
      bracket.stopLossId = replacement.id;
    } else {
      bracket.takeProfitId = replacement.id;
    }
    this.emit("orderUpdate", replacement);
    return Promise.resolve(replacement);
  }

  flattenAll(): Promise<readonly Order[]> {
    const flattens: Order[] = [];
    for (const bracket of this.#brackets.values()) {
      if (bracket.done) {
        continue;
      }
      if (bracket.holding === null) {
        this.#cancelBracket(bracket);
        continue;
      }
      if (bracket.flattenId !== null) {
        continue;
      }
      for (const id of [bracket.stopLossId, bracket.takeProfitId]) {
        const leg = id === null ? undefined : this.#orders.get(id);
        if (leg !== undefined && !TERMINAL_ORDER_STATUSES.includes(leg.status)) {
          this.#update(leg, { status: "canceled" });
        }
      }
      const flatten: Order = {
        id: `${bracket.request.clientOrderId}/flatten`,
        clientOrderId: bracket.request.clientOrderId,
        leg: "flatten",
        symbol: bracket.request.symbol,
        side: bracket.request.side === "buy" ? "sell" : "buy",
        type: "market",
        quantity: bracket.holding.quantity,
        filledQuantity: 0,
        averageFillPrice: null,
        limitPrice: null,
        stopPrice: null,
        status: "accepted",
        replaces: null,
        submittedAt: this.now,
        updatedAt: this.now,
      };
      bracket.flattenId = flatten.id;
      this.#orders.set(flatten.id, flatten);
      this.emit("orderUpdate", flatten);
      flattens.push(flatten);
    }
    return Promise.resolve(flattens);
  }

  getPositions(): Promise<readonly Position[]> {
    const positions: Position[] = [];
    for (const bracket of this.#brackets.values()) {
      if (bracket.done) {
        continue;
      }
      const { request, holding } = bracket;
      const direction = request.side === "buy" ? "long" : "short";
      if (holding === null) {
        const entry = this.#orders.get(bracket.entryId) as Order;
        positions.push({
          symbol: request.symbol,
          direction,
          state: "pendingEntry",
          quantity: 0,
          averageEntryPrice: entry.stopPrice ?? entry.limitPrice ?? fixed(0),
          stopPrice: null,
          takeProfitPrice: null,
          clientOrderId: request.clientOrderId,
          openedAt: entry.submittedAt,
          unrealizedPnl: fixed(0),
          marketValue: fixed(0),
        });
        continue;
      }
      const sign = direction === "long" ? 1 : -1;
      const stop = this.#orders.get(bracket.stopLossId) as Order;
      const takeProfit =
        bracket.takeProfitId === null ? null : (this.#orders.get(bracket.takeProfitId) as Order);
      const perShare = sub(holding.lastPrice, holding.averageEntryPrice);
      positions.push({
        symbol: request.symbol,
        direction,
        state: bracket.flattenId === null ? "open" : "exiting",
        quantity: holding.quantity,
        averageEntryPrice: holding.averageEntryPrice,
        stopPrice: stop.status === "accepted" ? stop.stopPrice : null,
        takeProfitPrice:
          takeProfit !== null && takeProfit.status === "accepted" ? takeProfit.limitPrice : null,
        clientOrderId: request.clientOrderId,
        openedAt: holding.openedAt,
        unrealizedPnl: mulInt(perShare, sign * holding.quantity),
        marketValue: mulInt(holding.lastPrice, sign * holding.quantity),
      });
    }
    return Promise.resolve(positions);
  }

  getOpenOrders(): Promise<readonly Order[]> {
    return Promise.resolve(
      [...this.#orders.values()].filter((o) => !TERMINAL_ORDER_STATUSES.includes(o.status)),
    );
  }

  getAccount(): Promise<Account> {
    let marked: Fixed = fixed(0);
    let committed: Fixed = fixed(0);
    for (const bracket of this.#brackets.values()) {
      if (bracket.done || bracket.holding === null) {
        continue;
      }
      const sign = bracket.request.side === "buy" ? 1 : -1;
      const value = mulInt(bracket.holding.lastPrice, bracket.holding.quantity);
      marked = add(marked, sign === 1 ? value : neg(value));
      committed = add(committed, value);
    }
    const equity = add(this.#cash, marked);
    return Promise.resolve({
      id: "simulated",
      status: "ACTIVE",
      equity,
      cash: this.#cash,
      buyingPower: max(sub(equity, committed), fixed(0)),
      multiplier: 1,
      tradingBlocked: false,
      asOf: this.now,
    });
  }

  /**
   * Advances the market by one closed bar. Fills whatever the bar reaches, oldest bracket first, then
   * marks the symbol's positions at the close. Call it before handing the bar to the engine.
   */
  onBar(bar: SymbolBar): void {
    for (const bracket of this.#brackets.values()) {
      if (bracket.done || bracket.request.symbol !== bar.symbol) {
        continue;
      }
      if (bracket.holding === null) {
        this.#tryEntry(bracket, bar);
      } else {
        this.#tryExit(bracket, bar);
      }
      if (bracket.holding !== null) {
        bracket.holding.lastPrice = bar.close;
      }
    }
    this.#now = { session: bar.session, minuteOfSession: bar.minuteOfSession };
  }

  #tryEntry(bracket: Bracket, bar: SymbolBar): void {
    // A bracket that is not done and holds nothing has a working entry: cancel and replace keep it so.
    const entry = this.#orders.get(bracket.entryId) as Order;
    const long = entry.side === "buy";
    let reference: Fixed | null = null;
    let kind: FillKind = "market";
    if (entry.type === "stop") {
      const trigger = entry.stopPrice as Fixed;
      if (long ? bar.high >= trigger : bar.low <= trigger) {
        reference = long ? max(trigger, bar.open) : min(trigger, bar.open);
        kind = "stopEntry";
      }
    } else if (entry.type === "limit") {
      const limit = entry.limitPrice as Fixed;
      if (long ? bar.low <= limit : bar.high >= limit) {
        reference = limit;
      }
    } else {
      reference = bar.open;
    }
    if (reference === null) {
      return;
    }
    const price = this.#fill(entry, reference, kind, bar);
    bracket.holding = {
      quantity: entry.quantity,
      averageEntryPrice: price,
      openedAt: this.#at(bar),
      lastPrice: bar.close,
    };
    for (const id of [bracket.stopLossId, bracket.takeProfitId]) {
      if (id !== null) {
        this.#update(this.#orders.get(id) as Order, { status: "accepted" });
      }
    }
    // The entry bar: the stop is checked at the stop itself, since the open came before the entry.
    const stop = this.#orders.get(bracket.stopLossId) as Order;
    const stopPrice = stop.stopPrice as Fixed;
    if (long ? bar.low <= stopPrice : bar.high >= stopPrice) {
      this.#exit(bracket, stop, stopPrice, "stopExit", bar);
      return;
    }
    this.#tryTakeProfit(bracket, bar);
  }

  #tryExit(bracket: Bracket, bar: SymbolBar): void {
    if (bracket.flattenId !== null) {
      this.#exit(bracket, this.#orders.get(bracket.flattenId) as Order, bar.open, "market", bar);
      return;
    }
    const long = bracket.request.side === "buy";
    const stop = this.#orders.get(bracket.stopLossId) as Order;
    if (stop.status === "accepted") {
      const stopPrice = stop.stopPrice as Fixed;
      if (long ? bar.low <= stopPrice : bar.high >= stopPrice) {
        const reference = long ? min(stopPrice, bar.open) : max(stopPrice, bar.open);
        this.#exit(bracket, stop, reference, "stopExit", bar);
        return;
      }
    }
    this.#tryTakeProfit(bracket, bar);
  }

  #tryTakeProfit(bracket: Bracket, bar: SymbolBar): void {
    if (bracket.takeProfitId === null) {
      return;
    }
    const takeProfit = this.#orders.get(bracket.takeProfitId) as Order;
    if (takeProfit.status !== "accepted") {
      return;
    }
    const long = bracket.request.side === "buy";
    const limit = takeProfit.limitPrice as Fixed;
    if (long ? bar.high >= limit : bar.low <= limit) {
      this.#exit(bracket, takeProfit, limit, "market", bar);
    }
  }

  #exit(bracket: Bracket, order: Order, reference: Fixed, kind: FillKind, bar: SymbolBar): void {
    this.#fill(order, reference, kind, bar);
    for (const id of [bracket.stopLossId, bracket.takeProfitId, bracket.flattenId]) {
      const leg = id === null ? undefined : this.#orders.get(id);
      if (leg !== undefined && leg.id !== order.id && !TERMINAL_ORDER_STATUSES.includes(leg.status)) {
        this.#update(leg, { status: "canceled" });
      }
    }
    bracket.holding = null;
    bracket.done = true;
  }

  /** Prices one whole fill with the cost model, books the cash, and emits the update and the fill. */
  #fill(order: Order, reference: Fixed, kind: FillKind, bar: SymbolBar): Fixed {
    const modeled = modelFill(
      {
        side: order.side,
        kind,
        quote: quoteFromReference(reference, this.#config.costModel.spread),
        shares: order.quantity,
      },
      this.#config.costModel,
    );
    const at = this.#at(bar);
    const notional = mulInt(modeled.price, order.quantity);
    this.#cash =
      order.side === "buy"
        ? sub(this.#cash, add(notional, modeled.commission))
        : add(this.#cash, sub(notional, modeled.commission));
    this.#update(order, {
      filledQuantity: order.quantity,
      averageFillPrice: modeled.price,
      status: "filled",
      updatedAt: at,
    });
    this.#fillSequence += 1;
    const fill: Fill = {
      id: `fill-${String(this.#fillSequence)}`,
      orderId: order.id,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      price: modeled.price,
      fees: modeled.commission,
      at,
    };
    this.emit("fill", fill);
    return modeled.price;
  }

  #cancelBracket(bracket: Bracket): void {
    for (const id of [bracket.entryId, bracket.stopLossId, bracket.takeProfitId]) {
      const leg = id === null ? undefined : this.#orders.get(id);
      if (leg !== undefined && !TERMINAL_ORDER_STATUSES.includes(leg.status)) {
        this.#update(leg, { status: "canceled" });
      }
    }
    bracket.done = true;
  }

  #legsOf(bracket: Bracket): readonly Order[] {
    const ids = [bracket.entryId, bracket.stopLossId, bracket.takeProfitId].filter(
      (id): id is string => id !== null,
    );
    return ids.map((id) => this.#orders.get(id) as Order);
  }

  #update(order: Order, changes: Partial<Order>): Order {
    const updated: Order = { ...order, ...changes, updatedAt: changes.updatedAt ?? this.now };
    this.#orders.set(order.id, updated);
    this.emit("orderUpdate", updated);
    return updated;
  }

  #at(bar: SymbolBar): IsoTimestamp {
    return this.#config.clock(bar.session, bar.minuteOfSession);
  }
}
