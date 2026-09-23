/**
 * Data and execution adapters.
 *
 * One interface, three implementations: backtest (Timescale replay), paper (Alpaca paper), live (Alpaca
 * live). The engine codes against the interface and never knows which one it has (EPIC-F).
 *
 * Here today: the interface, a stub that does nothing, the synthetic adapter that replays seeded
 * sessions into a simulated broker, and the backtest adapter that replays stored bars into the same
 * broker through a ReplaySource (the Timescale one lives with the bar store in @trader/data).
 */

export * from "./adapter.js";
export * from "./backtest.js";
export * from "./clock.js";
export * from "./events.js";
export * from "./replaySource.js";
export * from "./simulatedExecution.js";
export * from "./stub.js";
export * from "./synthetic.js";
