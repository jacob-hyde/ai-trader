/**
 * Data and execution adapters.
 *
 * One interface, three implementations: backtest (Timescale replay), paper (Alpaca paper), live (Alpaca
 * live). The engine codes against the interface and never knows which one it has (EPIC-F).
 *
 * Here today: the interface, a stub that does nothing, and the synthetic adapter that replays seeded
 * sessions into a simulated broker. The backtest adapter reuses that broker over stored rows.
 */

export * from "./adapter.js";
export * from "./clock.js";
export * from "./events.js";
export * from "./simulatedExecution.js";
export * from "./stub.js";
export * from "./synthetic.js";
