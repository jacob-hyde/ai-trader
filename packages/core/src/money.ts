/**
 * Fixed-point money and price arithmetic for the decision core.
 *
 * Every dollar value is an integer count of $0.0001 (four decimal places) carried in a plain number, so
 * it serializes, compares, and sorts like a number. Four places rather than two because Alpaca reports
 * sub-penny average fills and the live-vs-modeled slippage measurement needs them intact.
 *
 * Products and quotients run through BigInt so no intermediate loses precision, and every result is
 * checked to be a safe integer. Anything that can lose precision takes an explicit rounding mode.
 * Nothing in this module rounds implicitly.
 *
 * Ratios (percentages, spreads, risk fractions) are a separate brand at the same scale, which makes one
 * unit exactly one basis point.
 */

/** Dollar amount or price in units of $0.0001. Always a safe integer. */
export type Fixed = number & { readonly __brand: "Fixed" };

/** Dimensionless ratio in basis points: 1 is 0.01%, 10 000 is 100%. Always a safe integer. */
export type Ratio = number & { readonly __brand: "Ratio" };

/** How a lossy division resolves. "nearest" is half away from zero: 2.5 becomes 3 and -2.5 becomes -3. */
export type RoundingMode = "floor" | "ceil" | "trunc" | "nearest";

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
const SCALE_BIG = 10_000n;
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIG = -MAX_SAFE_BIG;

export const ZERO = 0 as Fixed;
export const ONE_DOLLAR = SCALE as Fixed;
export const PENNY = 100 as Fixed;
export const SUB_PENNY = 1 as Fixed;
export const ONE_HUNDRED_PERCENT = SCALE as Ratio;

function assertInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError("NOT_INTEGER", `${what} must be a safe integer, got ${String(value)}`);
  }
}

function toSafeNumber(value: bigint, what: string): number {
  if (value > MAX_SAFE_BIG || value < MIN_SAFE_BIG) {
    throw new MoneyError("OUT_OF_RANGE", `${what} is outside the safe integer range`);
  }
  return Number(value);
}

/**
 * Integer division with an explicit rounding mode, exact for every sign combination.
 *
 * BigInt division truncates toward zero. The remainder's sign decides the adjustment for the other
 * modes, so floor and ceil are correct for negative operands too.
 */
