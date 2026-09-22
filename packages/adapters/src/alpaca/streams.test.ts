import { afterEach, describe, expect, it } from "vitest";
import { AlpacaClient, type AlpacaClientOptions } from "./client.js";
import { AlpacaStreamError } from "./errors.js";
import type { MarketDataStream, StreamBar } from "./marketDataStream.js";
import { MockStreamServer, fakeFetch, json, until } from "./testing.js";
import type { AlpacaTradeUpdate } from "./tradeUpdatesStream.js";

const KEY = "PKSTREAMKEY00000000";
const SECRET = "stream-secret-000000000000000000000";

const servers: MockStreamServer[] = [];
const clients: AlpacaClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function server(protocol: "marketData" | "tradeUpdates", autoPong = true): Promise<MockStreamServer> {
  const s = await MockStreamServer.start({ protocol, keyId: KEY, secretKey: SECRET, autoPong });
  servers.push(s);
  return s;
}

function clientFor(s: MockStreamServer, options: Partial<AlpacaClientOptions> = {}): AlpacaClient {
  const c = new AlpacaClient({
    keyId: KEY,
    secretKey: SECRET,
    tradingUrl: `http://127.0.0.1:${String(s.port)}`,
    streamUrl: s.origin,
    fetch: fakeFetch(() => json({})).fetch,
    reconnectBackoff: { initialMs: 5, maxMs: 20, multiplier: 2 },
    heartbeatMs: 1_000,
    handshakeTimeoutMs: 300,
    acknowledgeTimeoutMs: 200,
    ...options,
  });
  clients.push(c);
  return c;
}

/** Records every event a stream raises, by name. */
function record(stream: MarketDataStream): Record<string, unknown[]> {
  const seen: Record<string, unknown[]> = {};
  for (const name of [
    "bar",
    "updatedBar",
    "dailyBar",
    "quote",
    "trade",
    "status",
    "error",
    "disconnect",
    "reconnect",
  ] as const) {
    stream.on(name, (payload: unknown) => (seen[name] ??= []).push(payload));
  }
  return seen;
}

const BAR = {
  T: "b",
  S: "AAPL",
  o: 337.91,
  h: 338.37,
  l: 336.57,
  c: 336.62,
  v: 8329964,
  t: "2026-09-18T13:30:00Z",
  n: 14347,
  vw: 338.3,
};
const QUOTE = {
  T: "q",
  S: "AAPL",
  bx: "V",
  bp: 339.75,
  bs: 40,
  ax: "V",
  ap: 339.84,
  as: 160,
  c: ["R"],
  z: "C",
  t: "2026-09-22T19:59:51.130469733Z",
};
const TRADE = {
  T: "t",
  S: "FAKEPACA",
  i: 1,
  x: "N",
  p: 134.56,
  s: 3,
  c: [" "],
  z: "A",
  t: "2026-09-22T19:59:43.291535119Z",
};
const STATUS = {
  T: "s",
  S: "AAPL",
  sc: "H",
  sm: "Trading Halt",
  rc: "T12",
  rm: "News Pending",
  t: "2026-09-22T14:00:00Z",
  z: "C",
};

