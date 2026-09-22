/**
 * The ticker list: every symbol any source says traded in the period.
 *
 * Survivorship lives or dies here. Alpaca's asset list holds today's tickers and some old ones, but it
 * drops many delisted names outright (TWTR, SIVB, and BBBY's bankruptcy were all missing in 2026-09),
 * while the bars for those tickers are still served. So the list is a union: the asset list, both
 * sides of every name change, every merger's acquiree, and every worthless removal from Alpaca's
 * corporate actions, and any file of extra tickers. Corporate actions only go back to about 2019, so
 * names that left before then and are not in the asset list stay missing unless a file supplies them.
 *
 * OTC tickers stay in. A failed bank can keep its ticker on OTC (SBNY did), and that ticker is the only
 * way to its exchange-listed years. The liquidity screen keeps OTC trading out of the minute bars.
 */

import type { AlpacaAsset, AlpacaCorporateActions } from "@trader/adapters/alpaca";
import type { SymbolSource } from "./store.js";

/** Exchange tickers as Alpaca writes them, e.g. "AAPL", "BRK.B". Anything else (CUSIPs, blanks) is not one. */
const TICKER = /^[A-Z][A-Z0-9.]{0,9}$/;

export function isTicker(symbol: string): boolean {
  return TICKER.test(symbol);
}

export function fromAssets(assets: readonly AlpacaAsset[]): SymbolSource[] {
  return assets
    .filter((asset) => asset.class === "us_equity" && isTicker(asset.symbol))
    .map((asset) => ({ symbol: asset.symbol, source: `asset:${asset.status}` }));
}

export function fromCorporateActions(actions: AlpacaCorporateActions): SymbolSource[] {
  const found: SymbolSource[] = [];
  for (const merger of [
    ...actions.cash_mergers,
    ...actions.stock_mergers,
    ...actions.stock_and_cash_mergers,
  ]) {
    found.push({ symbol: merger.acquiree_symbol, source: "merger" });
  }
  for (const change of actions.name_changes) {
    found.push({ symbol: change.old_symbol, source: "nameChange" });
    found.push({ symbol: change.new_symbol, source: "nameChange" });
  }
  for (const removal of actions.worthless_removals) {
    found.push({ symbol: removal.symbol, source: "worthless" });
  }
  return found.filter((entry) => isTicker(entry.symbol));
}

/** One ticker per line; blank lines and "#" comments are ignored. */
export function fromFile(text: string, name: string): SymbolSource[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim().toUpperCase())
    .filter(isTicker)
    .map((symbol) => ({ symbol, source: `file:${name}` }));
}
