/**
 * Alpaca's REST responses as Alpaca sends them, checked with zod.
 *
 * Field names stay Alpaca's (snake_case, and the data API's one-letter keys) so a payload can be read
 * against Alpaca's docs line for line. Mapping to the system's own types (Fixed money, Order, Position)
 * is the adapter's job (F.3), not this file's.
 *
 * Money and quantities on the trading API are decimal strings and stay strings here: an average fill
 * price can carry more places than Fixed holds, and rounding it is a decision for the mapping, not the
 * transport. The data API sends plain JSON numbers.
 *
 * Unknown keys are dropped, so a field Alpaca adds never breaks a parse. A field this file declares and
 * Alpaca drops does break it, loudly. Anything we have seen missing or null in practice, or that the
 * docs mark nullable, is declared that way. Enums Alpaca may grow (order status, order class) are open
 * strings with the known values listed, so a new status reaches the adapter to be handled instead of
 * failing the whole positions or orders read.
 */

import { z } from "zod";

/** A string of one of the known values, or any other string Alpaca may start sending. */
export type Open<Known extends string> = Known | (string & NonNullable<unknown>);

/** e.g. "100000", "203.01", "-0.0006", "150.123333333". */
export const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, "a decimal string");

/** RFC 3339 with any precision and any offset, e.g. "2026-09-22T15:58:36.318231152-04:00". */
export const timestamp = z.string().datetime({ offset: true });

/** Present and null, or absent: both read as null. */
function nullish<T extends z.ZodTypeAny>(schema: T) {
  return schema.nullish().transform((value): z.output<T> | null => value ?? null);
}

// ---------------------------------------------------------------------------------------------------
// Trading API

export const accountSchema = z.object({
  id: z.string(),
  account_number: z.string(),
  status: z.string(),
  currency: z.string(),
  cash: decimalString,
  equity: decimalString,
  last_equity: decimalString,
  buying_power: decimalString,
  /** Broker leverage as a decimal string, e.g. "4". */
  multiplier: decimalString,
  long_market_value: decimalString,
  short_market_value: decimalString,
  initial_margin: decimalString,
  maintenance_margin: decimalString,
  trading_blocked: z.boolean(),
  account_blocked: z.boolean(),
  trade_suspended_by_user: z.boolean(),
  shorting_enabled: z.boolean(),
  /** Absent on paper accounts since the PDT rule was retired. */
  pattern_day_trader: nullish(z.boolean()),
  daytrade_count: nullish(z.number()),
  created_at: timestamp,
});
export type AlpacaAccount = z.output<typeof accountSchema>;

export const clockSchema = z.object({
  timestamp,
  is_open: z.boolean(),
  next_open: timestamp,
  next_close: timestamp,
});
export type AlpacaClock = z.output<typeof clockSchema>;

/** One trading day. Times are New York wall clock: open "09:30", close "13:00" on a half day. */
export const calendarDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  open: z.string().regex(/^\d{2}:\d{2}$/),
  close: z.string().regex(/^\d{2}:\d{2}$/),
  /** Extended session bounds as "HHMM", e.g. "0400" and "2000". */
  session_open: z.string().regex(/^\d{4}$/),
  session_close: z.string().regex(/^\d{4}$/),
});
export type AlpacaCalendarDay = z.output<typeof calendarDaySchema>;

export const assetSchema = z.object({
  id: z.string(),
  class: z.string(),
  exchange: z.string(),
  symbol: z.string(),
  name: z.string(),
  status: z.enum(["active", "inactive"]),
  tradable: z.boolean(),
  marginable: z.boolean(),
  shortable: z.boolean(),
  easy_to_borrow: z.boolean(),
  fractionable: z.boolean(),
  attributes: nullish(z.array(z.string())),
});
export type AlpacaAsset = z.output<typeof assetSchema>;

export const ORDER_STATUSES = [
  "new",
  "partially_filled",
  "filled",
  "done_for_day",
  "canceled",
  "expired",
  "replaced",
  "pending_cancel",
  "pending_replace",
  "accepted",
  "pending_new",
  "accepted_for_bidding",
  "stopped",
  "rejected",
  "suspended",
  "calculated",
  "held",
] as const;
export type AlpacaOrderStatus = Open<(typeof ORDER_STATUSES)[number]>;

