/**
 * Where the bar store's data comes from. Alpaca in practice; a fake in the tests.
 */

import {
  type AlpacaAsset,
  type AlpacaBar,
  type AlpacaCalendarDay,
  type AlpacaClient,
  type AlpacaCorporateActions,
  AlpacaError,
} from "@trader/adapters/alpaca";

export type Timeframe = "1Day" | "1Min";

export interface BarsQuery {
  readonly timeframe: Timeframe;
  readonly symbols: readonly string[];
  /** RFC 3339, inclusive. */
  readonly start: string;
  /** RFC 3339, inclusive. */
  readonly end: string;
  /** "raw" is as traded. "split" scales earlier bars by later splits; only its volumes are used. */
  readonly adjustment: "raw" | "split";
}

/**
 * The source refused a symbol it does not know. Alpaca fails the whole request for one bad symbol, and
 * the asset list does carry a few codes that are not tickers (e.g. "B002455"), so the loader drops the
 * symbol named here and runs the rest again.
 */
export class InvalidSymbolError extends Error {
  readonly symbol: string;

  constructor(symbol: string, options?: ErrorOptions) {
    super(`invalid symbol: ${symbol}`, options);
    this.name = "InvalidSymbolError";
    this.symbol = symbol;
  }
}

export interface BarSource {
  calendar(start: string, end: string): Promise<readonly AlpacaCalendarDay[]>;
  /** Every US equity Alpaca knows, active and inactive. */
  assets(): Promise<readonly AlpacaAsset[]>;
  corporateActions(start: string, end: string): AsyncIterable<AlpacaCorporateActions>;
  /** Pages of bars keyed by symbol, oldest first within a symbol. Throws InvalidSymbolError for a bad symbol. */
  bars(query: BarsQuery): AsyncIterable<Readonly<Record<string, readonly AlpacaBar[]>>>;
}

/**
 * Alpaca as the source. Bars are SIP (every venue, not IEX alone) and ticker-at-time: symbol mapping is
 * off (asof "-"), so a symbol means what it meant on the bar's date.
 */
export function alpacaSource(client: AlpacaClient): BarSource {
  return {
    calendar: (start, end) => client.trading.getCalendar({ start, end }),
    async assets() {
      const [active, inactive] = await Promise.all([
        client.trading.getAssets({ status: "active", assetClass: "us_equity" }),
        client.trading.getAssets({ status: "inactive", assetClass: "us_equity" }),
      ]);
      return [...active, ...inactive];
    },
    async *corporateActions(start, end) {
      const pages = client.data.iterateCorporateActions({
        types: ["cash_merger", "stock_merger", "stock_and_cash_merger", "name_change", "worthless_removal"],
        start,
        end,
        limit: 1_000,
      });
      for await (const page of pages) {
        yield page.items;
      }
    },
    async *bars(query) {
      const pages = client.data.iterateBars({
        symbols: query.symbols,
        timeframe: query.timeframe,
        start: query.start,
        end: query.end,
        adjustment: query.adjustment,
        feed: "sip",
        asof: "-",
        limit: 10_000,
      });
      try {
        for await (const page of pages) {
          yield page.items;
        }
      } catch (error) {
        const invalid =
          error instanceof AlpacaError && error.status === 400
            ? /invalid symbol: (\S+)/.exec(error.message)
            : null;
        throw invalid?.[1] === undefined ? error : new InvalidSymbolError(invalid[1], { cause: error });
      }
    },
  };
}
