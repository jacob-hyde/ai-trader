/**
 * Official auction prints, the fill of an order on the open or on the close (Round 2, section 4).
 *
 * Every venue can report an opening or closing print; the listing exchange's cross is the official one
 * and by far the largest. So the auction price is the largest print carrying the opening condition
 * ("O", or "Q" where only that is reported) in the session's first 15 minutes, or the closing condition
 * ("6", or "M") in the 5 minutes after the close. A late-opening name is still found inside the window.
 * Each lookup is kept, a miss as a null price, so no symbol-session is asked twice.
 */

import type { AlpacaClient } from "@trader/adapters/alpaca";
import type { Fixed, SessionDate } from "@trader/contracts";
import { fromNumber } from "@trader/core";
import type pg from "pg";

export type AuctionKind = "open" | "close";

export const AUCTION_CONDITIONS: Readonly<Record<AuctionKind, ReadonlySet<string>>> = {
  open: new Set(["O", "Q"]),
  close: new Set(["6", "M"]),
};

export const AUCTION_WINDOW_MS: Readonly<Record<AuctionKind, number>> = {
  open: 15 * 60_000,
  close: 5 * 60_000,
};

export interface AuctionTrade {
  readonly at: number;
  readonly price: number;
  readonly size: number;
  readonly exchange: string;
  readonly conditions: readonly string[];
}

export interface AuctionPrint {
  readonly price: Fixed;
  readonly size: number;
  readonly at: number;
  readonly exchange: string;
}

/** The largest print carrying the kind's condition, the earliest on a tie. Null when there is none. */
export function auctionPrint(trades: readonly AuctionTrade[], kind: AuctionKind): AuctionPrint | null {
  const wanted = AUCTION_CONDITIONS[kind];
  let best: AuctionTrade | null = null;
  for (const trade of trades) {
    if (trade.conditions.some((c) => wanted.has(c.trim())) && (best === null || trade.size > best.size)) {
      best = trade;
    }
  }
  return best === null
    ? null
    : { price: fromNumber(best.price), size: best.size, at: best.at, exchange: best.exchange };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** How long after the first auction print to keep reading, for a larger one from the listing exchange. */
const SETTLE_MS = 60_000;

/** The session's auction print for a symbol, from the store if looked up before, else from SIP trades. */
export async function loadAuction(
  alpaca: AlpacaClient,
  pool: pg.Pool,
  symbol: string,
  session: { readonly session: SessionDate; readonly openAt: number; readonly closeAt: number },
  kind: AuctionKind,
): Promise<AuctionPrint | null> {
  const kept = await pool.query<{
    price: string | null;
    size: string | null;
    at: Date | null;
    exchange: string | null;
  }>(
    "SELECT price, size, at, exchange FROM auction_prints WHERE session = $1 AND symbol = $2 AND kind = $3",
    [session.session, symbol, kind],
  );
  const row = kept.rows[0];
  if (row !== undefined) {
    return row.price === null
      ? null
      : {
          price: Number(row.price) as Fixed,
          size: Number(row.size),
          at: (row.at as Date).getTime(),
          exchange: row.exchange ?? "",
        };
  }
  const from = kind === "open" ? session.openAt : session.closeAt;
  const trades: AuctionTrade[] = [];
  let firstSeen: number | null = null;
  for await (const page of alpaca.data.iterateTrades({
    symbols: [symbol],
    start: iso(from),
    end: iso(from + AUCTION_WINDOW_MS[kind] - 1),
    limit: 10_000,
    feed: "sip",
    asof: "-",
  })) {
    for (const t of page.items[symbol] ?? []) {
      const trade = { at: Date.parse(t.t), price: t.p, size: t.s, exchange: t.x, conditions: t.c ?? [] };
      trades.push(trade);
      if (firstSeen === null && trade.conditions.some((c) => AUCTION_CONDITIONS[kind].has(c.trim()))) {
        firstSeen = trade.at;
      }
    }
    const last = trades.at(-1);
    if (firstSeen !== null && last !== undefined && last.at > firstSeen + SETTLE_MS) {
      break;
    }
  }
  const found = auctionPrint(trades, kind);
  await pool.query(
    `INSERT INTO auction_prints (symbol, session, kind, price, size, at, exchange)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [
      symbol,
      session.session,
      kind,
      found?.price ?? null,
      found?.size ?? null,
      found === null ? null : iso(found.at),
      found?.exchange ?? null,
    ],
  );
  return found;
}
