/**
 * Exercises the Alpaca client against the real paper account and data feed. Read-only: nothing here can
 * place, change, or cancel an order.
 *
 * Covers every REST read, a burst through the rate limiter, and both websockets. The market-data stream
 * opens on Alpaca's "test" feed by default, which streams the FAKEPACA symbol around the clock, so this
 * runs outside market hours too. Pass a feed ("iex") to use the real one while the market is open.
 *
 * Alpaca allows one market-data connection per account: do not run this while the engine holds it.
 *
 *   pnpm alpaca:smoke [test|iex|sip]
 */

import type { StreamFeed } from "@trader/adapters/alpaca";
import { createAlpacaClient } from "../alpaca.js";
import { loadConfig } from "../config.js";

const cfg = loadConfig();
if (cfg.TRADING_MODE === "live" || !cfg.ALPACA_BASE_URL.includes("paper")) {
  console.error("[smoke] paper only: set TRADING_MODE=paper and a paper ALPACA_BASE_URL");
  process.exit(1);
}
const streamFeed = (process.argv[2] ?? "test") as StreamFeed;
const symbol = streamFeed === "test" ? "FAKEPACA" : "AAPL";
const alpaca = createAlpacaClient(cfg);
let failures = 0;

async function check(name: string, run: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await run();
    console.log(`  ok   ${name} (${String(Date.now() - started)} ms) ${detail}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${what}: none within ${String(ms)} ms`)), ms),
    ),
  ]);
}

console.log(`[smoke] ${cfg.ALPACA_BASE_URL}, data feed ${cfg.ALPACA_DATA_FEED}, stream feed ${streamFeed}`);

console.log("trading REST");
let lastSession = "";
await check("account", async () => {
  const a = await alpaca.trading.getAccount();
  return `${a.account_number} ${a.status} equity=${a.equity}`;
});
await check("clock", async () => {
  const c = await alpaca.trading.getClock();
  return `open=${String(c.is_open)} next_open=${c.next_open}`;
});
await check("calendar", async () => {
  const today = new Date();
  const start = new Date(today.getTime() - 10 * 86_400_000).toISOString().slice(0, 10);
  const days = await alpaca.trading.getCalendar({ start, end: today.toISOString().slice(0, 10) });
  // The last day that has fully closed, for the bars check.
  lastSession = days.at(-2)?.date ?? "";
  return `${String(days.length)} trading days since ${start}, last complete ${lastSession}`;
});
await check("positions", async () => `${String((await alpaca.trading.getPositions()).length)} open`);
await check(
  "orders",
  async () => `${String((await alpaca.trading.getOrders({ status: "open", nested: true })).length)} open`,
);
await check("order by client id (never sent)", async () => {
  const order = await alpaca.trading.getOrderByClientOrderId("smoke-never-submitted");
  if (order !== null) {
    throw new Error("expected null");
  }
  return "null, as it should be";
});
await check("asset", async () => {
  const asset = await alpaca.trading.getAsset("AAPL");
  return `${asset?.symbol ?? "missing"} tradable=${String(asset?.tradable)}`;
});
await check("inactive assets", async () => {
  const assets = await alpaca.trading.getAssets({ status: "inactive", assetClass: "us_equity" });
  return `${String(assets.length)} delisted or inactive`;
});

console.log("market-data REST");
await check("bars (SIP, a closed session)", async () => {
  const bars = await alpaca.data.getBars({
    symbols: ["AAPL", "MSFT"],
    timeframe: "1Min",
    start: `${lastSession}T13:30:00Z`,
    end: `${lastSession}T13:35:00Z`,
    adjustment: "all",
    feed: "sip",
  });
  return Object.entries(bars)
    .map(([s, list]) => `${s}:${String(list.length)}`)
    .join(" ");
});
await check("snapshots", async () => {
  const snaps = await alpaca.data.getSnapshots(["AAPL", "MSFT", "ZZZZNOTREAL"]);
  return `${Object.keys(snaps).join(",")} (the unknown symbol is dropped)`;
});
await check("latest quotes", async () => {
  const q = (await alpaca.data.getLatestQuotes(["AAPL"]))["AAPL"];
  return `AAPL ${String(q?.bp)} x ${String(q?.ap)}`;
});
await check("most actives", async () => {
  const m = await alpaca.data.getMostActives({ by: "volume", top: 5 });
  return m.most_actives.map((row) => row.symbol).join(",");
});
await check("movers", async () => {
  const m = await alpaca.data.getMovers({ top: 3 });
  return `${String(m.gainers.length)} gainers, ${String(m.losers.length)} losers`;
});
await check("news", async () => {
  const page = await alpaca.data.getNewsPage({ symbols: ["AAPL"], limit: 3 });
  return `${String(page.items.length)} articles, more=${String(page.nextPageToken !== null)}`;
});

console.log("rate limiter");
await check("burst of 40 clock reads", async () => {
  const started = Date.now();
  await Promise.all(Array.from({ length: 40 }, () => alpaca.trading.getClock()));
  // 20 go at once, the other 20 at one per 333 ms.
  return `all answered in ${String(Date.now() - started)} ms, no 429`;
});

console.log("websockets");
await check(`market data (${streamFeed})`, async () => {
  const stream = alpaca.marketDataStream(streamFeed);
  const first = new Promise<string>((resolve) => {
    stream.on("trade", (t) => resolve(`trade ${t.S} ${String(t.p)}`));
    stream.on("quote", (q) => resolve(`quote ${q.S} ${String(q.bp)} x ${String(q.ap)}`));
  });
  await withTimeout(stream.connect(), 10_000, "connect");
  await withTimeout(
    stream.subscribe({ trades: [symbol], quotes: [symbol], bars: [symbol] }),
    10_000,
    "subscribe ack",
  );
  const seen = await withTimeout(first, 20_000, "data");
  await stream.unsubscribe({ trades: [symbol], quotes: [symbol], bars: [symbol] });
  await stream.close();
  return `subscribed, first ${seen}, unsubscribed, closed`;
});
await check("trade updates", async () => {
  const stream = alpaca.tradeUpdatesStream();
  await withTimeout(stream.connect(), 10_000, "connect");
  await stream.close();
  return "authorized, listening, closed";
});

await alpaca.close();
console.log(failures === 0 ? "[smoke] all ok" : `[smoke] ${String(failures)} failed`);
process.exit(failures === 0 ? 0 : 1);
