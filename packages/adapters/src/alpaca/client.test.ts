import { afterEach, describe, expect, it, vi } from "vitest";
import { AlpacaClient, type AlpacaClientOptions, type AlpacaOrderRequest } from "./client.js";
import { AlpacaError } from "./errors.js";
import { queryString } from "./rest.js";
import { type FetchCall, type FetchHandler, fakeFetch, hang, json } from "./testing.js";

const KEY = "PKTESTKEY0000000000";
const SECRET = "test-secret-0000000000000000000000";
const TRADING = "https://paper-api.example";
const DATA = "https://data.example";

function client(handler: FetchHandler, options: Partial<AlpacaClientOptions> = {}) {
  const fake = fakeFetch(handler);
  const alpaca = new AlpacaClient({
    keyId: KEY,
    secretKey: SECRET,
    tradingUrl: `${TRADING}/`,
    dataUrl: DATA,
    fetch: fake.fetch,
    retryBackoff: { initialMs: 1, maxMs: 4, multiplier: 2 },
    timeoutMs: 50,
    ...options,
  });
  return { alpaca, calls: fake.calls };
}

/** Answers GET /path with the body, 404 for anything else. */
function routes(table: Record<string, unknown>): FetchHandler {
  return (call) => {
    const key = `${call.method} ${call.url.pathname}`;
    return key in table ? json(table[key]) : json({ code: 40410000, message: "not found" }, 404);
  };
}

const ORDER = {
  id: "61e69015-8549-4bfd-b9c3-01e75843f47d",
  client_order_id: "orb-AAPL-20260921-50e967ae",
  created_at: "2026-09-21T13:35:01.123456Z",
  updated_at: "2026-09-21T13:35:01.123456Z",
  submitted_at: "2026-09-21T13:35:01.100000Z",
  filled_at: null,
  expired_at: null,
  canceled_at: null,
  failed_at: null,
  replaced_at: null,
  replaced_by: null,
  replaces: null,
  asset_id: "b0b6dd9d-8b9b-48a9-ba46-b9d54906e415",
  symbol: "AAPL",
  asset_class: "us_equity",
  notional: null,
  qty: "24",
  filled_qty: "0",
  filled_avg_price: null,
  order_class: "oto",
  order_type: "stop",
  type: "stop",
  side: "buy",
  position_intent: "buy_to_open",
  time_in_force: "day",
  limit_price: null,
  stop_price: "203",
  status: "accepted",
  extended_hours: false,
  legs: [
    {
      id: "c1f2e7d0-0000-4000-8000-000000000001",
      client_order_id: "7a0c1e2b-leg",
      created_at: "2026-09-21T13:35:01.123456Z",
      updated_at: "2026-09-21T13:35:01.123456Z",
      submitted_at: "2026-09-21T13:35:01.100000Z",
      asset_id: "b0b6dd9d-8b9b-48a9-ba46-b9d54906e415",
      symbol: "AAPL",
      asset_class: "us_equity",
      qty: "24",
      filled_qty: "0",
      order_class: "oto",
      type: "stop",
      side: "sell",
      time_in_force: "day",
      stop_price: "199.5",
      status: "held",
      extended_hours: false,
      legs: null,
    },
  ],
};

const ACCOUNT = {
  id: "a5367a94-2dbc-4569-b089-bf6c0285b94e",
  account_number: "PA3PHD8QJ3AL",
  status: "ACTIVE",
  currency: "USD",
  buying_power: "400000",
  cash: "100000",
  equity: "100000",
  last_equity: "100000",
  multiplier: "4",
  long_market_value: "0",
  short_market_value: "0",
  initial_margin: "0",
  maintenance_margin: "0",
  trading_blocked: false,
  account_blocked: false,
  trade_suspended_by_user: false,
  shorting_enabled: true,
  created_at: "2026-09-19T19:30:03.899594Z",
  crypto_status: "ACTIVE",
};