describe("MarketDataStream", () => {
  it("authenticates, subscribes, and delivers every data type typed", async () => {
    const s = await server("marketData");
    const stream = clientFor(s).marketDataStream();
    const seen = record(stream);
    expect(stream.state).toBe("idle");
    await stream.connect();
    expect(stream.state).toBe("ready");
    expect(s.sent("auth")).toEqual([{ action: "auth", key: KEY, secret: SECRET }]);

    await stream.subscribe({ bars: ["AAPL", "MSFT"], quotes: ["AAPL"], trades: [], statuses: ["*"] });
    expect(s.sent("subscribe")).toEqual([
      { action: "subscribe", bars: ["AAPL", "MSFT"], quotes: ["AAPL"], statuses: ["*"] },
    ]);
    expect(stream.subscriptions()).toEqual({
      bars: ["AAPL", "MSFT"],
      updatedBars: [],
      dailyBars: [],
      quotes: ["AAPL"],
      trades: [],
      statuses: ["*"],
    });

    s.push([
      BAR,
      QUOTE,
      TRADE,
      STATUS,
      { ...BAR, T: "u", c: 336.7 },
      { ...BAR, T: "d" },
      { T: "c", S: "AAPL" },
    ]);
    await until(() => (seen["dailyBar"] ?? []).length === 1);
    expect((seen["bar"]?.[0] as StreamBar).S).toBe("AAPL");
    expect((seen["bar"]?.[0] as StreamBar).vw).toBe(338.3);
    expect(seen["bar"]?.[0]).not.toHaveProperty("T");
    expect((seen["updatedBar"]?.[0] as StreamBar).c).toBe(336.7);
    expect(seen["quote"]).toHaveLength(1);
    expect(seen["trade"]).toHaveLength(1);
    expect(seen["status"]).toEqual([
      { S: "AAPL", sc: "H", sm: "Trading Halt", rc: "T12", rm: "News Pending", t: STATUS.t, z: "C" },
    ]);
    expect(seen["error"]).toBeUndefined();
  });

  it("treats a repeat subscribe as done, and unsubscribes", async () => {
    const s = await server("marketData");
    const stream = clientFor(s).marketDataStream();
    await stream.connect();
    await stream.subscribe({ bars: ["AAPL"] });
    await stream.subscribe({ bars: ["AAPL"] });
    expect(s.sent("subscribe")).toHaveLength(1);
    await stream.unsubscribe({ bars: ["AAPL", "NEVER"] });
    expect(s.sent("unsubscribe")).toEqual([{ action: "unsubscribe", bars: ["AAPL", "NEVER"] }]);
    expect(stream.subscriptions().bars).toEqual([]);
    await stream.unsubscribe({ quotes: ["NEVER"] });
    expect(s.sent("unsubscribe")).toHaveLength(1);
  });

  it("reports a malformed message and keeps going", async () => {
    const s = await server("marketData");
    const stream = clientFor(s).marketDataStream();
    const seen = record(stream);
    await stream.connect();
    await stream.subscribe({ bars: ["AAPL"] });
    s.push([{ ...BAR, o: "not a number" }, { T: "toString" }, "just a string", BAR]);
    s.pushRaw("{broken");
    // A lone message outside an array is read too.
    s.pushRaw(JSON.stringify(BAR));
    await until(() => (seen["error"] ?? []).length === 2 && (seen["bar"] ?? []).length === 2);
    expect((seen["error"] as AlpacaStreamError[]).map((e) => e.message)).toEqual([
      'Alpaca marketData stream: a malformed "b" message',
      "Alpaca marketData stream: a frame that is not JSON",
    ]);
    expect(seen["bar"]).toHaveLength(2);
    expect(stream.state).toBe("ready");
  });

  it("reconnects after a drop, restores every subscription, and says what happened", async () => {
    const s = await server("marketData");
    const stream = clientFor(s, { handshakeTimeoutMs: 100, acknowledgeTimeoutMs: 1_000 }).marketDataStream();
    const seen = record(stream);
    await stream.connect();
    await stream.subscribe({ bars: ["AAPL", "MSFT"], quotes: ["AAPL"] });

    s.dropAll();
    await until(() => (seen["reconnect"] ?? []).length === 1, 2_000, "reconnect");
    expect(seen["disconnect"]).toEqual([{ at: expect.any(String), reason: "closed by the server (1006)" }]);
    expect(seen["reconnect"]).toEqual([{ at: expect.any(String), attempts: 1 }]);
    expect(s.accepted).toBe(2);
    expect(s.sent("auth")).toHaveLength(2);
    expect(s.sent("subscribe").at(-1)).toEqual({
      action: "subscribe",
      bars: ["AAPL", "MSFT"],
      quotes: ["AAPL"],
    });

    // Subscribing while it is down waits for the next connection. The silent server holds the stream
    // down until the handshake deadline, so the subscribe is sure to land in the gap.
    s.silent = true;
    s.dropAll();
    await until(() => (seen["disconnect"] ?? []).length === 2, 2_000, "second disconnect");
    const subscribing = stream.subscribe({ bars: ["NVDA"] });
    expect(stream.state).not.toBe("ready");
    s.silent = false;
    await subscribing;
    expect(stream.state).toBe("ready");
    expect(s.sent("subscribe").at(-1)).toEqual({
      action: "subscribe",
      bars: ["AAPL", "MSFT", "NVDA"],
      quotes: ["AAPL"],
    });

    s.push([BAR]);
    await until(() => (seen["bar"] ?? []).length === 1);
  });

  it("fails for good on bad credentials, and does not reconnect", async () => {
    const s = await server("marketData");
    const wrong = new AlpacaClient({
      keyId: KEY,
      secretKey: "wrong",
      tradingUrl: "http://127.0.0.1:1",
      streamUrl: s.origin,
    });
    clients.push(wrong);
    const refused = wrong.marketDataStream();
    const errors: AlpacaStreamError[] = [];
    refused.on("error", (error) => errors.push(error));
    const failure = (await refused.connect().catch((e: unknown) => e)) as AlpacaStreamError;
    expect(failure).toBeInstanceOf(AlpacaStreamError);
    expect(failure).toMatchObject({ kind: "auth", code: 402, fatal: true });
    expect(refused.state).toBe("failed");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(s.accepted).toBe(1);
    await expect(refused.subscribe({ bars: ["AAPL"] })).rejects.toBe(failure);
    await expect(refused.connect()).rejects.toBe(failure);
    await refused.close();
    expect(refused.state).toBe("failed");
    // Reported once, as it happened.
    expect(errors).toEqual([failure]);
  });

  it("fails for good when the plan lacks the feed", async () => {
    const s = await server("marketData");
    s.refuseAuthWith = [409];
    const stream = clientFor(s).marketDataStream("sip");
    await expect(stream.connect()).rejects.toMatchObject({
      kind: "subscriptionPlan",
      code: 409,
      fatal: true,
    });
  });

  it("retries through a connection-limit refusal, since the slot may be our own dead connection", async () => {
    const s = await server("marketData");
    s.refuseAuthWith = [406, 406];
    const stream = clientFor(s).marketDataStream();
    const errors: AlpacaStreamError[] = [];
    stream.on("error", (error) => errors.push(error));
    await stream.connect();
    expect(s.accepted).toBe(3);
    expect(errors.map((e) => [e.kind, e.code, e.fatal])).toEqual([
      ["connectionLimit", 406, false],
      ["connectionLimit", 406, false],
    ]);
  });

  it("reconnects on an unexpected server error during the handshake, and only reports one once ready", async () => {
    const s = await server("marketData");
    s.refuseAuthWith = [500];
    const stream = clientFor(s).marketDataStream();
    const errors: AlpacaStreamError[] = [];
    stream.on("error", (error) => errors.push(error));
    await stream.connect();
    expect(s.accepted).toBe(2);
    s.push([
      { T: "error", code: 500, msg: "internal error" },
      { T: "error", code: 403, msg: "already authenticated" },
    ]);
    await until(() => errors.length === 2);
    expect(errors.map((e) => e.kind)).toEqual(["server", "server"]);
    expect(stream.state).toBe("ready");
    expect(s.accepted).toBe(2);
  });

  it("rejects a refused subscription and falls back to what the server holds", async () => {
    const s = await server("marketData");
    s.symbolLimit = 2;
    const stream = clientFor(s).marketDataStream();
    await stream.connect();
    await stream.subscribe({ bars: ["AAPL", "MSFT"] });
    await expect(stream.subscribe({ bars: ["NVDA"] })).rejects.toMatchObject({
      kind: "subscription",
      code: 405,
    });
    expect(stream.subscriptions().bars).toEqual(["AAPL", "MSFT"]);
  });

  it("times out an unacknowledged subscribe but keeps the symbols for the next connection", async () => {
    const s = await server("marketData");
    const stream = clientFor(s).marketDataStream();
    await stream.connect();
    s.acknowledge = false;
    await expect(stream.subscribe({ quotes: ["AAPL"] })).rejects.toMatchObject({ kind: "timeout" });
    await expect(stream.unsubscribe({ quotes: ["AAPL"] })).resolves.toBeUndefined();
    await expect(stream.subscribe({ quotes: ["AAPL"] })).rejects.toMatchObject({ kind: "timeout" });
    expect(stream.subscriptions().quotes).toEqual(["AAPL"]);
    s.acknowledge = true;
    s.dropAll();
    await until(() => s.sent("subscribe").length === 3);
    expect(s.sent("subscribe").at(-1)).toEqual({ action: "subscribe", quotes: ["AAPL"] });
  });

  it("drops and reopens a connection that stops answering pings", async () => {
    const s = await server("marketData", false);
    const stream = clientFor(s, { heartbeatMs: 40 }).marketDataStream();
    const seen = record(stream);
    await stream.connect();
    await until(() => (seen["disconnect"] ?? []).length >= 1, 1_000, "heartbeat drop");
    expect((seen["disconnect"]?.[0] as { reason: string }).reason).toBe("no pong within 40 ms");
    await until(() => s.accepted >= 2);
  });

  it("stays up while the server answers its pings", async () => {
    const s = await server("marketData");
    const stream = clientFor(s, { heartbeatMs: 15 }).marketDataStream();
    const seen = record(stream);
    await stream.connect();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(seen["disconnect"]).toBeUndefined();
    expect(s.accepted).toBe(1);
  });

  it("keeps trying while the server is unreachable, and can still be closed", async () => {
    const s = await server("marketData");
    const origin = s.origin;
    await s.stop();
    servers.splice(servers.indexOf(s), 1);
    const c = new AlpacaClient({
      keyId: KEY,
      secretKey: SECRET,
      tradingUrl: "http://127.0.0.1:1",
      streamUrl: origin,
      reconnectBackoff: { initialMs: 5, maxMs: 10, multiplier: 2 },
    });
    clients.push(c);
    const stream = c.marketDataStream();
    const connecting = stream.connect();
    await until(() => stream.state === "reconnecting");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await stream.close();
    await expect(connecting).rejects.toMatchObject({ kind: "closed" });
  });

  it("gives up on a handshake that never finishes, and tries again", async () => {
    const s = await server("marketData");
    s.silent = true;
    const stream = clientFor(s, { handshakeTimeoutMs: 40 }).marketDataStream();
    const errors: AlpacaStreamError[] = [];
    stream.on("error", (error) => errors.push(error));
    const connecting = stream.connect();
    await until(() => s.accepted >= 2, 1_000, "second attempt");
    expect(errors[0]).toMatchObject({ kind: "timeout", fatal: false });
    s.silent = false;
    await connecting;
    expect(stream.state).toBe("ready");
  });

  it("closes for good: pending calls reject, nothing reconnects, and close is idempotent", async () => {
    const s = await server("marketData");
    const c = clientFor(s);
    const stream = c.marketDataStream();
    await stream.connect();
    s.acknowledge = false;
    const pending = stream.subscribe({ bars: ["AAPL"] });
    await stream.close();
    await expect(pending).rejects.toMatchObject({ kind: "closed" });
    expect(stream.state).toBe("closed");
    await stream.close();
    await expect(stream.connect()).rejects.toMatchObject({ kind: "closed" });
    await expect(stream.unsubscribe({ bars: ["AAPL"] })).rejects.toMatchObject({ kind: "closed" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(s.open).toBe(0);
    expect(s.accepted).toBe(1);

    // Closing before the first connect, or while connecting, also ends it.
    const idle = c.marketDataStream();
    expect(idle).not.toBe(stream);
    await idle.close();
    expect(idle.state).toBe("closed");
    const racing = c.marketDataStream();
    const connecting = racing.connect();
    await racing.close();
    await expect(connecting).rejects.toMatchObject({ kind: "closed" });
  });

  it("stays closed when the server's handshake answer arrives after close()", async () => {
    const s = await server("marketData");
    s.holdAuth = true;
    const stream = clientFor(s).marketDataStream();
    const connecting = stream.connect();
    await until(() => s.authHeld, 1_000, "the auth to arrive");
    expect(stream.state).toBe("authenticating");
    const closing = stream.close();
    // "authenticated" reaches the client after it asked to close, and before the close completes.
    s.releaseAuth();
    await closing;
    await expect(connecting).rejects.toMatchObject({ kind: "closed" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stream.state).toBe("closed");
    expect(s.accepted).toBe(1);
  });

  it("closes while waiting to reconnect", async () => {
    const s = await server("marketData");
    const stream = clientFor(s, {
      reconnectBackoff: { initialMs: 5_000, maxMs: 5_000, multiplier: 1 },
    }).marketDataStream();
    await stream.connect();
    s.dropAll();
    await until(() => stream.state === "reconnecting");
    await stream.close();
    expect(stream.state).toBe("closed");
  });

  it("is one per client, on one feed at a time", async () => {
    const s = await server("marketData");
    const c = clientFor(s);
    const stream = c.marketDataStream();
    expect(c.marketDataStream()).toBe(stream);
    expect(c.marketDataStream("iex")).toBe(stream);
    expect(() => c.marketDataStream("test")).toThrow('open on "iex"');
    await stream.connect();
    await c.close();
    const test = c.marketDataStream("test");
    await test.connect();
    expect(s.accepted).toBe(2);
  });
});

const FILL = {
  event: "fill",
  execution_id: "0f4a0b2e-exec",
  timestamp: "2026-09-21T13:36:02.004Z",
  price: "203.02",
  qty: "24",
  position_qty: "24",
  order: {
    id: "61e69015-8549-4bfd-b9c3-01e75843f47d",
    client_order_id: "orb-AAPL-20260921-50e967ae",
    created_at: "2026-09-21T13:35:01.123456Z",
    updated_at: "2026-09-21T13:36:02.004Z",
    submitted_at: "2026-09-21T13:35:01.1Z",
    filled_at: "2026-09-21T13:36:02.004Z",
    asset_id: "b0b6dd9d-8b9b-48a9-ba46-b9d54906e415",
    symbol: "AAPL",
    asset_class: "us_equity",
    qty: "24",
    filled_qty: "24",
    filled_avg_price: "203.02",
    order_class: "oto",
    type: "stop",
    side: "buy",
    time_in_force: "day",
    stop_price: "203",
    status: "filled",
    extended_hours: false,
  },
};

describe("TradeUpdatesStream", () => {
  it("reads binary frames: authorizes, listens, and delivers order events", async () => {
    const s = await server("tradeUpdates");
    const stream = clientFor(s).tradeUpdatesStream();
    const updates: AlpacaTradeUpdate[] = [];
    stream.on("tradeUpdate", (update) => updates.push(update));
    await stream.connect();
    expect(s.sent("auth")).toEqual([{ action: "auth", key: KEY, secret: SECRET }]);
    expect(s.sent("listen")).toEqual([{ action: "listen", data: { streams: ["trade_updates"] } }]);

    s.push({ stream: "trade_updates", data: FILL });
    s.push({
      stream: "trade_updates",
      data: {
        event: "new",
        order: { ...FILL.order, status: "new", filled_qty: "0", filled_avg_price: null },
      },
    });
    await until(() => updates.length === 2);
    expect(updates[0]).toMatchObject({ event: "fill", price: "203.02", qty: "24", position_qty: "24" });
    expect(updates[0]?.order.legs).toBeNull();
    expect(updates[1]).toMatchObject({ event: "new", price: null, timestamp: null, execution_id: null });
    expect(clientFor(s).tradeUpdatesStream()).not.toBe(stream);
  });

  it("reports malformed frames and ignores other streams", async () => {
    const s = await server("tradeUpdates");
    const stream = clientFor(s).tradeUpdatesStream();
    const errors: AlpacaStreamError[] = [];
    stream.on("error", (error) => errors.push(error));
    await stream.connect();
    s.push({ stream: "trade_updates", data: { event: "fill" } });
    s.push({ nope: true });
    s.pushRaw("}{");
    s.push({ stream: "something_else", data: {} });
    await until(() => errors.length === 3);
    expect(errors.map((e) => e.message.replace("Alpaca tradeUpdates stream: ", ""))).toEqual([
      "a malformed trade update",
      "a frame without stream and data",
      "a frame that is not JSON",
    ]);
    expect(stream.state).toBe("ready");
  });

  it("fails for good when unauthorized", async () => {
    const s = await server("tradeUpdates");
    const c = new AlpacaClient({
      keyId: KEY,
      secretKey: "wrong",
      tradingUrl: `http://127.0.0.1:${String(s.port)}`,
    });
    clients.push(c);
    const stream = c.tradeUpdatesStream();
    expect(c.tradeUpdatesStream()).toBe(stream);
    await expect(stream.connect()).rejects.toMatchObject({
      kind: "auth",
      fatal: true,
      stream: "tradeUpdates",
    });
    expect(stream.state).toBe("failed");
    expect(c.tradeUpdatesStream()).not.toBe(stream);
  });

  it("re-authorizes and listens again after a drop", async () => {
    const s = await server("tradeUpdates");
    const stream = clientFor(s).tradeUpdatesStream();
    const reconnects: unknown[] = [];
    stream.on("reconnect", (event) => reconnects.push(event));
    await stream.connect();
    s.dropAll();
    await until(() => reconnects.length === 1);
    expect(s.sent("listen")).toHaveLength(2);
  });

  it("reconnects when the server listens to the wrong thing", async () => {
    const s = await server("tradeUpdates");
    s.listenToNothing = true;
    const stream = clientFor(s).tradeUpdatesStream();
    const connecting = stream.connect();
    await until(() => s.accepted >= 2);
    s.listenToNothing = false;
    await connecting;
    expect(stream.state).toBe("ready");
  });
});
