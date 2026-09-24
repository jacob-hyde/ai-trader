/**
 * The Alpaca client: the trading REST API, the market-data REST API, and the two websockets.
 *
 * A thin fetch client of our own rather than @alpacahq/alpaca-trade-api. The official SDK retries and
 * reconnects on its own terms, has no rate limiting, and does not validate what comes back; every one of
 * those is a decision this system needs to own. What is here is the transport. Mapping to the system's
 * types (Fixed money, Order, Position) is the paper and live adapters' job (F.3, F.4).
 *
 * Trading and market data are separate APIs with separate limits, so each gets its own rate limiter.
 * Nothing here can send an order without a client_order_id: it is the key a lost response is reconciled
 * by (F.5), so it is required even though Alpaca would generate one.
 */

import { z } from "zod";
import {
  type BackoffPolicy,
  DEFAULT_RECONNECT_BACKOFF,
  DEFAULT_RETRY_BACKOFF,
  assertBackoffPolicy,
} from "./backoff.js";
import { AlpacaError } from "./errors.js";
import { type Logger, silentLogger } from "./logger.js";
import { MarketDataStream } from "./marketDataStream.js";
import { ALPACA_TRADING_RATE_LIMIT, RateLimiter, alpacaDataRateLimit } from "./rateLimiter.js";
import { RestTransport } from "./rest.js";
import {
  type AlpacaAccount,
  type AlpacaAsset,
  type AlpacaBar,
  type AlpacaBulkResult,
  type AlpacaCalendarDay,
  type AlpacaClock,
  type AlpacaCorporateActionType,
  type AlpacaCorporateActions,
  type AlpacaFeed,
  type AlpacaMostActives,
  type AlpacaMovers,
  type AlpacaNewsArticle,
  type AlpacaOrder,
  type AlpacaPosition,
  type AlpacaQuote,
  type AlpacaSnapshot,
  type AlpacaTimeframe,
  type AlpacaTrade,
  accountSchema,
  assetSchema,
  barsPageSchema,
  calendarDaySchema,
  cancelAllResultSchema,
  clockSchema,
  closeAllResultSchema,
  corporateActionsPageSchema,
  latestQuotesSchema,
  mostActivesSchema,
  moversSchema,
  newsPageSchema,
  orderSchema,
  positionSchema,
  quotesPageSchema,
  snapshotsSchema,
  tradesPageSchema,
} from "./schemas.js";
import { TradeUpdatesStream } from "./tradeUpdatesStream.js";

export interface AlpacaClientOptions {
  readonly keyId: string;
  readonly secretKey: string;
  /** Selects paper or live, e.g. "https://paper-api.alpaca.markets". */
  readonly tradingUrl: string;
  /** Default "https://data.alpaca.markets". */
  readonly dataUrl?: string;
  /** Market-data websocket host. Default "wss://stream.data.alpaca.markets". */
  readonly streamUrl?: string;
  /** Default feed for data requests and the stream. "sip" needs a paid plan for anything under 15 minutes old. */
  readonly feed?: AlpacaFeed;
  /** The data plan's limit: 200 on Basic, 10,000 on Algo Trader Plus. Default 200. */
  readonly dataRequestsPerMinute?: number;
  readonly logger?: Logger;
  /** Per REST attempt. Default 10 s. */
  readonly timeoutMs?: number;
  /** Attempts for a GET, the first included. Default 4. */
  readonly maxAttempts?: number;
  readonly retryBackoff?: BackoffPolicy;
  readonly reconnectBackoff?: BackoffPolicy;
  /** Websocket ping interval. Default 15 s. */
  readonly heartbeatMs?: number;
  /** Websocket open to ready. Default 10 s. */
  readonly handshakeTimeoutMs?: number;
  /** subscribe() and unsubscribe() acknowledgment. Default 10 s. */
  readonly acknowledgeTimeoutMs?: number;
  /** For tests. */
  readonly fetch?: typeof fetch;
  readonly random?: () => number;
}

// ---------------------------------------------------------------------------------------------------
// Requests

export interface CalendarRequest {
  /** ISO dates, inclusive. */
  readonly start: string;
  readonly end: string;
}

export interface AssetsRequest {
  /** "inactive" includes delisted names, which a survivorship-free backtest universe needs (H.7). */
  readonly status?: "active" | "inactive";
  readonly assetClass?: "us_equity";
  readonly exchange?: string;
}

