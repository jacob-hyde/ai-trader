/**
 * The market tape from Alpaca's historical SIP trades and quotes, ticker at time, for the cost check.
 */

import type { AlpacaClient } from "@trader/adapters/alpaca";
import type { MarketTape } from "./costCheck.js";
import { type Print, type Quote, sane } from "./fills.js";

const iso = (ms: number) => new Date(ms).toISOString();

/** How far back to look for the quote prevailing at a moment. */
const QUOTE_LOOKBACK_MS = 60_000;

export class AlpacaTape implements MarketTape {
  readonly #client: AlpacaClient;

  constructor(client: AlpacaClient) {
    this.#client = client;
  }

  async prints(symbol: string, from: number, to: number): Promise<readonly Print[]> {
    const prints: Print[] = [];
    for await (const page of this.#client.data.iterateTrades({
      symbols: [symbol],
      start: iso(from),
      end: iso(to - 1),
      limit: 10_000,
      feed: "sip",
      asof: "-",
    })) {
      for (const trade of page.items[symbol] ?? []) {
        prints.push({ at: Date.parse(trade.t), price: trade.p, conditions: trade.c ?? [] });
      }
    }
    return prints;
  }

  /** Newest first, so one small page holds the prevailing quote unless the market was quoting wildly. */
  async quoteAt(symbol: string, at: number): Promise<Quote | null> {
    const page = await this.#client.data.getQuotesPage({
      symbols: [symbol],
      start: iso(at - QUOTE_LOOKBACK_MS),
      end: iso(at),
      limit: 100,
      feed: "sip",
      sort: "desc",
      asof: "-",
    });
    const quotes = (page.items[symbol] ?? []).map((q) => ({ at: Date.parse(q.t), bid: q.bp, ask: q.ap }));
    return quotes.find(sane) ?? null;
  }
}
