/**
 * An adapter that does nothing, for compiling the engine against the interface and for tests.
 *
 * The data half remembers subscriptions and returns nothing. Tests push events through `emit`. The
 * execution half accepts orders, never fills them, and keeps them in memory so cancel, replace, and
 * flattenAll can be exercised. The account never changes.
 */

import type {
  Account,
  BracketOrder,
  Fixed,
  IsoTimestamp,
  NewsItem,
  Order,
  Position,
  RunMode,
  ScreenerKind,
  ScreenerRow,
  SymbolBar,
  SymbolSnapshot,
} from "@trader/contracts";
import { TERMINAL_ORDER_STATUSES, fixed } from "@trader/contracts";
import {
  type Adapter,
  AdapterError,
  type DataAdapter,
  type DataEvents,
  type ExecutionAdapter,
  type ExecutionEvents,
  type HistoricalBarsRequest,
  type NewsRequest,
  type ReplaceRequest,
} from "./adapter.js";
import { Emitter } from "./events.js";

const NEVER: IsoTimestamp = "1970-01-01T00:00:00.000Z";

export class StubDataAdapter extends Emitter<DataEvents> implements DataAdapter {
  readonly #subscribed = new Set<string>();
  connected = false;

  subscribe(symbols: readonly string[]): Promise<void> {
    if (!this.connected) {
      return Promise.reject(new AdapterError("NOT_CONNECTED", "stub data adapter is not connected"));
    }
    for (const symbol of symbols) {
      this.#subscribed.add(symbol);
    }
    return Promise.resolve();
  }

  unsubscribe(symbols: readonly string[]): Promise<void> {
    for (const symbol of symbols) {
      this.#subscribed.delete(symbol);
    }
    return Promise.resolve();
  }

  subscriptions(): readonly string[] {
    return [...this.#subscribed].sort();
  }

  getHistoricalBars(_request: HistoricalBarsRequest): Promise<readonly SymbolBar[]> {
    return Promise.resolve([]);
  }

  getSnapshots(_symbols: readonly string[]): Promise<readonly SymbolSnapshot[]> {
    return Promise.resolve([]);
  }

  getScreener(_kind: ScreenerKind, _limit: number): Promise<readonly ScreenerRow[]> {
    return Promise.resolve([]);
  }

  getNews(_request: NewsRequest): Promise<readonly NewsItem[]> {
    return Promise.resolve([]);
  }
}

export class StubExecutionAdapter extends Emitter<ExecutionEvents> implements ExecutionAdapter {
  readonly #orders = new Map<string, Order>();
  readonly #byClientId = new Map<string, readonly Order[]>();
  #sequence = 0;

  submitBracket(order: BracketOrder): Promise<readonly Order[]> {
    const existing = this.#byClientId.get(order.clientOrderId);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    const exitSide = order.side === "buy" ? "sell" : "buy";
    const base = {
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      quantity: order.quantity,
      filledQuantity: 0,
      averageFillPrice: null,
      replaces: null,
      submittedAt: NEVER,
      updatedAt: NEVER,
    } as const;
    const legs: Order[] = [
      {
        ...base,
        id: this.#nextId(),
        leg: "entry",
        side: order.side,
        type: order.entry.type,
        limitPrice: order.entry.type === "limit" ? order.entry.limitPrice : null,
        stopPrice: order.entry.type === "stop" ? order.entry.stopPrice : null,
        status: "accepted",
      },
      {
        ...base,
        id: this.#nextId(),
        leg: "stopLoss",
        side: exitSide,
        type: "stop",
        limitPrice: null,
        stopPrice: order.stopLoss.stopPrice,
        status: "new",
      },
    ];
    if (order.takeProfit !== null) {
      legs.push({
        ...base,
        id: this.#nextId(),
        leg: "takeProfit",
        side: exitSide,
        type: "limit",
        limitPrice: order.takeProfit.limitPrice,
        stopPrice: null,
        status: "new",
      });
    }
    for (const leg of legs) {
      this.#orders.set(leg.id, leg);
      this.emit("orderUpdate", leg);
    }
    this.#byClientId.set(order.clientOrderId, legs);
    return Promise.resolve(legs);
  }

  cancel(orderId: string): Promise<Order> {
    const order = this.#orders.get(orderId);
    if (order === undefined) {
      return Promise.reject(new AdapterError("UNKNOWN_ORDER", `no order ${orderId}`));
    }
    if (TERMINAL_ORDER_STATUSES.includes(order.status)) {
      return Promise.resolve(order);
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
    this.#update(order, { status: "replaced" });
    const replacement: Order = {
      ...order,
      id: this.#nextId(),
      status: "accepted",
      replaces: order.id,
      stopPrice: changes.stopPrice ?? order.stopPrice,
      limitPrice: changes.limitPrice ?? order.limitPrice,
      quantity: changes.quantity ?? order.quantity,
    };
    this.#orders.set(replacement.id, replacement);
    this.emit("orderUpdate", replacement);
    return Promise.resolve(replacement);
  }

  flattenAll(): Promise<readonly Order[]> {
    for (const order of this.#orders.values()) {
      if (!TERMINAL_ORDER_STATUSES.includes(order.status)) {
        this.#update(order, { status: "canceled" });
      }
    }
    return Promise.resolve([]);
  }

  getPositions(): Promise<readonly Position[]> {
    return Promise.resolve([]);
  }

  getOpenOrders(): Promise<readonly Order[]> {
    return Promise.resolve(
      [...this.#orders.values()].filter((o) => !TERMINAL_ORDER_STATUSES.includes(o.status)),
    );
  }

  getAccount(): Promise<Account> {
    return Promise.resolve({
      id: "stub",
      status: "ACTIVE",
      equity: fixed(25_000_000),
      cash: fixed(25_000_000),
      buyingPower: fixed(25_000_000),
      multiplier: 1,
      tradingBlocked: false,
      asOf: NEVER,
    });
  }

  #nextId(): string {
    this.#sequence += 1;
    return `stub-${String(this.#sequence)}`;
  }

  #update(order: Order, changes: Partial<Order>): Order {
    const updated: Order = { ...order, ...changes };
    this.#orders.set(order.id, updated);
    this.emit("orderUpdate", updated);
    return updated;
  }
}

export class StubAdapter implements Adapter {
  readonly data = new StubDataAdapter();
  readonly execution = new StubExecutionAdapter();

  constructor(readonly mode: RunMode) {}

  connect(): Promise<void> {
    this.data.connected = true;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.data.connected = false;
    return Promise.resolve();
  }
}

/** A price the stub can hand out where one is needed and none matters. */
export const STUB_PRICE: Fixed = fixed(200_000);