export interface OrdersRequest {
  readonly status?: "open" | "closed" | "all";
  /** At most 500. */
  readonly limit?: number;
  readonly after?: string;
  readonly until?: string;
  readonly direction?: "asc" | "desc";
  /** Fold a bracket's legs into their parent. */
  readonly nested?: boolean;
  readonly symbols?: readonly string[];
}

const decimalText = z.string().regex(/^\d+(\.\d+)?$/, "a positive decimal string");

/** Checked before anything is sent: a malformed order never reaches the broker. */
export const orderRequestSchema = z
  .object({
    symbol: z.string().min(1),
    /** Whole shares, e.g. "24". */
    qty: z.string().regex(/^[1-9]\d*$/, "whole shares"),
    side: z.enum(["buy", "sell"]),
    type: z.enum(["market", "limit", "stop", "stop_limit"]),
    time_in_force: z.enum(["day", "gtc", "opg", "cls", "ioc", "fok"]),
    client_order_id: z.string().min(1).max(128),
    limit_price: decimalText.optional(),
    stop_price: decimalText.optional(),
    order_class: z.enum(["simple", "bracket", "oco", "oto"]).optional(),
    take_profit: z.object({ limit_price: decimalText }).strict().optional(),
    stop_loss: z.object({ stop_price: decimalText, limit_price: decimalText.optional() }).strict().optional(),
    extended_hours: z.boolean().optional(),
  })
  .strict()
  .refine((order) => !["limit", "stop_limit"].includes(order.type) || order.limit_price !== undefined, {
    message: "a limit order needs limit_price",
  })
  .refine((order) => !["stop", "stop_limit"].includes(order.type) || order.stop_price !== undefined, {
    message: "a stop order needs stop_price",
  });
export type AlpacaOrderRequest = z.input<typeof orderRequestSchema>;

