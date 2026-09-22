/**
 * The account's one market-data websocket: bars, quotes, trades, and trading statuses for a changing
 * set of symbols.
 *
 * Alpaca allows a single market-data connection per account and refuses a second with 406. The engine
 * is the only consumer and fans out through Redis (Plan-Detailed "Frontend data path"), and AlpacaClient
 * hands out one instance of this class. A 406 is still retried with backoff rather than treated as fatal,
 * because after a quick reconnect the server may briefly hold our own dead connection.
 *
 * Subscriptions are the caller's desired set, kept across reconnects and sent in full once the new
 * connection authenticates. subscribe() resolves when the server's acknowledgment covers the request.
 * When the server refuses a change (over the symbol limit, a channel the feed lacks) every pending
 * change rejects and the desired set falls back to what the server last acknowledged, so a refused
 * symbol is not resent on every reconnect. The Basic plan caps IEX subscriptions at 30 symbols.
 */

import { z } from "zod";
import { AlpacaStreamError } from "./errors.js";
import { barSchema, quoteSchema, timestamp, tradeSchema } from "./schemas.js";
import { ManagedStream, type StreamEvents, type StreamOptions } from "./stream.js";

export const MARKET_DATA_CHANNELS = [
  "bars",
  "updatedBars",
  "dailyBars",
  "quotes",
  "trades",
  "statuses",
] as const;
export type MarketDataChannel = (typeof MARKET_DATA_CHANNELS)[number];

/** Symbols per channel. "*" is every symbol, where the plan allows it. */
export type SubscriptionRequest = Partial<Readonly<Record<MarketDataChannel, readonly string[]>>>;
export type Subscriptions = Readonly<Record<MarketDataChannel, readonly string[]>>;

const symbolTagged = { S: z.string() };

export const streamBarSchema = barSchema.extend(symbolTagged);
export type StreamBar = z.output<typeof streamBarSchema>;

export const streamQuoteSchema = quoteSchema.extend(symbolTagged);
export type StreamQuote = z.output<typeof streamQuoteSchema>;

export const streamTradeSchema = tradeSchema.extend(symbolTagged);
export type StreamTrade = z.output<typeof streamTradeSchema>;

/** A trading status change, e.g. a halt ("H") or a resume ("T"). */
export const streamStatusSchema = z.object({
  S: z.string(),
  /** Status code and message. */
  sc: z.string(),
  sm: z.string(),
  /** Reason code and message. */
  rc: z.string(),
  rm: z.string(),
  t: timestamp,
  z: z.string(),
});
export type StreamStatus = z.output<typeof streamStatusSchema>;

export type MarketDataEvents = StreamEvents & {
  /** A minute bar, sent just after the minute closes. */
  bar: StreamBar;
  /** A correction to a minute bar already sent, from trades that arrived late. */
  updatedBar: StreamBar;
  /** The day's bar so far. */
  dailyBar: StreamBar;
  quote: StreamQuote;
  trade: StreamTrade;
  status: StreamStatus;
};

const DATA_MESSAGES = {
  b: { event: "bar", schema: streamBarSchema },
  u: { event: "updatedBar", schema: streamBarSchema },
  d: { event: "dailyBar", schema: streamBarSchema },
  q: { event: "quote", schema: streamQuoteSchema },
  t: { event: "trade", schema: streamTradeSchema },
  s: { event: "status", schema: streamStatusSchema },
} as const;

/** A channel the server leaves out of an acknowledgment has nothing subscribed. */
const acknowledgedList = z.array(z.string()).optional();

const controlSchema = z.discriminatedUnion("T", [
  z.object({ T: z.literal("success"), msg: z.string() }),
  z.object({ T: z.literal("error"), code: z.number().int(), msg: z.string() }),
  z.object({
    T: z.literal("subscription"),
    bars: acknowledgedList,
    updatedBars: acknowledgedList,
    dailyBars: acknowledgedList,
    quotes: acknowledgedList,
    trades: acknowledgedList,
    statuses: acknowledgedList,
  }),
]);

type ChannelSets = Record<MarketDataChannel, Set<string>>;

