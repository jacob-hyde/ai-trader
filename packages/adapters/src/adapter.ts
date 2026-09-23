/**
 * The one interface the engine codes against. Two halves, data and execution, and a mode.
 *
 * The engine never knows which implementation it has. A backtest replays stored bars into a simulated
 * broker, paper streams the live feed into Alpaca's paper account, live is the same against real money.
 * Every method below states its contract: what it promises, when it throws, and what a disconnect does.
 *
 * Errors are AdapterError with a code. `retryable` says whether the same call may be repeated as is: a
 * transport failure or a rate limit is, a rejected order or an unknown id is not. Anything else an
 * implementation throws is a bug in the implementation.
 *
 * Money is Fixed everywhere, as in the rest of the system. Timestamps are ISO 8601 in UTC.
 */

import type {
  Account,
  BracketOrder,
  Fill,
  Fixed,
  IsoTimestamp,
  NewsItem,
  Order,
  Position,
  QuoteEvent,
  RunMode,
  ScreenerKind,
  ScreenerRow,
  SymbolBar,
  SymbolSnapshot,
} from "@trader/contracts";
import type { EventSource } from "./events.js";

export type AdapterErrorCode =
  | "NOT_CONNECTED"
  | "UNKNOWN_ORDER"
  | "ORDER_NOT_OPEN"
  | "REJECTED"
  | "UNSUPPORTED"
  | "RATE_LIMITED"
  | "TRANSPORT";

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  /** Whether the same call may be repeated unchanged. */
  readonly retryable: boolean;

  constructor(
    code: AdapterErrorCode,
    message: string,
    retryable = code === "TRANSPORT" || code === "RATE_LIMITED",
  ) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type ConnectionEvents = {
  /** The feed or the broker went away. Subscriptions are remembered and restored on reconnect. */
  disconnect: { readonly at: IsoTimestamp; readonly reason: string };
  /** Back, with the subscriptions that were restored. Anything missed in between is gone: the engine reconciles. */
  reconnect: { readonly at: IsoTimestamp; readonly resubscribed: readonly string[] };
};

export type DataEvents = ConnectionEvents & {
  /** A closed bar. Never a forming one: the adapter withholds a bar until its minute has ended. */
  bar: SymbolBar;
  /** The NBBO at some instant. Conflated by the adapter to at most a few a second per symbol. */
  quote: QuoteEvent;
};

export interface HistoricalBarsRequest {
  readonly symbol: string;
  readonly timeframe: "1Min" | "1Day";
  /** Inclusive. */
  readonly from: IsoTimestamp;
  /** Exclusive. */
  readonly to: IsoTimestamp;
}

export interface NewsRequest {
  readonly symbols?: readonly string[];
  readonly from?: IsoTimestamp;
  readonly to?: IsoTimestamp;
  readonly limit?: number;
}

/** The market-data half. Everything here is read-only against the world. */
export interface DataAdapter extends EventSource<DataEvents> {
  /**
   * Starts bar and quote events for these symbols. Additive and idempotent: subscribing to a symbol
   * twice is one subscription, and other symbols are untouched. Resolves once the feed has acknowledged.
   * Throws NOT_CONNECTED before connect() or after close().
   */
  subscribe(symbols: readonly string[]): Promise<void>;

  /** Stops events for these symbols. Unknown symbols are ignored. Events already in flight may still arrive. */
  unsubscribe(symbols: readonly string[]): Promise<void>;

  /** The symbols currently subscribed, sorted. */
  subscriptions(): readonly string[];

  /**
   * Closed bars in the range, oldest first, split-adjusted as of the current session so a lookback
   * across a split is on one share basis. Not adjusted for dividends: the bar store has no dividend
   * history, and a backtest and a live run must compute the same ATR. Pages internally, so one call
   * returns the whole range. Throws RATE_LIMITED (retryable) when the source throttles.
   */
  getHistoricalBars(request: HistoricalBarsRequest): Promise<readonly SymbolBar[]>;

  /** One snapshot per requested symbol, in the requested order. A symbol the source does not know is omitted. */
  getSnapshots(symbols: readonly string[]): Promise<readonly SymbolSnapshot[]>;

  /** The source's ranking, top first, at most `limit` rows. */
  getScreener(kind: ScreenerKind, limit: number): Promise<readonly ScreenerRow[]>;

  /** Newest first. */
  getNews(request: NewsRequest): Promise<readonly NewsItem[]>;
}

export type ExecutionEvents = ConnectionEvents & {
  /** An order changed status or filled quantity. Delivered in the order the broker reports them. */
  orderUpdate: Order;
  /** One execution. Always preceded by the orderUpdate that reflects it. */
  fill: Fill;
};

export interface ReplaceRequest {
  readonly stopPrice?: Fixed;
  readonly limitPrice?: Fixed;
  readonly quantity?: number;
}

/** The broker half. Every method that changes state is safe to retry, as documented on each. */
export interface ExecutionAdapter extends EventSource<ExecutionEvents> {
  /**
   * Places the entry with its exits attached and returns the legs as the broker accepted them, entry
   * first. Idempotent on clientOrderId: a second submit of the same id returns the existing legs and
   * places nothing, so a retry after a lost response cannot double an order. Throws REJECTED (not
   * retryable) when the broker refuses, with the broker's reason in the message.
   */
  submitBracket(order: BracketOrder): Promise<readonly Order[]>;

  /**
   * Cancels one order and returns it in its final state. Canceling an entry cancels the bracket with it.
   * Canceling an already terminal order is not an error and returns it unchanged. Throws UNKNOWN_ORDER
   * for an id the broker never had.
   */
  cancel(orderId: string): Promise<Order>;

  /**
   * Replaces a working order's price or quantity and returns the replacement, which names the original
   * in `replaces`. The original ends as "replaced". Used to move a stop to breakeven or to resize legs
   * after a partial fill. Throws ORDER_NOT_OPEN when the order is terminal and UNKNOWN_ORDER when it
   * never existed. Not idempotent: replace twice and the second replaces the first replacement.
   */
  replace(orderId: string, changes: ReplaceRequest): Promise<Order>;

  /**
   * Cancels every working order and submits a market exit for every position, returning the exits.
   * Safe to call repeatedly: a second call finds nothing to do. The panic path and the EOD flatten both
   * come here, and it must work while the data feed is down.
   */
  flattenAll(): Promise<readonly Order[]>;

  /** Positions as the broker holds them. The engine treats this, not its own memory, as the truth. */
  getPositions(): Promise<readonly Position[]>;

  /** Every non-terminal order. */
  getOpenOrders(): Promise<readonly Order[]>;

  getAccount(): Promise<Account>;
}

export interface Adapter {
  readonly mode: RunMode;
  readonly data: DataAdapter;
  readonly execution: ExecutionAdapter;
  /** Opens the feed and the broker session. Idempotent. Nothing else works before it resolves. */
  connect(): Promise<void>;
  /** Closes both. Idempotent. Working orders are left as they are at the broker. */
  close(): Promise<void>;
}