/** Fields a replace may change. The replacement is a new order; the original ends "replaced". */
export const replaceRequestSchema = z
  .object({
    qty: z
      .string()
      .regex(/^[1-9]\d*$/, "whole shares")
      .optional(),
    time_in_force: z.enum(["day", "gtc", "opg", "cls", "ioc", "fok"]).optional(),
    limit_price: decimalText.optional(),
    stop_price: decimalText.optional(),
    client_order_id: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, { message: "nothing to replace" });
export type AlpacaReplaceRequest = z.input<typeof replaceRequestSchema>;

export interface ClosePositionRequest {
  /** Whole shares to close; omit both to close all of it. */
  readonly qty?: number;
  readonly percentage?: number;
}

export interface BarsRequest {
  readonly symbols: readonly string[];
  readonly timeframe: AlpacaTimeframe;
  /** RFC 3339 or ISO date, inclusive. */
  readonly start: string;
  /** Inclusive. Default now (or 15 minutes ago on a plan without recent SIP). */
  readonly end?: string;
  /** Bars per page across all symbols, at most 10,000. */
  readonly limit?: number;
  /** "all" adjusts for splits and dividends. Default "raw" at Alpaca, so pass it explicitly. */
  readonly adjustment?: "raw" | "split" | "dividend" | "all";
  readonly feed?: AlpacaFeed;
  readonly sort?: "asc" | "desc";
  /**
   * Which date's tickers the symbols mean. By default Alpaca maps each symbol to whatever holds it
   * today and returns that company's whole history, so META in 2021 comes back as Facebook. "-" turns the
   * mapping off: each symbol returns what traded under it at the time, which is what a point-in-time
   * backtest needs.
   */
  readonly asof?: string;
  /** Resume from a page token a previous page returned. */
  readonly pageToken?: string;
}

export interface QuotesRequest {
  readonly symbols: readonly string[];
  readonly start: string;
  readonly end?: string;
  readonly limit?: number;
  readonly feed?: AlpacaFeed;
  readonly sort?: "asc" | "desc";
  /** Which date's tickers the symbols mean, as for bars. "-" for what traded under each at the time. */
  readonly asof?: string;
  readonly pageToken?: string;
}

/** Historical trades take the same query as quotes. */
export type TradesRequest = QuotesRequest;

export interface NewsRequest {
  readonly symbols?: readonly string[];
  readonly start?: string;
  readonly end?: string;
  /** Articles per page, at most 50. */
  readonly limit?: number;
  readonly sort?: "asc" | "desc";
  readonly includeContent?: boolean;
  readonly pageToken?: string;
}

export interface CorporateActionsRequest {
  readonly types: readonly AlpacaCorporateActionType[];
  /** ISO dates, inclusive. Alpaca's history thins out before 2019 and is empty for 2016. */
  readonly start: string;
  readonly end: string;
  readonly symbols?: readonly string[];
  /** Actions per page, at most 1,000. */
  readonly limit?: number;
  readonly pageToken?: string;
}

export interface Page<T> {
  readonly items: T;
  /** Pass back as pageToken for the next page. Null on the last page. */
  readonly nextPageToken: string | null;
}

// ---------------------------------------------------------------------------------------------------

/** Account, clock, calendar, assets, orders, positions. */
export class AlpacaTradingApi {
  readonly #rest: RestTransport;

  constructor(rest: RestTransport) {
    this.#rest = rest;
  }

  getAccount(): Promise<AlpacaAccount> {
    return this.#rest.get("/v2/account", accountSchema);
  }

  getClock(): Promise<AlpacaClock> {
    return this.#rest.get("/v2/clock", clockSchema);
  }

  /** Trading days in the range, half days with their early close. Holidays are absent. */
  getCalendar(request: CalendarRequest): Promise<readonly AlpacaCalendarDay[]> {
    return this.#rest.get("/v2/calendar", z.array(calendarDaySchema), {
      start: request.start,
      end: request.end,
    });
  }

  /** Every asset matching, in one response (tens of thousands for inactive). */
  getAssets(request: AssetsRequest = {}): Promise<readonly AlpacaAsset[]> {
    return this.#rest.get("/v2/assets", z.array(assetSchema), {
      status: request.status,
      asset_class: request.assetClass,
      exchange: request.exchange,
    });
  }

  /** Null when Alpaca has no such symbol or id. */
  getAsset(symbolOrId: string): Promise<AlpacaAsset | null> {
    return this.#rest.getOrNull(`/v2/assets/${encodeURIComponent(symbolOrId)}`, assetSchema);
  }

  getPositions(): Promise<readonly AlpacaPosition[]> {
    return this.#rest.get("/v2/positions", z.array(positionSchema));
  }

  /** Null when there is no position in the symbol. */
  getPosition(symbol: string): Promise<AlpacaPosition | null> {
    return this.#rest.getOrNull(`/v2/positions/${encodeURIComponent(symbol)}`, positionSchema);
  }

  getOrders(request: OrdersRequest = {}): Promise<readonly AlpacaOrder[]> {
    return this.#rest.get("/v2/orders", z.array(orderSchema), {
      status: request.status,
      limit: request.limit,
      after: request.after,
      until: request.until,
      direction: request.direction,
      nested: request.nested,
      symbols: request.symbols,
    });
  }

  /** Null when the broker never had it. */
  getOrder(orderId: string): Promise<AlpacaOrder | null> {
    return this.#rest.getOrNull(`/v2/orders/${encodeURIComponent(orderId)}`, orderSchema, { nested: true });
  }

  /** The reconcile after a lost response: did this client order id reach the broker? Null when it did not. */
  getOrderByClientOrderId(clientOrderId: string): Promise<AlpacaOrder | null> {
    return this.#rest.getOrNull("/v2/orders:by_client_order_id", orderSchema, {
      client_order_id: clientOrderId,
    });
  }

  /**
   * Sends one order. Never retried: on `outcomeUnknown` look it up by client_order_id before sending
   * again. A duplicate client_order_id is refused by Alpaca (422), which is the backstop.
   */
  submitOrder(request: AlpacaOrderRequest): Promise<AlpacaOrder> {
    const parsed = orderRequestSchema.safeParse(request);
    if (!parsed.success) {
      return Promise.reject(invalidRequest("POST", "/v2/orders", parsed.error));
    }
    return this.#rest.send("POST", "/v2/orders", orderSchema, parsed.data);
  }

  /** Replaces a working order. Not idempotent: a second call replaces the replacement. */
  replaceOrder(orderId: string, changes: AlpacaReplaceRequest): Promise<AlpacaOrder> {
    const path = `/v2/orders/${encodeURIComponent(orderId)}`;
    const parsed = replaceRequestSchema.safeParse(changes);
    if (!parsed.success) {
      return Promise.reject(invalidRequest("PATCH", path, parsed.error));
    }
    return this.#rest.send("PATCH", path, orderSchema, parsed.data);
  }

  /**
   * Asks the broker to cancel. Resolves once the request is accepted, which is not the same as canceled:
   * the order moves through pending_cancel, and the trade-updates stream says when it is done. Rejects
   * with 422 for an order that is no longer cancelable and 404 for one that never existed.
   */
  cancelOrder(orderId: string): Promise<void> {
    return this.#rest.send("DELETE", `/v2/orders/${encodeURIComponent(orderId)}`, null);
  }

  /** Cancels every open order. One line per order: each succeeds or fails on its own. */
  cancelAllOrders(): Promise<readonly AlpacaBulkResult[]> {
    return this.#rest.send("DELETE", "/v2/orders", cancelAllResultSchema);
  }

  /** Market-closes one position, all of it unless qty or percentage says otherwise. */
  closePosition(symbol: string, request: ClosePositionRequest = {}): Promise<AlpacaOrder> {
    return this.#rest.send("DELETE", `/v2/positions/${encodeURIComponent(symbol)}`, orderSchema, undefined, {
      qty: request.qty,
      percentage: request.percentage,
    });
  }

  /**
   * Market-closes every position, canceling open orders first when asked (the panic path wants that, or a
   * working stop could fill after the close). One line per position.
   */
  closeAllPositions(request: { readonly cancelOrders: boolean }): Promise<readonly AlpacaBulkResult[]> {
    return this.#rest.send("DELETE", "/v2/positions", closeAllResultSchema, undefined, {
      cancel_orders: request.cancelOrders,
    });
  }
}