const POSITION = {
  asset_id: "b0b6dd9d-8b9b-48a9-ba46-b9d54906e415",
  symbol: "AAPL",
  exchange: "NASDAQ",
  asset_class: "us_equity",
  side: "long",
  qty: "24",
  qty_available: "0",
  avg_entry_price: "203.01",
  cost_basis: "4872.24",
  market_value: "4880.4",
  current_price: "203.35",
  lastday_price: "201.1",
  change_today: "0.0111",
  unrealized_pl: "8.16",
  unrealized_plpc: "0.0017",
  unrealized_intraday_pl: "8.16",
  unrealized_intraday_plpc: "0.0017",
  asset_marginable: true,
};

const BAR = {
  t: "2026-09-18T13:30:00Z",
  o: 337.91,
  h: 338.3699,
  l: 336.57,
  c: 336.62,
  v: 8329964,
  n: 14347,
  vw: 338.3,
};
const QUOTE = {
  t: "2026-09-18T13:30:00.000081788Z",
  bp: 337.82,
  bs: 2960,
  bx: "Q",
  ap: 338.2,
  as: 80,
  ax: "Q",
  c: ["R"],
  z: "C",
};
const TRADE = { t: "2026-09-22T19:58:48.310164245Z", p: 339.58, s: 40, x: "V", i: 20448, c: ["@"], z: "C" };

