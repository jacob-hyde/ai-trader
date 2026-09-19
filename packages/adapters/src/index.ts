/**
 * Data and execution adapters.
 *
 * One interface, three implementations: backtest (Timescale replay), paper (Alpaca paper), live (Alpaca
 * live). The engine codes against the interface and never knows which one it has (EPIC-F).
 */
import type { RunMode } from "@trader/contracts";

export const ADAPTER_MODES: readonly RunMode[] = ["backtest", "paper", "live"];