export type AlpacaOrderClass = Open<"simple" | "bracket" | "oco" | "oto" | "mleg" | "">;
export type AlpacaOrderType = Open<"market" | "limit" | "stop" | "stop_limit" | "trailing_stop">;
export type AlpacaTimeInForce = Open<"day" | "gtc" | "opg" | "cls" | "ioc" | "fok">;

export interface AlpacaOrder {
  readonly id: string;
  readonly client_order_id: string;
  readonly created_at: string;
  readonly updated_at: string | null;
  readonly submitted_at: string | null;
  readonly filled_at: string | null;
  readonly expired_at: string | null;
  readonly canceled_at: string | null;
  readonly failed_at: string | null;
  readonly replaced_at: string | null;
  readonly replaced_by: string | null;
  readonly replaces: string | null;
  readonly asset_id: string;
  readonly symbol: string;
  readonly asset_class: string;
  readonly qty: string | null;
  readonly notional: string | null;
  readonly filled_qty: string;
  readonly filled_avg_price: string | null;
  readonly order_class: AlpacaOrderClass;
  readonly type: AlpacaOrderType;
  readonly side: "buy" | "sell";
  readonly time_in_force: AlpacaTimeInForce;
  readonly limit_price: string | null;
  readonly stop_price: string | null;
  readonly status: AlpacaOrderStatus;
  readonly extended_hours: boolean;
  /** A bracket's exit legs, when the order was fetched with nested=true. */
  readonly legs: readonly AlpacaOrder[] | null;
}

export const orderSchema: z.ZodType<AlpacaOrder, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    id: z.string(),
    client_order_id: z.string(),
    created_at: timestamp,
    updated_at: nullish(timestamp),
    submitted_at: nullish(timestamp),
    filled_at: nullish(timestamp),
    expired_at: nullish(timestamp),
    canceled_at: nullish(timestamp),
    failed_at: nullish(timestamp),
    replaced_at: nullish(timestamp),
    replaced_by: nullish(z.string()),
    replaces: nullish(z.string()),
    asset_id: z.string(),
    symbol: z.string(),
    asset_class: z.string(),
    qty: nullish(decimalString),
    notional: nullish(decimalString),
    filled_qty: decimalString,
    filled_avg_price: nullish(decimalString),
    order_class: z.string(),
    type: z.string(),
    side: z.enum(["buy", "sell"]),
    time_in_force: z.string(),
    limit_price: nullish(decimalString),
    stop_price: nullish(decimalString),
    status: z.string(),
    extended_hours: z.boolean(),
    legs: nullish(z.array(orderSchema)),
  }),
);

export const positionSchema = z.object({
  asset_id: z.string(),
  symbol: z.string(),
  exchange: z.string(),
  asset_class: z.string(),
  side: z.enum(["long", "short"]),
  /** Signed: negative for a short. */
  qty: decimalString,
  qty_available: nullish(decimalString),
  avg_entry_price: decimalString,
  cost_basis: decimalString,
  market_value: nullish(decimalString),
  current_price: nullish(decimalString),
  lastday_price: nullish(decimalString),
  change_today: nullish(decimalString),
  unrealized_pl: nullish(decimalString),
  unrealized_plpc: nullish(decimalString),
  unrealized_intraday_pl: nullish(decimalString),
  unrealized_intraday_plpc: nullish(decimalString),
});
export type AlpacaPosition = z.output<typeof positionSchema>;

/**
 * One line of a bulk cancel or bulk close (HTTP 207). Each order or position succeeds or fails on its
 * own, so the call as a whole succeeding says nothing about any one of them.
 */
export interface AlpacaBulkResult {
  /** The order id for a cancel, the symbol for a close. */
  readonly key: string;
  readonly status: number;
  /** The resulting order, when the line succeeded and returned one. */
  readonly order: AlpacaOrder | null;
  /** Alpaca's message, when the line failed. */
  readonly error: string | null;
}

const bulkBody = z.unknown().transform((body, ctx) => {
  if (body === undefined || body === null) {
    return { order: null, error: null };
  }
  const order = orderSchema.safeParse(body);
  if (order.success) {
    return { order: order.data, error: null };
  }
  const failure = z.object({ message: z.string() }).safeParse(body);
  if (failure.success) {
    return { order: null, error: failure.data.message };
  }
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: "neither an order nor an error" });
  return z.NEVER;
});