const STOP_ENTRY: AlpacaOrderRequest = {
  symbol: "AAPL",
  qty: "24",
  side: "buy",
  type: "stop",
  time_in_force: "day",
  client_order_id: "orb-AAPL-20260921-50e967ae",
  stop_price: "203",
  order_class: "oto",
  stop_loss: { stop_price: "199.5" },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("queryString", () => {
  it("joins lists with commas, drops undefined, and prints the rest", () => {
    expect(queryString(undefined)).toBe("");
    expect(queryString({ a: undefined })).toBe("");
    expect(queryString({ symbols: ["AAPL", "MSFT"], limit: 3, nested: true, s: "x y" })).toBe(
      "?symbols=AAPL%2CMSFT&limit=3&nested=true&s=x+y",
    );
  });
});

describe("AlpacaClient REST", () => {
  it("authenticates with the key headers and reads the account", async () => {
    const { alpaca, calls } = client(routes({ "GET /v2/account": ACCOUNT }));
    const account = await alpaca.trading.getAccount();
    expect(account.equity).toBe("100000");
    expect(account.pattern_day_trader).toBeNull();
    expect(account).not.toHaveProperty("crypto_status");
    const [call] = calls as [FetchCall];
    expect(call.url.href).toBe(`${TRADING}/v2/account`);
    expect(call.headers.get("APCA-API-KEY-ID")).toBe(KEY);
    expect(call.headers.get("APCA-API-SECRET-KEY")).toBe(SECRET);
    expect(call.headers.get("content-type")).toBeNull();
  });

  it("reads the clock, the calendar, assets including inactive ones, and positions", async () => {
    const { alpaca, calls } = client(
      routes({
        "GET /v2/clock": {
          is_open: true,
          next_close: "2026-09-22T16:00:00-04:00",
          next_open: "2026-09-23T09:30:00-04:00",
          timestamp: "2026-09-22T15:58:36.318231152-04:00",
        },
        "GET /v2/calendar": [
          {
            date: "2026-11-27",
            open: "09:30",
            close: "13:00",
            session_open: "0400",
            session_close: "1700",
            settlement_date: "2026-11-30",
          },
        ],
        "GET /v2/assets": [
          {
            id: "292ff539-44bf-4b16-ab25-0ecd4eeb2f74",
            class: "us_equity",
            exchange: "OTC",
            symbol: "JAKP",
            name: "JAKKS PAC INC 6% SR PFD SER A",
            status: "inactive",
            tradable: false,
            marginable: false,
            shortable: false,
            easy_to_borrow: false,
            fractionable: false,
            attributes: [],
          },
        ],
        "GET /v2/positions": [POSITION],
        "GET /v2/positions/AAPL": POSITION,
      }),
    );
    expect((await alpaca.trading.getClock()).is_open).toBe(true);
    expect(await alpaca.trading.getCalendar({ start: "2026-11-26", end: "2026-11-28" })).toEqual([
      { date: "2026-11-27", open: "09:30", close: "13:00", session_open: "0400", session_close: "1700" },
    ]);
    const assets = await alpaca.trading.getAssets({ status: "inactive", assetClass: "us_equity" });
    expect(assets[0]?.status).toBe("inactive");
    expect((await alpaca.trading.getPositions())[0]?.avg_entry_price).toBe("203.01");
    expect((await alpaca.trading.getPosition("AAPL"))?.qty).toBe("24");
    expect(await alpaca.trading.getPosition("MSFT")).toBeNull();
    expect(await alpaca.trading.getAsset("NOPE")).toBeNull();
    expect(calls.map((call) => `${call.url.pathname}${call.url.search}`)).toEqual([
      "/v2/clock",
      "/v2/calendar?start=2026-11-26&end=2026-11-28",
      "/v2/assets?status=inactive&asset_class=us_equity",
      "/v2/positions",
      "/v2/positions/AAPL",
      "/v2/positions/MSFT",
      "/v2/assets/NOPE",
    ]);
    // A 404 lookup is an answer, not a failure: it is not retried.
    expect(calls).toHaveLength(7);
  });

  it("reads orders with their bracket legs, by id and by client order id", async () => {
    const { alpaca, calls } = client(
      routes({
        "GET /v2/orders": [ORDER],
        [`GET /v2/orders/${ORDER.id}`]: ORDER,
        "GET /v2/orders:by_client_order_id": ORDER,
      }),
    );
    const orders = await alpaca.trading.getOrders({
      status: "open",
      nested: true,
      symbols: ["AAPL", "MSFT"],
    });
    expect(orders[0]?.legs?.[0]?.stop_price).toBe("199.5");
    expect(orders[0]?.legs?.[0]?.filled_avg_price).toBeNull();
    expect((await alpaca.trading.getOrder(ORDER.id))?.status).toBe("accepted");
    expect((await alpaca.trading.getOrderByClientOrderId(ORDER.client_order_id))?.id).toBe(ORDER.id);
    expect(await alpaca.trading.getOrder("missing")).toBeNull();
    expect(calls.map((call) => call.url.search)).toEqual([
      "?status=open&nested=true&symbols=AAPL%2CMSFT",
      "?nested=true",
      `?client_order_id=${ORDER.client_order_id}`,
      "?nested=true",
    ]);
  });

  it("submits an order once, as JSON, with the client order id", async () => {
    const { alpaca, calls } = client(() => json(ORDER));
    const order = await alpaca.trading.submitOrder(STOP_ENTRY);
    expect(order.client_order_id).toBe(STOP_ENTRY.client_order_id);
    const [call] = calls as [FetchCall];
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe("/v2/orders");
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.body).toEqual(STOP_ENTRY);
  });

  it("refuses a malformed order before anything is sent", async () => {
    const { alpaca, calls } = client(() => json(ORDER));
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ ...STOP_ENTRY, stop_price: "abc" }, "stop_price"],
      [{ ...STOP_ENTRY, stop_price: undefined }, "a stop order needs stop_price"],
      [{ ...STOP_ENTRY, type: "limit" }, "a limit order needs limit_price"],
      [{ ...STOP_ENTRY, qty: "1.5" }, "whole shares"],
      [{ ...STOP_ENTRY, client_order_id: "" }, "client_order_id"],
      [{ ...STOP_ENTRY, clientOrderId: "typo" }, "Unrecognized key"],
      [{ ...STOP_ENTRY, stop_loss: { stop_price: "-1" } }, "stop_loss.stop_price"],
    ];
    for (const [request, message] of bad) {
      const error = await alpaca.trading.submitOrder(request as AlpacaOrderRequest).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AlpacaError);
      expect((error as AlpacaError).kind).toBe("invalidRequest");
      expect((error as AlpacaError).message).toContain(message);
    }
    const noChange = await alpaca.trading.replaceOrder(ORDER.id, {}).catch((e: unknown) => e);
    expect((noChange as AlpacaError).kind).toBe("invalidRequest");
    expect(calls).toHaveLength(0);
  });

  it("replaces, cancels, and closes", async () => {
    const { alpaca, calls } = client((call) => {
      if (call.method === "PATCH") {
        return json({ ...ORDER, id: "replacement", replaces: ORDER.id, stop_price: "203.01" });
      }
      if (call.url.pathname === `/v2/orders/${ORDER.id}`) {
        return new Response(null, { status: 204 });
      }
      if (call.url.pathname === "/v2/orders") {
        return json(
          [
            { id: ORDER.id, status: 200, body: ORDER },
            { id: "gone", status: 422, body: { code: 42210000, message: "order is not cancelable" } },
            { id: "bare", status: 500 },
            { id: "empty", status: 200, body: null },
          ],
          207,
        );
      }
      if (call.url.pathname === "/v2/positions") {
        return json([{ symbol: "AAPL", status: 200, body: { ...ORDER, side: "sell", type: "market" } }], 207);
      }
      return json({ ...ORDER, side: "sell", type: "market" });
    });
    const replaced = await alpaca.trading.replaceOrder(ORDER.id, { stop_price: "203.01" });
    expect(replaced.replaces).toBe(ORDER.id);
    await expect(alpaca.trading.cancelOrder(ORDER.id)).resolves.toBeUndefined();
    const canceled = await alpaca.trading.cancelAllOrders();
    expect(canceled).toEqual([
      { key: ORDER.id, status: 200, order: expect.objectContaining({ id: ORDER.id }), error: null },
      { key: "gone", status: 422, order: null, error: "order is not cancelable" },
      { key: "bare", status: 500, order: null, error: "status 500" },
      { key: "empty", status: 200, order: null, error: null },
    ]);
    const closed = await alpaca.trading.closeAllPositions({ cancelOrders: true });
    expect(closed[0]?.order?.side).toBe("sell");
    expect((await alpaca.trading.closePosition("AAPL", { qty: 10 })).type).toBe("market");
    expect(calls.map((call) => `${call.method} ${call.url.pathname}${call.url.search}`)).toEqual([
      `PATCH /v2/orders/${ORDER.id}`,
      `DELETE /v2/orders/${ORDER.id}`,
      "DELETE /v2/orders",
      "DELETE /v2/positions?cancel_orders=true",
      "DELETE /v2/positions/AAPL?qty=10",
    ]);
    expect(calls[0]?.body).toEqual({ stop_price: "203.01" });
  });

  it("reads bars page by page, resumes from a token, and merges the whole range", async () => {
    const pages: Record<string, unknown> = {
      "": { bars: { AAPL: [BAR], MSFT: [BAR] }, next_page_token: "p2" },
      p2: { bars: { MSFT: [{ ...BAR, t: "2026-09-18T13:31:00Z" }] }, next_page_token: "p3" },
      p3: { bars: null, next_page_token: null },
    };
    const { alpaca, calls } = client((call) => json(pages[call.url.searchParams.get("page_token") ?? ""]));
    const request = {
      symbols: ["AAPL", "MSFT"],
      timeframe: "1Min",
      start: "2026-09-18T13:30:00Z",
      end: "2026-09-18T13:33:00Z",
      adjustment: "all",
      limit: 10_000,
    } as const;
    const merged = await alpaca.data.getBars(request);
    expect(merged["AAPL"]).toHaveLength(1);
    expect(merged["MSFT"]?.map((bar) => bar.t)).toEqual(["2026-09-18T13:30:00Z", "2026-09-18T13:31:00Z"]);
    expect(calls[0]?.url.href).toBe(
      `${DATA}/v2/stocks/bars?symbols=AAPL%2CMSFT&timeframe=1Min&start=2026-09-18T13%3A30%3A00Z` +
        "&end=2026-09-18T13%3A33%3A00Z&limit=10000&adjustment=all&feed=iex",
    );
    expect(calls.map((call) => call.url.searchParams.get("page_token"))).toEqual([null, "p2", "p3"]);

    const resumed: string[] = [];
    for await (const page of alpaca.data.iterateBars({ ...request, pageToken: "p2", feed: "sip" })) {
      resumed.push(page.nextPageToken ?? "end");
    }
    expect(resumed).toEqual(["p3", "end"]);
    expect(calls.at(-1)?.url.searchParams.get("feed")).toBe("sip");
  });

  it("reads quotes, snapshots, screeners, and news", async () => {
    const { alpaca, calls } = client(
      routes({
        "GET /v2/stocks/quotes": { quotes: { AAPL: [QUOTE] }, next_page_token: null },
        "GET /v2/stocks/quotes/latest": { quotes: { AAPL: QUOTE } },
        "GET /v2/stocks/snapshots": {
          AAPL: { latestTrade: TRADE, latestQuote: QUOTE, minuteBar: BAR, dailyBar: BAR, prevDailyBar: BAR },
          HALF: { latestTrade: TRADE },
          GONE: null,
        },
        "GET /v1beta1/screener/stocks/most-actives": {
          most_actives: [{ symbol: "ZEO", trade_count: 512535, volume: 394543086 }],
          last_updated: "2026-09-22T19:58:00.236829543Z",
        },
        "GET /v1beta1/screener/stocks/movers": {
          gainers: [{ change: 33.21, percent_change: 1243.83, price: 35.8803, symbol: "JAGX" }],
          losers: [],
          market_type: "stocks",
          last_updated: "2026-09-22T19:58:00.336937789Z",
        },
        "GET /v1beta1/news": {
          news: [
            {
              id: 61932828,
              headline: "Apple takes aim",
              summary: "",
              author: "Daragh Thomas",
              source: "benzinga",
              url: "https://www.benzinga.com/x",
              symbols: ["AAPL", "NVDA"],
              created_at: "2026-09-22T19:32:50Z",
              updated_at: "2026-09-22T19:32:50Z",
              content: "",
              images: [],
            },
          ],
          next_page_token: null,
        },
      }),
    );
    const pages = [];
    for await (const page of alpaca.data.iterateQuotes({
      symbols: ["AAPL"],
      start: "2026-09-18T13:30:00Z",
    })) {
      pages.push(page);
    }
    expect(pages[0]?.items["AAPL"]?.[0]?.bp).toBe(337.82);
    expect((await alpaca.data.getLatestQuotes(["AAPL"]))["AAPL"]?.ap).toBe(338.2);
    const snapshots = await alpaca.data.getSnapshots(["AAPL", "HALF", "GONE", "NOPE"], "sip");
    expect(Object.keys(snapshots)).toEqual(["AAPL", "HALF"]);
    expect(snapshots["HALF"]?.latestQuote).toBeNull();
    expect((await alpaca.data.getMostActives({ by: "volume", top: 3 })).most_actives[0]?.symbol).toBe("ZEO");
    expect((await alpaca.data.getMovers({ top: 2 })).gainers[0]?.percent_change).toBe(1243.83);
    const news = [];
    for await (const page of alpaca.data.iterateNews({
      symbols: ["AAPL"],
      limit: 2,
      includeContent: false,
    })) {
      news.push(...page.items);
    }
    expect(news[0]?.symbols).toEqual(["AAPL", "NVDA"]);
    expect(calls.map((call) => `${call.url.pathname}${call.url.search}`)).toEqual([
      "/v2/stocks/quotes?symbols=AAPL&start=2026-09-18T13%3A30%3A00Z&feed=iex",
      "/v2/stocks/quotes/latest?symbols=AAPL&feed=iex",
      "/v2/stocks/snapshots?symbols=AAPL%2CHALF%2CGONE%2CNOPE&feed=sip",
      "/v1beta1/screener/stocks/most-actives?by=volume&top=3",
      "/v1beta1/screener/stocks/movers?top=2",
      "/v1beta1/news?symbols=AAPL&limit=2&include_content=false",
    ]);
  });

  it("turns symbol mapping off on request, for ticker-at-time bars", async () => {
    const { alpaca, calls } = client(() => json({ bars: {}, next_page_token: null }));
    await alpaca.data.getBarsPage({ symbols: ["FB"], timeframe: "1Day", start: "2021-06-01", asof: "-" });
    expect(calls[0]?.url.searchParams.get("asof")).toBe("-");
  });

  it("reads corporate actions page by page, with absent kinds as empty lists", async () => {
    const pages: Record<string, unknown> = {
      "": {
        corporate_actions: {
          cash_mergers: [
            {
              acquiree_symbol: "TWTR",
              acquiree_cusip: "90184L102",
              effective_date: "2022-10-28",
              rate: 54.2,
            },
          ],
          name_changes: [{ old_symbol: "FB", new_symbol: "META", process_date: "2022-06-09" }],
          forward_splits: [{ symbol: "NVDA" }],
        },
        next_page_token: "p2",
      },
      p2: { corporate_actions: { worthless_removals: [{ symbol: "SIVBQ" }] }, next_page_token: null },
    };
    const { alpaca, calls } = client((call) => json(pages[call.url.searchParams.get("page_token") ?? ""]));
    const seen = [];
    for await (const page of alpaca.data.iterateCorporateActions({
      types: ["cash_merger", "name_change", "worthless_removal"],
      start: "2022-01-01",
      end: "2022-12-31",
      limit: 1_000,
    })) {
      seen.push(page.items);
    }
    expect(seen[0]?.cash_mergers[0]).toEqual({
      acquiree_symbol: "TWTR",
      acquirer_symbol: null,
      effective_date: "2022-10-28",
      process_date: null,
    });
    expect(seen[0]?.stock_mergers).toEqual([]);
    expect(seen[1]?.worthless_removals).toEqual([{ symbol: "SIVBQ", process_date: null }]);
    expect(calls[0]?.url.search).toBe(
      "?types=cash_merger%2Cname_change%2Cworthless_removal&start=2022-01-01&end=2022-12-31&limit=1000",
    );
  });

  it("refuses bad client options", () => {
    const base = { keyId: KEY, secretKey: SECRET, tradingUrl: TRADING };
    expect(() => new AlpacaClient({ ...base, maxAttempts: 0 })).toThrow(RangeError);
    expect(
      () => new AlpacaClient({ ...base, retryBackoff: { initialMs: 0, maxMs: 1, multiplier: 2 } }),
    ).toThrow(RangeError);
  });
});