/** Bars, quotes, snapshots, screeners, news. */
export class AlpacaMarketDataApi {
  readonly #rest: RestTransport;
  readonly #feed: AlpacaFeed;

  constructor(rest: RestTransport, feed: AlpacaFeed) {
    this.#rest = rest;
    this.#feed = feed;
  }

  /** One page of bars, keyed by symbol. A page holds at most `limit` bars across all the symbols. */
  async getBarsPage(request: BarsRequest): Promise<Page<Readonly<Record<string, readonly AlpacaBar[]>>>> {
    const page = await this.#rest.get("/v2/stocks/bars", barsPageSchema, {
      symbols: request.symbols,
      timeframe: request.timeframe,
      start: request.start,
      end: request.end,
      limit: request.limit,
      adjustment: request.adjustment,
      feed: request.feed ?? this.#feed,
      sort: request.sort,
      asof: request.asof,
      page_token: request.pageToken,
    });
    return { items: page.bars, nextPageToken: page.next_page_token };
  }

  /** Every page in turn, from `pageToken` if given. Stop early by breaking out of the loop. */
  async *iterateBars(
    request: BarsRequest,
  ): AsyncGenerator<Page<Readonly<Record<string, readonly AlpacaBar[]>>>> {
    yield* paginate(request.pageToken, (pageToken) => this.getBarsPage({ ...request, ...pageToken }));
  }

  /** The whole range in memory, keyed by symbol. For a bulk load use iterateBars and store as it goes. */
  async getBars(request: BarsRequest): Promise<Readonly<Record<string, readonly AlpacaBar[]>>> {
    const bySymbol: Record<string, AlpacaBar[]> = {};
    for await (const page of this.iterateBars(request)) {
      for (const [symbol, bars] of Object.entries(page.items)) {
        (bySymbol[symbol] ??= []).push(...bars);
      }
    }
    return bySymbol;
  }

  async getQuotesPage(
    request: QuotesRequest,
  ): Promise<Page<Readonly<Record<string, readonly AlpacaQuote[]>>>> {
    const page = await this.#rest.get("/v2/stocks/quotes", quotesPageSchema, {
      symbols: request.symbols,
      start: request.start,
      end: request.end,
      limit: request.limit,
      feed: request.feed ?? this.#feed,
      sort: request.sort,
      asof: request.asof,
      page_token: request.pageToken,
    });
    return { items: page.quotes, nextPageToken: page.next_page_token };
  }

  /** Every trade print in the range, per symbol, in time order unless sorted otherwise. */
  async getTradesPage(
    request: TradesRequest,
  ): Promise<Page<Readonly<Record<string, readonly AlpacaTrade[]>>>> {
    const page = await this.#rest.get("/v2/stocks/trades", tradesPageSchema, {
      symbols: request.symbols,
      start: request.start,
      end: request.end,
      limit: request.limit,
      feed: request.feed ?? this.#feed,
      sort: request.sort,
      asof: request.asof,
      page_token: request.pageToken,
    });
    return { items: page.trades, nextPageToken: page.next_page_token };
  }

  async *iterateTrades(
    request: TradesRequest,
  ): AsyncGenerator<Page<Readonly<Record<string, readonly AlpacaTrade[]>>>> {
    yield* paginate(request.pageToken, (pageToken) => this.getTradesPage({ ...request, ...pageToken }));
  }

  async *iterateQuotes(
    request: QuotesRequest,
  ): AsyncGenerator<Page<Readonly<Record<string, readonly AlpacaQuote[]>>>> {
    yield* paginate(request.pageToken, (pageToken) => this.getQuotesPage({ ...request, ...pageToken }));
  }

  /** The latest NBBO per symbol. */
  async getLatestQuotes(
    symbols: readonly string[],
    feed: AlpacaFeed = this.#feed,
  ): Promise<Readonly<Record<string, AlpacaQuote>>> {
    const response = await this.#rest.get("/v2/stocks/quotes/latest", latestQuotesSchema, { symbols, feed });
    return response.quotes;
  }

  /** Latest trade, quote, minute bar, and daily bars per symbol, in one call. Unknown symbols are absent. */
  getSnapshots(
    symbols: readonly string[],
    feed: AlpacaFeed = this.#feed,
  ): Promise<Readonly<Record<string, AlpacaSnapshot>>> {
    return this.#rest.get("/v2/stocks/snapshots", snapshotsSchema, { symbols, feed });
  }

  /** Most active by volume or trade count, top first. */
  getMostActives(request: {
    readonly by: "volume" | "trades";
    readonly top: number;
  }): Promise<AlpacaMostActives> {
    return this.#rest.get("/v1beta1/screener/stocks/most-actives", mostActivesSchema, {
      by: request.by,
      top: request.top,
    });
  }

  /** Top gainers and losers by percent change. */
  getMovers(request: { readonly top: number }): Promise<AlpacaMovers> {
    return this.#rest.get("/v1beta1/screener/stocks/movers", moversSchema, { top: request.top });
  }

  async getNewsPage(request: NewsRequest = {}): Promise<Page<readonly AlpacaNewsArticle[]>> {
    const page = await this.#rest.get("/v1beta1/news", newsPageSchema, {
      symbols: request.symbols,
      start: request.start,
      end: request.end,
      limit: request.limit,
      sort: request.sort,
      include_content: request.includeContent,
      page_token: request.pageToken,
    });
    return { items: page.news, nextPageToken: page.next_page_token };
  }

  async *iterateNews(request: NewsRequest = {}): AsyncGenerator<Page<readonly AlpacaNewsArticle[]>> {
    yield* paginate(request.pageToken, (pageToken) => this.getNewsPage({ ...request, ...pageToken }));
  }

  /** Mergers, name changes, and the rest, grouped by kind. Kinds the request did not ask for are empty. */
  async getCorporateActionsPage(request: CorporateActionsRequest): Promise<Page<AlpacaCorporateActions>> {
    const page = await this.#rest.get("/v1/corporate-actions", corporateActionsPageSchema, {
      types: request.types,
      start: request.start,
      end: request.end,
      symbols: request.symbols,
      limit: request.limit,
      page_token: request.pageToken,
    });
    return { items: page.corporate_actions, nextPageToken: page.next_page_token };
  }

  async *iterateCorporateActions(
    request: CorporateActionsRequest,
  ): AsyncGenerator<Page<AlpacaCorporateActions>> {
    yield* paginate(request.pageToken, (pageToken) =>
      this.getCorporateActionsPage({ ...request, ...pageToken }),
    );
  }
}

