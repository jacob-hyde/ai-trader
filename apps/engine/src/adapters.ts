import type { RunMode } from "@trader/contracts";
import { type Adapter, StubAdapter } from "@trader/adapters";

/**
 * Picks the adapter for a run mode.
 *
 * Every mode gets the stub until its real adapter lands: the Timescale replay for backtest (F.2), Alpaca
 * paper (F.3), and Alpaca live (F.4). The engine codes against the Adapter interface either way, so the
 * swap is here and nowhere else.
 */
export function createAdapter(mode: RunMode): Adapter {
  return new StubAdapter(mode);
}