describe("AlpacaClient retries and failures", () => {
  it("retries a GET through 5xx and network errors, then succeeds", async () => {
    let n = 0;
    const { alpaca, calls } = client(() => {
      n += 1;
      if (n === 1) {
        return json({ message: "upstream" }, 503);
      }
      if (n === 2) {
        throw new TypeError("fetch failed");
      }
      return json(ACCOUNT);
    });
    expect((await alpaca.trading.getAccount()).account_number).toBe("PA3PHD8QJ3AL");
    expect(calls).toHaveLength(3);
  });

  it("gives up after maxAttempts and says the GET may be tried again", async () => {
    const { alpaca, calls } = client(() => json({ code: 50010000, message: "internal" }, 500), {
      maxAttempts: 3,
    });
    const error = (await alpaca.trading.getAccount().catch((e: unknown) => e)) as AlpacaError;
    expect(calls).toHaveLength(3);
    expect(error).toMatchObject({
      kind: "http",
      status: 500,
      alpacaCode: 50010000,
      retryable: true,
      outcomeUnknown: false,
    });
    expect(error.message).toBe("Alpaca GET /v2/account: 500 internal");
  });

  it("times out a hung GET, and retries it", async () => {
    const { alpaca, calls } = client((_call, signal) => hang(signal), { maxAttempts: 2, timeoutMs: 20 });
    const error = (await alpaca.trading.getClock().catch((e: unknown) => e)) as AlpacaError;
    expect(error).toMatchObject({ kind: "timeout", retryable: true, outcomeUnknown: false });
    expect(calls).toHaveLength(2);
  });

  it("treats only a 404 as an empty lookup, and still throws anything else", async () => {
    const { alpaca } = client(() => json({ message: "forbidden" }, 403));
    await expect(alpaca.trading.getOrderByClientOrderId("x")).rejects.toMatchObject({
      kind: "http",
      status: 403,
    });
  });

  it("does not retry a 4xx", async () => {
    const { alpaca, calls } = client(() => json({ code: 40010001, message: "invalid symbol" }, 422));
    const error = (await alpaca.data.getSnapshots(["??"]).catch((e: unknown) => e)) as AlpacaError;
    expect(error).toMatchObject({ kind: "http", status: 422, retryable: false, alpacaCode: 40010001 });
    expect(calls).toHaveLength(1);
  });

  it("shows a non-JSON error body as text", async () => {
    const { alpaca } = client(() => new Response("<html>bad gateway</html>", { status: 400 }));
    const error = (await alpaca.trading.getClock().catch((e: unknown) => e)) as AlpacaError;
    expect(error.message).toBe("Alpaca GET /v2/clock: 400 <html>bad gateway</html>");
    expect(error.alpacaCode).toBeNull();
  });

  it("never retries an order, and says when its outcome is unknown", async () => {
    const cases: Array<[FetchHandler, Partial<AlpacaError>]> = [
      [
        () => json({ message: "gateway timeout" }, 504),
        { kind: "http", status: 504, outcomeUnknown: true, retryable: false },
      ],
      [
        () => {
          throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
        },
        { kind: "network", status: null, outcomeUnknown: true, retryable: false },
      ],
      [(_call, signal) => hang(signal), { kind: "timeout", outcomeUnknown: true, retryable: false }],
      // A 429 is a refusal before anything happened: safe to send again later, and the client says so.
      [
        () => json({ message: "rate limit exceeded" }, 429),
        { kind: "rateLimited", outcomeUnknown: false, retryable: true },
      ],
      [
        () => json({ code: 40310000, message: "insufficient buying power" }, 403),
        { kind: "http", status: 403, alpacaCode: 40310000, outcomeUnknown: false, retryable: false },
      ],
    ];
    for (const [handler, expected] of cases) {
      const { alpaca, calls } = client(handler, { timeoutMs: 20 });
      const error = await alpaca.trading.submitOrder(STOP_ENTRY).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AlpacaError);
      expect(error).toMatchObject(expected);
      expect(calls).toHaveLength(1);
    }
  });

  it("does not retry a cancel or a close either", async () => {
    const { alpaca, calls } = client(() => json({ message: "unavailable" }, 503));
    await expect(alpaca.trading.cancelOrder(ORDER.id)).rejects.toMatchObject({ outcomeUnknown: true });
    await expect(alpaca.trading.closeAllPositions({ cancelOrders: true })).rejects.toMatchObject({
      outcomeUnknown: true,
    });
    expect(calls).toHaveLength(2);
  });

  it("reports a body that fails its schema, without retrying, and says a mutation still happened", async () => {
    const garbage = client(() => json({ equity: 12 }));
    const error = (await garbage.alpaca.trading.getAccount().catch((e: unknown) => e)) as AlpacaError;
    expect(error.kind).toBe("invalidResponse");
    expect(error.message).toContain("id: Required");
    expect(garbage.calls).toHaveLength(1);

    const notJson = client(() => new Response("{", { status: 200 }));
    await expect(notJson.alpaca.trading.getClock()).rejects.toMatchObject({ kind: "invalidResponse" });
    const empty = client(() => new Response("", { status: 200 }));
    await expect(empty.alpaca.trading.getClock()).rejects.toThrow("(root): Expected object, received null");

    const accepted = client(() => json({ id: "only-an-id" }));
    await expect(accepted.alpaca.trading.submitOrder(STOP_ENTRY)).rejects.toMatchObject({
      kind: "invalidResponse",
      status: 200,
      outcomeUnknown: false,
    });

    const oddBulk = client(() => json([{ id: "x", status: 200, body: { neither: true } }], 207));
    await expect(oddBulk.alpaca.trading.cancelAllOrders()).rejects.toThrow("neither an order nor an error");
  });

  it("waits out a 429 on a GET for the server's Retry-After, holding every other request too", async () => {
    let refused = false;
    const { alpaca, calls } = client((call) => {
      if (!refused) {
        refused = true;
        return json({ message: "rate limit exceeded" }, 429, { "retry-after": "0.08" });
      }
      return call.url.pathname === "/v2/clock"
        ? json({
            is_open: false,
            next_open: "2026-09-23T09:30:00-04:00",
            next_close: "2026-09-23T16:00:00-04:00",
            timestamp: "2026-09-22T20:00:00-04:00",
          })
        : json(ACCOUNT);
    });
    const started = Date.now();
    const first = alpaca.trading.getAccount();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = alpaca.trading.getClock();
    await Promise.all([first, second]);
    expect(calls).toHaveLength(3);
    expect((calls[1]?.at ?? 0) - started).toBeGreaterThanOrEqual(75);
    expect((calls[2]?.at ?? 0) - started).toBeGreaterThanOrEqual(75);
  });

  it("reads the wait from X-RateLimit-Reset or an HTTP date when that is what the server sends", async () => {
    for (const headers of [
      { "x-ratelimit-reset": String(Math.ceil(Date.now() / 1_000) + 1) },
      { "retry-after": new Date(Date.now() + 2_000).toUTCString() },
      {},
    ]) {
      const { alpaca } = client(() => json({ message: "slow down" }, 429, headers));
      const error = (await alpaca.trading.submitOrder(STOP_ENTRY).catch((e: unknown) => e)) as AlpacaError;
      expect(error.kind).toBe("rateLimited");
      expect(error.retryAfterMs).toBeGreaterThan(0);
      expect(error.retryAfterMs).toBeLessThanOrEqual(3_000);
    }
  });

  it("pauses when the server says no requests remain, until its reset", async () => {
    vi.useFakeTimers({ now: 1_790_107_000_000, toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { alpaca, calls } = client(() =>
      json(ACCOUNT, 200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(1_790_107_000 + 5) }),
    );
    await alpaca.trading.getAccount();
    const second = alpaca.trading.getAccount();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await second;
    expect(calls).toHaveLength(2);
  });
});