async function* paginate<T>(
  first: string | undefined,
  fetchPage: (pageToken: { readonly pageToken?: string }) => Promise<Page<T>>,
): AsyncGenerator<Page<T>> {
  let token = first;
  for (;;) {
    const page = await fetchPage(token === undefined ? {} : { pageToken: token });
    yield page;
    if (page.nextPageToken === null) {
      return;
    }
    token = page.nextPageToken;
  }
}

function invalidRequest(method: string, path: string, error: z.ZodError): AlpacaError {
  const issues = error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return new AlpacaError({ kind: "invalidRequest", method, path, message: `not sent: ${issues}` });
}

/** The market-data websocket's path for a feed. "test" streams the FAKEPACA symbol around the clock. */
export type StreamFeed = AlpacaFeed | "test";

export class AlpacaClient {
  readonly trading: AlpacaTradingApi;
  readonly data: AlpacaMarketDataApi;

  readonly #keyId: string;
  readonly #secretKey: string;
  readonly #tradingUrl: string;
  readonly #streamUrl: string;
  readonly #feed: AlpacaFeed;
  readonly #logger: Logger;
  readonly #random: () => number;
  readonly #reconnectBackoff: BackoffPolicy;
  readonly #heartbeatMs: number;
  readonly #handshakeTimeoutMs: number;
  readonly #acknowledgeTimeoutMs: number;
  #marketData: { readonly feed: StreamFeed; readonly stream: MarketDataStream } | null = null;
  #tradeUpdates: TradeUpdatesStream | null = null;

