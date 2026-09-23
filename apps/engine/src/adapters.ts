import type { RunMode } from "@trader/contracts";
import { type Adapter, StubAdapter } from "@trader/adapters";

/**
 * Picks the adapter for a run mode.
 *
 * Every mode gets the stub until its real adapter lands: Alpaca paper (F.3) and Alpaca live (F.4). The
 * backtest adapter (F.2) needs a date range, a universe, and a bar store that a mode alone does not
 * carry, so the backtest runner (L.1) builds a BacktestAdapter itself and backtest stays the stub here.
 * The engine codes against the Adapter interface either way.
 */
export function createAdapter(mode: RunMode): Adapter {
  return new StubAdapter(mode);
}