describe("AlpacaClient under a burst", () => {
  it("keeps 250 concurrent reads inside Alpaca's 200 a minute, with zero 429s, and puts an order first", async () => {
    vi.useFakeTimers({ now: 1_790_107_000_000, toFake: ["Date", "setTimeout", "clearTimeout"] });
    // The server's side: a sliding 60 s window of 200, refusing anything over it.
    const served: number[] = [];
    let refusals = 0;
    const { alpaca, calls } = client((call) => {
      const now = Date.now();
      while (served.length > 0 && now - (served[0] as number) >= 60_000) {
        served.shift();
      }
      if (served.length >= 200) {
        refusals += 1;
        return json({ message: "rate limit exceeded" }, 429);
      }
      served.push(now);
      return call.method === "POST" ? json(ORDER) : json([POSITION]);
    });
    const reads = Array.from({ length: 250 }, () => alpaca.trading.getPositions());
    await vi.advanceTimersByTimeAsync(1_000);
    const order = alpaca.trading.submitOrder(STOP_ENTRY);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await Promise.all([...reads, order]);

    expect(refusals).toBe(0);
    expect(calls).toHaveLength(251);
    const times = calls.map((call) => call.at);
    for (let i = 0; i < times.length; i += 1) {
      const inWindow = times.filter((t) => t >= (times[i] as number) && t < (times[i] as number) + 60_000);
      expect(inWindow.length).toBeLessThanOrEqual(200);
    }
    // The order jumped the queue of reads still waiting for tokens.
    const orderIndex = calls.findIndex((call) => call.method === "POST");
    expect(orderIndex).toBeLessThan(30);
  });
});
