/**
 * Deterministic decision core.
 *
 * No broker, network, LLM, clock, or filesystem access is allowed in this package. Everything risky
 * depends on it, and it depends only on two pure libraries: trading-signals for the ATR and RSI math and
 * zod for setup parameter schemas. That is what makes it fully unit-testable.
 *
 * Pure functions throughout, except the incremental indicators, whose state is private and fed only by
 * closed bars.
 *
 * Sizing, risk rules, indicators, the Setup interface, and the ORB setup land here (EPIC-C).
 */
export const CORE_VERSION = "0.0.1";

export * from "./bars.js";
export * from "./brackets.js";
export * from "./costToRisk.js";
export * from "./costs.js";
export * from "./indicators.js";
export * from "./money.js";
export * from "./noopSetup.js";
export * from "./orb.js";
export * from "./riskRules.js";
export * from "./setup.js";
export * from "./sizing.js";
export * from "./tradeSim.js";