  constructor(options: AlpacaClientOptions) {
    const retryBackoff = options.retryBackoff ?? DEFAULT_RETRY_BACKOFF;
    this.#reconnectBackoff = options.reconnectBackoff ?? DEFAULT_RECONNECT_BACKOFF;
    assertBackoffPolicy(retryBackoff, "retryBackoff");
    assertBackoffPolicy(this.#reconnectBackoff, "reconnectBackoff");
    const maxAttempts = options.maxAttempts ?? 4;
    if (!(Number.isInteger(maxAttempts) && maxAttempts >= 1)) {
      throw new RangeError("maxAttempts: needs a whole number of at least 1");
    }

    this.#keyId = options.keyId;
    this.#secretKey = options.secretKey;
    this.#tradingUrl = options.tradingUrl.replace(/\/+$/, "");
    this.#streamUrl = (options.streamUrl ?? "wss://stream.data.alpaca.markets").replace(/\/+$/, "");
    this.#feed = options.feed ?? "iex";
    this.#logger = options.logger ?? silentLogger;
    this.#random = options.random ?? Math.random;
    this.#heartbeatMs = options.heartbeatMs ?? 15_000;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.#acknowledgeTimeoutMs = options.acknowledgeTimeoutMs ?? 10_000;

    const shared = {
      credentials: { keyId: options.keyId, secretKey: options.secretKey },
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      timeoutMs: options.timeoutMs ?? 10_000,
      maxAttempts,
      retryBackoff,
      logger: this.#logger,
      random: this.#random,
    };
    this.trading = new AlpacaTradingApi(
      new RestTransport({
        ...shared,
        baseUrl: this.#tradingUrl,
        limiter: new RateLimiter(ALPACA_TRADING_RATE_LIMIT),
      }),
    );
    this.data = new AlpacaMarketDataApi(
      new RestTransport({
        ...shared,
        baseUrl: options.dataUrl ?? "https://data.alpaca.markets",
        limiter: new RateLimiter(alpacaDataRateLimit(options.dataRequestsPerMinute ?? 200)),
      }),
      this.#feed,
    );
  }

  /**
   * The market-data websocket. One per client, created on first call and the same instance after, since
   * Alpaca allows one per account. Asking for a different feed while it is open throws. Once it is
   * closed or failed a new one may be made.
   */
  marketDataStream(feed: StreamFeed = this.#feed): MarketDataStream {
    const current = this.#marketData;
    if (current !== null && current.stream.state !== "closed" && current.stream.state !== "failed") {
      if (current.feed !== feed) {
        throw new Error(
          `the market-data stream is open on "${current.feed}"; close it before opening "${feed}"`,
        );
      }
      return current.stream;
    }
    const stream = new MarketDataStream({
      ...this.#streamOptions(`${this.#streamUrl}/v2/${feed}`),
      acknowledgeTimeoutMs: this.#acknowledgeTimeoutMs,
    });
    this.#marketData = { feed, stream };
    return stream;
  }

  /** The trade-updates websocket on the trading host. One per client, like the market-data stream. */
  tradeUpdatesStream(): TradeUpdatesStream {
    const current = this.#tradeUpdates;
    if (current !== null && current.state !== "closed" && current.state !== "failed") {
      return current;
    }
    const stream = new TradeUpdatesStream(
      this.#streamOptions(`${this.#tradingUrl.replace(/^http/, "ws")}/stream`),
    );
    this.#tradeUpdates = stream;
    return stream;
  }

  /** Closes whichever streams are open. REST needs no closing. */
  async close(): Promise<void> {
    await Promise.all([this.#marketData?.stream.close(), this.#tradeUpdates?.close()]);
  }

  #streamOptions(url: string) {
    return {
      url,
      credentials: { keyId: this.#keyId, secretKey: this.#secretKey },
      reconnectBackoff: this.#reconnectBackoff,
      heartbeatMs: this.#heartbeatMs,
      handshakeTimeoutMs: this.#handshakeTimeoutMs,
      logger: this.#logger,
      random: this.#random,
    };
  }
}
