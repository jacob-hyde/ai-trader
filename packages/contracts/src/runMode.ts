/** Engine run modes. One engine, three adapters. */
export const RUN_MODES = ["backtest", "paper", "live"] as const;
export type RunMode = (typeof RUN_MODES)[number];
