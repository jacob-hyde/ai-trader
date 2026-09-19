/**
 * Shared types and schemas between the engine, the adapters, and the web app.
 *
 * The LLM payload/response contract and the decision-log schema land here (EPIC-E).
 */

/** Engine run modes. One engine, three adapters. */
export const RUN_MODES = ["backtest", "paper", "live"] as const;
export type RunMode = (typeof RUN_MODES)[number];
