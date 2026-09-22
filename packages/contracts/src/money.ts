/**
 * The money vocabulary every package shares.
 *
 * A dollar value is an integer count of $0.0001 units carried in a plain number, so it serializes,
 * compares, and sorts like a number and never touches a float. Four places rather than two because
 * Alpaca reports sub-penny average fills and the live-vs-modeled slippage measurement needs them.
 *
 * On the wire the value is that same integer. A payload carrying `equity: 25000000` means $2,500.0000,
 * and a consumer in any language divides by SCALE. Never a float, never a string of dollars.
 *
 * Ratios are a second brand at the same scale, so one unit is exactly one basis point.
 *
 * The arithmetic lives in @trader/core. This module owns only the types, the constructors, the wire
 * schemas, and the display format.
 */

import { z } from "zod";

/** Dollar amount or price in units of $0.0001. Always a safe integer. */
export type Fixed = number & { readonly __brand: "Fixed" };

/** Dimensionless ratio in basis points: 1 is 0.01%, 10 000 is 100%. Always a safe integer. */
export type Ratio = number & { readonly __brand: "Ratio" };

export type MoneyErrorCode =
  "NOT_INTEGER" | "OUT_OF_RANGE" | "PARSE" | "DIVIDE_BY_ZERO" | "CROSSED_MARKET" | "NEGATIVE_QUANTITY";

export class MoneyError extends Error {
  readonly code: MoneyErrorCode;

  constructor(code: MoneyErrorCode, message: string) {
    super(message);
    this.name = "MoneyError";
    this.code = code;
  }
}

/** Units per dollar. */
export const SCALE = 10_000;

function assertInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError("NOT_INTEGER", `${what} must be a safe integer, got ${String(value)}`);
  }
}

/** Brands an integer count of $0.0001 units. Rejects anything that isn't a safe integer, including -0. */
export function fixed(units: number): Fixed {
  assertInteger(units, "Fixed units");
  return (units === 0 ? 0 : units) as Fixed;
}

/** Brands an integer count of basis points. */
export function ratio(basisPoints: number): Ratio {
  assertInteger(basisPoints, "Ratio units");
  return (basisPoints === 0 ? 0 : basisPoints) as Ratio;
}

/** A dollar value on the wire: a safe integer of units. */
export const fixedSchema = z
  .number()
  .int()
  .safe()
  .transform((units): Fixed => fixed(units));

/** A ratio on the wire: a safe integer of basis points. */
export const ratioSchema = z
  .number()
  .int()
  .safe()
  .transform((basisPoints): Ratio => ratio(basisPoints));

/** Positive whole shares. */
export const sharesSchema = z.number().int().positive();

/** Formats with exactly four places, e.g. "30.1234" or "-0.0500". For humans and logs, never for math. */
export function formatFixed(value: Fixed): string {
  const negative = value < 0;
  const magnitude = Math.abs(value);
  const whole = Math.floor(magnitude / SCALE);
  const fraction = magnitude % SCALE;
  return `${negative ? "-" : ""}${String(whole)}.${String(fraction).padStart(4, "0")}`;
}
