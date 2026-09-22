/**
 * Shared types and schemas between the engine, the adapters, and the web app.
 *
 * The leaf of the dependency graph: nothing here imports another workspace package, so core, the
 * adapters, the engine, and the web app's TypeScript can all speak the same vocabulary. Every type that
 * crosses a process boundary, engine to Redis to web, has a zod schema beside it, and money on the wire
 * is the integer unit count, never a float.
 *
 * The LLM payload and response contract and the decision-log schema land here too (EPIC-E).
 */

export * from "./bars.js";
export * from "./candidate.js";
export * from "./health.js";
export * from "./marketData.js";
export * from "./money.js";
export * from "./orders.js";
export * from "./runMode.js";
export * from "./signals.js";
export * from "./time.js";
