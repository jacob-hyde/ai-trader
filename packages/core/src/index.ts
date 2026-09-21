/**
 * Deterministic decision core.
 *
 * Pure functions only. No broker, network, LLM, clock, or filesystem access is allowed in this package.
 * Everything risky depends on it and it depends on nothing, which is what makes it fully unit-testable.
 *
 * Sizing, risk rules, indicators, the Setup interface, and the ORB setup land here (EPIC-C).
 */
export const CORE_VERSION = "0.0.1";

export * from "./money.js";