function emptySets(): ChannelSets {
  return Object.fromEntries(
    MARKET_DATA_CHANNELS.map((channel) => [channel, new Set<string>()]),
  ) as ChannelSets;
}

function entries(request: SubscriptionRequest): Array<[MarketDataChannel, readonly string[]]> {
  return MARKET_DATA_CHANNELS.flatMap((channel) => {
    const symbols = request[channel];
    return symbols === undefined || symbols.length === 0
      ? []
      : [[channel, symbols] as [MarketDataChannel, readonly string[]]];
  });
}

/** The request as a wire message body, channels with no symbols left out. */
function wire(sets: SubscriptionRequest | ChannelSets): Record<string, string[]> {
  const body: Record<string, string[]> = {};
  for (const channel of MARKET_DATA_CHANNELS) {
    const symbols = [...(sets[channel] ?? [])];
    if (symbols.length > 0) {
      body[channel] = symbols;
    }
  }
  return body;
}

interface ChangeWaiter {
  readonly done: () => boolean;
  readonly resolve: () => void;
  readonly reject: (error: AlpacaStreamError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface MarketDataStreamOptions extends StreamOptions {
  /** How long subscribe() and unsubscribe() wait for the server's acknowledgment. */
  readonly acknowledgeTimeoutMs: number;
}

export class MarketDataStream extends ManagedStream<MarketDataEvents> {
  protected readonly name = "marketData";
  readonly #acknowledgeTimeoutMs: number;
  #desired: ChannelSets = emptySets();
  #acknowledged: ChannelSets = emptySets();
  readonly #waiters = new Set<ChangeWaiter>();

  constructor(options: MarketDataStreamOptions) {
    super(options);
    this.#acknowledgeTimeoutMs = options.acknowledgeTimeoutMs;
  }

  /**
   * Adds symbols to channels. Additive and idempotent. Resolves when the server has acknowledged every
   * one of them; while the stream is down that means after the next reconnect. Rejects on timeout (the
   * symbols stay desired and go out on the next connection), on a refusal (they are dropped), or when
   * the stream ends.
   */
  subscribe(request: SubscriptionRequest): Promise<void> {
    const unusable = this.unusable();
    if (unusable !== null) {
      return Promise.reject(unusable);
    }
    const additions = entries(request);
    for (const [channel, symbols] of additions) {
      for (const symbol of symbols) {
        this.#desired[channel].add(symbol);
      }
    }
    const done = (): boolean =>
      additions.every(([channel, symbols]) =>
        symbols.every((symbol) => this.#acknowledged[channel].has(symbol)),
      );
    if (!done() && this.state === "ready") {
      this.send({ action: "subscribe", ...wire(request) });
    }
    return this.#waitFor(done);
  }

  /** Removes symbols from channels. Unknown ones are ignored. Resolves when the server no longer lists them. */
  unsubscribe(request: SubscriptionRequest): Promise<void> {
    const unusable = this.unusable();
    if (unusable !== null) {
      return Promise.reject(unusable);
    }
    const removals = entries(request);
    for (const [channel, symbols] of removals) {
      for (const symbol of symbols) {
        this.#desired[channel].delete(symbol);
      }
    }
    const done = (): boolean =>
      removals.every(([channel, symbols]) =>
        symbols.every((symbol) => !this.#acknowledged[channel].has(symbol)),
      );
    if (!done() && this.state === "ready") {
      this.send({ action: "unsubscribe", ...wire(request) });
    }
    return this.#waitFor(done);
  }

  /** The desired subscriptions, sorted: what the stream holds or will restore on reconnect. */
  subscriptions(): Subscriptions {
    const sorted = (channel: MarketDataChannel): readonly string[] => [...this.#desired[channel]].sort();
    return {
      bars: sorted("bars"),
      updatedBars: sorted("updatedBars"),
      dailyBars: sorted("dailyBars"),
      quotes: sorted("quotes"),
      trades: sorted("trades"),
      statuses: sorted("statuses"),
    };
  }

  protected onOpen(): void {
    // Alpaca speaks first ("connected"), and the auth goes out in reply.
  }

  protected onText(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      this.report(new AlpacaStreamError(this.name, "invalidMessage", "a frame that is not JSON"));
      return;
    }
    for (const message of Array.isArray(frame) ? frame : [frame]) {
      this.#handle(message);
    }
  }

  protected onConnectionLost(): void {
    this.#acknowledged = emptySets();
  }

  protected onEnded(error: AlpacaStreamError): void {
    for (const waiter of [...this.#waiters]) {
      this.#settle(waiter, error);
    }
  }

  #handle(message: unknown): void {
    const type = (message as { T?: unknown } | null)?.T;
    if (typeof type === "string" && Object.hasOwn(DATA_MESSAGES, type)) {
      const { event, schema } = DATA_MESSAGES[type as keyof typeof DATA_MESSAGES];
      const parsed = schema.safeParse(message);
      if (parsed.success) {
        this.emit(event, parsed.data as never);
      } else {
        this.report(new AlpacaStreamError(this.name, "invalidMessage", `a malformed "${type}" message`));
      }
      return;
    }
    const control = controlSchema.safeParse(message);
    if (!control.success) {
      // Corrections, cancel errors, LULD bands: nothing here asks for them yet.
      this.logger.debug("alpaca stream message ignored", { stream: this.name, type: String(type) });
      return;
    }
    const value = control.data;
    if (value.T === "success") {
      if (value.msg === "connected") {
        this.sendAuth(({ keyId, secretKey }) => ({ action: "auth", key: keyId, secret: secretKey }));
      } else if (value.msg === "authenticated") {
        this.#authenticated();
      }
    } else if (value.T === "error") {
      this.#serverError(value.code, value.msg);
    } else {
      const acknowledged = emptySets();
      for (const channel of MARKET_DATA_CHANNELS) {
        for (const symbol of value[channel] ?? []) {
          acknowledged[channel].add(symbol);
        }
      }
      this.#acknowledged = acknowledged;
      for (const waiter of [...this.#waiters]) {
        if (waiter.done()) {
          this.#settle(waiter, null);
        }
      }
    }
  }

  #authenticated(): void {
    const restore = wire(this.#desired);
    if (Object.keys(restore).length > 0) {
      this.send({ action: "subscribe", ...restore });
    }
    this.markReady();
  }

  /** Codes from Alpaca's market-data stream docs. */
  #serverError(code: number, msg: string): void {
    switch (code) {
      case 402:
        this.fail(new AlpacaStreamError(this.name, "auth", msg, code, true));
        return;
      case 409:
        this.fail(new AlpacaStreamError(this.name, "subscriptionPlan", msg, code, true));
        return;
      case 406:
        this.report(new AlpacaStreamError(this.name, "connectionLimit", msg, code));
        this.reconnect("connection limit exceeded");
        return;
      case 400:
      case 405:
      case 410: {
        const error = new AlpacaStreamError(this.name, "subscription", msg, code);
        this.#desired = emptySets();
        for (const channel of MARKET_DATA_CHANNELS) {
          for (const symbol of this.#acknowledged[channel]) {
            this.#desired[channel].add(symbol);
          }
        }
        for (const waiter of [...this.#waiters]) {
          this.#settle(waiter, error);
        }
        this.report(error);
        return;
      }
      case 403:
        // Already authenticated: harmless.
        return;
      default:
        this.report(new AlpacaStreamError(this.name, "server", msg, code));
        if (this.state !== "ready") {
          this.reconnect(`server error ${String(code)} during the handshake`);
        }
    }
  }

  #waitFor(done: () => boolean): Promise<void> {
    if (done()) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: ChangeWaiter = {
        done,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#settle(
            waiter,
            new AlpacaStreamError(
              this.name,
              "timeout",
              `no acknowledgment within ${String(this.#acknowledgeTimeoutMs)} ms`,
            ),
          );
        }, this.#acknowledgeTimeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  #settle(waiter: ChangeWaiter, error: AlpacaStreamError | null): void {
    clearTimeout(waiter.timer);
    this.#waiters.delete(waiter);
    if (error === null) {
      waiter.resolve();
    } else {
      waiter.reject(error);
    }
  }
}