function bulkResult(
  key: string,
  status: number,
  body: { order: AlpacaOrder | null; error: string | null } | undefined,
): AlpacaBulkResult {
  return {
    key,
    status,
    order: body?.order ?? null,
    error: body?.error ?? (status >= 300 ? `status ${String(status)}` : null),
  };
}

export const cancelAllResultSchema = z.array(
  z
    .object({ id: z.string(), status: z.number().int(), body: bulkBody.optional() })
    .transform((line) => bulkResult(line.id, line.status, line.body)),
);

export const closeAllResultSchema = z.array(
  z
    .object({ symbol: z.string(), status: z.number().int(), body: bulkBody.optional() })
    .transform((line) => bulkResult(line.symbol, line.status, line.body)),
);

// ---------------------------------------------------------------------------------------------------
// Market data API

export type AlpacaFeed = "iex" | "sip" | "delayed_sip";

/** e.g. "1Min", "5Min", "1Hour", "1Day". */
export type AlpacaTimeframe = `${number}${"Min" | "Hour" | "Day" | "Week" | "Month"}`;

export const barSchema = z.object({
  /** The bar's start. */
  t: timestamp,
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number(),
  /** Trade count. */
  n: nullish(z.number()),
  /** Volume-weighted average price. */
  vw: nullish(z.number()),
});
export type AlpacaBar = z.output<typeof barSchema>;

export const quoteSchema = z.object({
  t: timestamp,
  bp: z.number(),
  bs: z.number(),
  bx: z.string(),
  ap: z.number(),
  as: z.number(),
  ax: z.string(),
  /** Condition codes. */
  c: nullish(z.array(z.string())),
  /** Tape: A, B, or C. */
  z: z.string(),
});
export type AlpacaQuote = z.output<typeof quoteSchema>;

export const tradeSchema = z.object({
  t: timestamp,
  p: z.number(),
  s: z.number(),
  x: z.string(),
  i: z.number(),
  c: nullish(z.array(z.string())),
  z: z.string(),
});
export type AlpacaTrade = z.output<typeof tradeSchema>;

export const snapshotSchema = z.object({
  latestTrade: nullish(tradeSchema),
  latestQuote: nullish(quoteSchema),
  minuteBar: nullish(barSchema),
  dailyBar: nullish(barSchema),
  prevDailyBar: nullish(barSchema),
});
export type AlpacaSnapshot = z.output<typeof snapshotSchema>;

/** Keyed by symbol. Alpaca omits a symbol it does not know rather than erroring. */
export const snapshotsSchema = z
  .record(snapshotSchema.nullable())
  .transform((bySymbol): Readonly<Record<string, AlpacaSnapshot>> =>
    Object.fromEntries(
      Object.entries(bySymbol).filter((entry): entry is [string, AlpacaSnapshot] => entry[1] !== null),
    ),
  );

const pageToken = nullish(z.string());

export const barsPageSchema = z.object({
  bars: nullish(z.record(z.array(barSchema))).transform((bars) => bars ?? {}),
  next_page_token: pageToken,
});

export const quotesPageSchema = z.object({
  quotes: nullish(z.record(z.array(quoteSchema))).transform((quotes) => quotes ?? {}),
  next_page_token: pageToken,
});

export const latestQuotesSchema = z.object({ quotes: z.record(quoteSchema) });

export const mostActivesSchema = z.object({
  most_actives: z.array(z.object({ symbol: z.string(), volume: z.number(), trade_count: z.number() })),
  last_updated: timestamp,
});
export type AlpacaMostActives = z.output<typeof mostActivesSchema>;

const mover = z.object({
  symbol: z.string(),
  price: z.number(),
  change: z.number(),
  /** In percent: 12.5 means +12.5%. */
  percent_change: z.number(),
});

export const moversSchema = z.object({
  gainers: z.array(mover),
  losers: z.array(mover),
  market_type: z.string(),
  last_updated: timestamp,
});
export type AlpacaMovers = z.output<typeof moversSchema>;

export const newsArticleSchema = z.object({
  id: z.number().int(),
  headline: z.string(),
  summary: z.string(),
  author: z.string(),
  source: z.string(),
  url: nullish(z.string()),
  symbols: z.array(z.string()),
  created_at: timestamp,
  updated_at: timestamp,
  /** Empty unless the request asked for content. */
  content: nullish(z.string()),
});
export type AlpacaNewsArticle = z.output<typeof newsArticleSchema>;

export const newsPageSchema = z.object({
  news: z.array(newsArticleSchema),
  next_page_token: pageToken,
});
