/**
 * Real fills, priced from historical SIP trades and quotes, for checking the cost model against the
 * market (the cost check after L.2).
 *
 * A stop order waits until a print reaches its level, then goes to market. So a stop buy fills at the
 * ask prevailing a moment after the first print at or above its trigger, and a stop sell at the bid a
 * moment after the first print at or below its stop. A market order sent at a minute's open fills at
 * that moment's quote. A resting limit fills at its limit. One share, so the touch always holds it.
 *
 * Only prints that set the last sale can trigger a stop. Odd lots, average-price and out-of-sequence
 * reports, and the other conditions in NON_TRIGGERING do not.
 */

export interface Print {
  /** Milliseconds since the epoch. */
  readonly at: number;
  readonly price: number;
  readonly conditions: readonly string[];
}

export interface Quote {
  readonly at: number;
  readonly bid: number;
  readonly ask: number;
}

/**
 * Sale conditions that do not update the last sale: odd lot (I), average price (W, B), sold out of
 * sequence (Z, U), extended hours (T), derivatively priced (4), qualified contingent (7), contingent
 * (V), cash (C), next day (N), seller (R), price variation (H), bunched sold (G), prior reference (P),
 * and the market centers' official open and close (Q, M), and a corrected close (9).
 */
export const NON_TRIGGERING: ReadonlySet<string> = new Set([
  "I",
  "W",
  "B",
  "Z",
  "U",
  "T",
  "4",
  "7",
  "V",
  "C",
  "N",
  "R",
  "H",
  "G",
  "P",
  "Q",
  "M",
  "9",
]);

/** How long after the trigger the order reaches the market. */
export const LATENCY_MS = 250;

/** The first print that could trigger a stop at `level`, going up for a buy stop, down for a sell stop. */
export function firstThrough(
  prints: readonly Print[],
  level: number,
  direction: "up" | "down",
): Print | null {
  for (const print of prints) {
    if (print.conditions.some((c) => NON_TRIGGERING.has(c.trim()))) {
      continue;
    }
    if (direction === "up" ? print.price >= level - 1e-9 : print.price <= level + 1e-9) {
      return print;
    }
  }
  return null;
}

/** A usable quote: both sides present and not crossed. */
export function sane(quote: Quote): boolean {
  return quote.bid > 0 && quote.ask > 0 && quote.ask >= quote.bid;
}

export interface MeasuredLeg {
  /** When the order reached the market. */
  readonly at: number;
  /** What one share filled at. */
  readonly fill: number;
  readonly quote: Quote;
}

/** A stop or market order's fill: the touch of the quote prevailing when it reached the market. */
export function marketFill(side: "buy" | "sell", quote: Quote): number {
  return side === "buy" ? quote.ask : quote.bid;
}
