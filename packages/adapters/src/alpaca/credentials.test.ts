import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AlpacaClient, type AlpacaOrderRequest } from "./client.js";
import type { Logger } from "./logger.js";
import { type FetchHandler, MockStreamServer, fakeFetch, hang, json } from "./testing.js";

// Distinctive, so a leak anywhere is found by substring.
const KEY = "PKLEAKCANARYKEY4242";
const SECRET = "leak-canary-secret-4242424242424242";

const servers: MockStreamServer[] = [];
const clients: AlpacaClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

/** Everything a human or a log shipper could ever see from the client. */
function capture() {
  const seen: string[] = [];
  const write =
    (level: string) =>
    (message: string, fields?: Readonly<Record<string, unknown>>): void => {
      seen.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
    };
  const logger: Logger = {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
  const exhibit = (value: unknown): void => {
    seen.push(inspect(value, { depth: 10, showHidden: true }));
    if (value instanceof Error) {
      seen.push(value.message, value.stack ?? "", JSON.stringify(value));
    } else {
      seen.push(JSON.stringify(value) ?? "");
    }
  };
  return { seen, logger, exhibit };
}

function leaks(seen: readonly string[]): string[] {
  return seen.filter((text) => text.includes(KEY) || text.includes(SECRET));
}

const ORDER: AlpacaOrderRequest = {
  symbol: "AAPL",
  qty: "1",
  side: "buy",
  type: "market",
  time_in_force: "day",
  client_order_id: "leak-test-1",
};

describe("credentials", () => {
  it("never appear in a log line, an error, or the client itself, whatever REST does", async () => {
    const { seen, logger, exhibit } = capture();
    const script: FetchHandler[] = [
      () => json({ message: "unavailable" }, 503),
      () => {
        throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
      },
      (_call, signal) => hang(signal),
      () => json({ message: "rate limit exceeded" }, 429, { "retry-after": "0" }),
      () => json({ code: 40410000, message: "not found" }, 404),
      () => json({ code: 40110000, message: "request is not authorized" }, 401),
      () => new Response("<html>oops</html>", { status: 200 }),
    ];
    let step = 0;
    const { fetch } = fakeFetch((call, signal) => {
      // The headers are the one place the credentials belong.
      expect(call.headers.get("APCA-API-KEY-ID")).toBe(KEY);
      const handler = script[step % script.length] as FetchHandler;
      step += 1;
      return handler(call, signal);
    });
    const alpaca = new AlpacaClient({
      keyId: KEY,
      secretKey: SECRET,
      tradingUrl: "https://paper-api.example",
      fetch,
      logger,
      timeoutMs: 20,
      maxAttempts: 3,
      retryBackoff: { initialMs: 1, maxMs: 2, multiplier: 2 },
    });
    clients.push(alpaca);
    const attempts: Array<() => Promise<unknown>> = [
      () => alpaca.trading.getAccount(),
      () => alpaca.trading.getAccount(),
      () => alpaca.trading.submitOrder(ORDER),
      () => alpaca.trading.submitOrder(ORDER),
      () => alpaca.trading.submitOrder(ORDER),
      () => alpaca.trading.submitOrder(ORDER),
      () => alpaca.data.getSnapshots(["AAPL"]),
      () => alpaca.trading.submitOrder({ ...ORDER, qty: "0" }),
    ];
    for (const attempt of attempts) {
      await attempt().then(exhibit, exhibit);
    }
    exhibit(alpaca);
    exhibit(alpaca.trading);
    exhibit(alpaca.data);
    expect(seen.some((text) => text.startsWith("warn alpaca request retrying"))).toBe(true);
    expect(seen.some((text) => text.includes("invalidRequest"))).toBe(true);
    expect(leaks(seen)).toEqual([]);
  });

  it("go out only in the auth message on both streams, and nowhere else, through failures and reconnects", async () => {
    const { seen, logger, exhibit } = capture();
    const data = await MockStreamServer.start({ protocol: "marketData", keyId: KEY, secretKey: SECRET });
    const trading = await MockStreamServer.start({ protocol: "tradeUpdates", keyId: KEY, secretKey: SECRET });
    servers.push(data, trading);
    data.refuseAuthWith = [406];
    const alpaca = new AlpacaClient({
      keyId: KEY,
      secretKey: SECRET,
      tradingUrl: `http://127.0.0.1:${String(trading.port)}`,
      streamUrl: data.origin,
      logger,
      reconnectBackoff: { initialMs: 5, maxMs: 10, multiplier: 2 },
    });
    clients.push(alpaca);
    const market = alpaca.marketDataStream();
    const orders = alpaca.tradeUpdatesStream();
    for (const event of ["error", "disconnect", "reconnect"] as const) {
      market.on(event, exhibit);
      orders.on(event, exhibit);
    }
    await Promise.all([market.connect(), orders.connect()]);
    await market.subscribe({ bars: ["AAPL"] });
    data.pushRaw("not json");
    data.dropAll();
    trading.dropAll();
    await Promise.all([
      new Promise((resolve) => market.on("reconnect", resolve)),
      new Promise((resolve) => orders.on("reconnect", resolve)),
    ]);
    exhibit(market);
    exhibit(orders);
    exhibit(alpaca);

    // A client with the wrong secret fails, and its failure does not echo what it sent either.
    const wrong = new AlpacaClient({
      keyId: KEY,
      secretKey: `${SECRET}-wrong`,
      tradingUrl: "http://127.0.0.1:1",
      streamUrl: data.origin,
      logger,
    });
    clients.push(wrong);
    await wrong.marketDataStream().connect().catch(exhibit);

    const auths = [...data.sent("auth"), ...trading.sent("auth")];
    expect(auths.length).toBeGreaterThanOrEqual(5);
    expect(auths.every((message) => message["key"] === KEY)).toBe(true);
    expect(seen.some((text) => text.includes("connectionLimit"))).toBe(true);
    expect(seen.some((text) => text.includes("alpaca stream failed"))).toBe(true);
    expect(leaks(seen)).toEqual([]);
  });
});