function divide(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw new MoneyError("DIVIDE_BY_ZERO", "division by zero");
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) {
    return quotient;
  }
  const negative = numerator < 0n !== denominator < 0n;
  switch (mode) {
    case "trunc":
      return quotient;
    case "floor":
      return negative ? quotient - 1n : quotient;
    case "ceil":
      return negative ? quotient : quotient + 1n;
    case "nearest": {
      const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
      const absDenominator = denominator < 0n ? -denominator : denominator;
      if (twiceRemainder < absDenominator) {
        return quotient;
      }
      return negative ? quotient - 1n : quotient + 1n;
    }
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

export function fromCents(cents: number): Fixed {
  assertInteger(cents, "cents");
  return fixed(cents * 100);
}

export function toCents(value: Fixed, mode: RoundingMode): number {
  return toSafeNumber(divide(BigInt(value), 100n, mode), "cents");
}

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Parses a decimal string, the form every broker field arrives in.
 *
 * Strict by default: more than four decimal places is an error, because a silently rounded fill price
 * would corrupt the slippage measurement. Pass a rounding mode to accept longer inputs deliberately.
 * Rejects exponents, whitespace, a sign other than a leading minus, and a bare leading or trailing dot.
 */
export function parseDecimal(input: string, rounding?: RoundingMode): Fixed {
  if (!DECIMAL_PATTERN.test(input)) {
    throw new MoneyError("PARSE", `not a decimal string: ${JSON.stringify(input)}`);
  }
  const negative = input.startsWith("-");
  const body = negative ? input.slice(1) : input;
  const dot = body.indexOf(".");
  const whole = dot === -1 ? body : body.slice(0, dot);
  const fraction = dot === -1 ? "" : body.slice(dot + 1);
  const digits = BigInt(whole + fraction);
  const signed = negative ? -digits : digits;
  let units: bigint;
  if (fraction.length <= 4) {
    units = signed * 10n ** BigInt(4 - fraction.length);
  } else {
    if (rounding === undefined) {
      throw new MoneyError("PARSE", `more than four decimal places: ${input}`);
    }
    units = divide(signed, 10n ** BigInt(fraction.length - 4), rounding);
  }
  return fixed(toSafeNumber(units, "parsed value"));
}

/** Formats with exactly four places, e.g. "30.1234" or "-0.0500". Round-trips through parseDecimal. */
export function toDecimalString(value: Fixed): string {
  const negative = value < 0;
  const magnitude = BigInt(negative ? -value : value);
  const whole = magnitude / SCALE_BIG;
  const fraction = magnitude % SCALE_BIG;
  return `${negative ? "-" : ""}${whole}.${fraction.toString().padStart(4, "0")}`;
}

/** Formats to whole cents with explicit rounding, for display and for two-place broker fields. */
export function toCentsString(value: Fixed, mode: RoundingMode): string {
  const cents = divide(BigInt(value), 100n, mode);
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  return `${negative ? "-" : ""}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, "0")}`;
}

/**
 * Converts a JS number of dollars, for config literals and tests only.
 *
 * Goes through the decimal string so 0.1 becomes exactly 1000 units instead of trusting float math.
 * Production values arrive as strings and must use parseDecimal.
 */
export function fromNumber(dollars: number): Fixed {
  if (!Number.isFinite(dollars)) {
    throw new MoneyError("PARSE", `not a finite number: ${String(dollars)}`);
  }
  return parseDecimal(dollars.toFixed(4));
}

export function add(a: Fixed, b: Fixed): Fixed {
  return fixed(a + b);
}

export function sub(a: Fixed, b: Fixed): Fixed {
  return fixed(a - b);
}

export function neg(a: Fixed): Fixed {
  return fixed(-a);
}

export function abs(a: Fixed): Fixed {
  return fixed(Math.abs(a));
}

export function compare(a: Fixed, b: Fixed): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function min(a: Fixed, b: Fixed): Fixed {
  return a < b ? a : b;
}

export function max(a: Fixed, b: Fixed): Fixed {
  return a > b ? a : b;
}

/** Exact: a dollar amount times a whole count, e.g. price times shares. */
export function mulInt(a: Fixed, count: number): Fixed {
  assertInteger(count, "count");
  return fixed(toSafeNumber(BigInt(a) * BigInt(count), "product"));
}

/** A dollar amount times a ratio, e.g. equity times risk per trade. Lossy, so the mode is required. */
export function mulRatio(a: Fixed, r: Ratio, mode: RoundingMode): Fixed {
  return fixed(toSafeNumber(divide(BigInt(a) * BigInt(r), SCALE_BIG, mode), "product"));
}

/** A dollar amount divided by a whole count, e.g. a total split per share. */
export function divInt(a: Fixed, count: number, mode: RoundingMode): Fixed {
  assertInteger(count, "count");
  return fixed(toSafeNumber(divide(BigInt(a), BigInt(count), mode), "quotient"));
}

/** One dollar amount as a ratio of another, in basis points, e.g. risk dollars over equity. */
export function divToRatio(numerator: Fixed, denominator: Fixed, mode: RoundingMode): Ratio {
  return ratio(toSafeNumber(divide(BigInt(numerator) * SCALE_BIG, BigInt(denominator), mode), "ratio"));
}

/**
 * One dollar amount divided by another as a whole count, e.g. risk dollars over stop distance gives
 * shares. Floor is the mode sizing wants: never round up into a bigger position.
 */
export function divToCount(numerator: Fixed, denominator: Fixed, mode: RoundingMode): number {
  return toSafeNumber(divide(BigInt(numerator), BigInt(denominator), mode), "count");
}

/** Floors a non-negative share quantity that may have arrived as a float from config or a broker field. */
export function wholeShares(quantity: number): number {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new MoneyError(
      "NEGATIVE_QUANTITY",
      `share quantity must be a non-negative number, got ${String(quantity)}`,
    );
  }
  const shares = Math.floor(quantity);
  assertInteger(shares, "share quantity");
  return shares;
}

/** Minimum price increment under Reg NMS Rule 612: a penny at or above $1.00, $0.0001 below it. */
export function tickSize(price: Fixed): Fixed {
  return price >= ONE_DOLLAR ? PENNY : SUB_PENNY;
}

/** Snaps a price to its tick. Sub-dollar prices are already on the grid and pass through unchanged. */
export function roundToTick(price: Fixed, mode: RoundingMode): Fixed {
  const tick = tickSize(price);
  if (tick === SUB_PENNY) {
    return price;
  }
  const ticks = divide(BigInt(price), BigInt(tick), mode);
  return fixed(toSafeNumber(ticks * BigInt(tick), "tick-rounded price"));
}

/** Ask minus bid. A crossed market (ask below bid) is an error rather than a negative spread. */
export function spread(bid: Fixed, ask: Fixed): Fixed {
  if (ask < bid) {
    throw new MoneyError(
      "CROSSED_MARKET",
      `ask ${toDecimalString(ask)} is below bid ${toDecimalString(bid)}`,
    );
  }
  return sub(ask, bid);
}

export function midpoint(bid: Fixed, ask: Fixed, mode: RoundingMode): Fixed {
  spread(bid, ask);
  return divInt(add(bid, ask), 2, mode);
}

/** Spread as basis points of the midpoint, computed exactly as 2 * spread / (bid + ask). */
export function spreadBps(bid: Fixed, ask: Fixed, mode: RoundingMode): Ratio {
  const width = spread(bid, ask);
  const twiceMid = BigInt(bid) + BigInt(ask);
  if (twiceMid <= 0n) {
    throw new MoneyError("OUT_OF_RANGE", "spread in basis points needs a positive midpoint");
  }
  return ratio(toSafeNumber(divide(BigInt(width) * SCALE_BIG * 2n, twiceMid, mode), "spread bps"));
}
