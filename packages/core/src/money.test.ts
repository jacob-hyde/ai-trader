import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MoneyError,
  ONE_DOLLAR,
  PENNY,
  SCALE,
  SUB_PENNY,
  ZERO,
  add,
  compare,
  divInt,
  divToCount,
  divToRatio,
  fixed,
  fromCents,
  fromNumber,
  midpoint,
  mulInt,
  mulRatio,
  neg,
  parseDecimal,
  ratio,
  roundToTick,
  spread,
  spreadBps,
  sub,
  tickSize,
  toCents,
  toCentsString,
  toDecimalString,
  wholeShares,
  type RoundingMode,
} from "./money.js";

const MODES: readonly RoundingMode[] = ["floor", "ceil", "trunc", "nearest"];

// Independent reference built on a floor primitive, formulated differently from the implementation so
// the property tests cross-check rather than mirror it.
function refDivide(n: bigint, d: bigint, mode: RoundingMode): bigint {
  const floorDiv = (x: bigint, y: bigint): bigint => {
    const q = x / y;
    return x % y !== 0n && x < 0n !== y < 0n ? q - 1n : q;
  };
  switch (mode) {
    case "floor":
      return floorDiv(n, d);
    case "ceil":
      return -floorDiv(-n, d);
    case "trunc":
      return n / d;
    case "nearest": {
      const an = n < 0n ? -n : n;
      const ad = d < 0n ? -d : d;
      const magnitude = floorDiv(2n * an + ad, 2n * ad);
      return n < 0n !== d < 0n ? -magnitude : magnitude;
    }
  }
}

const fixedArb = fc.integer({ min: -1_000_000_000_000, max: 1_000_000_000_000 }).map(fixed);
const ratioArb = fc.integer({ min: -1_000_000, max: 1_000_000 }).map(ratio);
const modeArb = fc.constantFrom(...MODES);
const nonZeroCount = fc.integer({ min: -1_000_000, max: 1_000_000 }).filter((n) => n !== 0);
const smallCount = fc.integer({ min: -1_000, max: 1_000 });
const digit = fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9");

describe("fixed / ratio constructors", () => {
  it("accepts safe integers and normalizes negative zero", () => {
    expect(fixed(1234)).toBe(1234);
    expect(Object.is(fixed(-0), 0)).toBe(true);
    expect(Object.is(ratio(-0), 0)).toBe(true);
  });

  it("rejects fractions, NaN, and values beyond the safe range", () => {
    expect(() => fixed(1.5)).toThrow(MoneyError);
    expect(() => fixed(Number.NaN)).toThrow(MoneyError);
    expect(() => fixed(Number.MAX_SAFE_INTEGER + 1)).toThrow(MoneyError);
    expect(() => ratio(0.5)).toThrow(MoneyError);
  });

  it("converts cents in both directions", () => {
    expect(fromCents(12345)).toBe(1_234_500);
    // $123.4567 is 12,345.67 cents.
    expect(toCents(fixed(1_234_567), "nearest")).toBe(12_346);
    expect(toCents(fixed(1_234_567), "floor")).toBe(12_345);
    expect(toCents(fixed(-1_234_567), "floor")).toBe(-12_346);
  });
});

describe("parseDecimal", () => {
  it("parses broker-style decimal strings exactly", () => {
    expect(parseDecimal("30")).toBe(300_000);
    expect(parseDecimal("30.1")).toBe(301_000);
    expect(parseDecimal("30.1234")).toBe(301_234);
    expect(parseDecimal("-0.5")).toBe(-5_000);
    expect(parseDecimal("0.0001")).toBe(1);
    expect(parseDecimal("007.10")).toBe(71_000);
    expect(parseDecimal("-0")).toBe(0);
    expect(Object.is(parseDecimal("-0.0000"), 0)).toBe(true);
  });

  it("rejects everything that is not a plain decimal", () => {
    for (const bad of ["", " 1", "1 ", "+1", "1.", ".5", "1e5", "abc", "NaN", "1,000", "0x10", "1..2"]) {
      expect(() => parseDecimal(bad), bad).toThrow(MoneyError);
    }
  });

  it("refuses more than four places unless a rounding mode is given", () => {
    expect(() => parseDecimal("1.00001")).toThrow(/more than four/);
    expect(parseDecimal("1.00005", "nearest")).toBe(10_001);
    expect(parseDecimal("1.00005", "floor")).toBe(10_000);
    expect(parseDecimal("-1.00005", "floor")).toBe(-10_001);
    expect(parseDecimal("-1.00005", "ceil")).toBe(-10_000);
    expect(parseDecimal("150.123456", "trunc")).toBe(1_501_234);
  });

  it("round-trips every Fixed through toDecimalString", () => {
    fc.assert(
      fc.property(fixedArb, (value) => {
        expect(parseDecimal(toDecimalString(value))).toBe(value);
      }),
    );
  });

  it("parses random decimal strings to the units the digits spell out", () => {
    const decimalArb = fc.tuple(
      fc.constantFrom("", "-"),
      fc.nat({ max: 999_999_999 }),
      fc.option(
        fc.array(digit, { minLength: 1, maxLength: 4 }).map((d) => d.join("")),
        { nil: undefined },
      ),
    );
    fc.assert(
      fc.property(decimalArb, ([sign, whole, fraction]) => {
        const text = `${sign}${whole}${fraction === undefined ? "" : `.${fraction}`}`;
        const expected = BigInt(whole) * 10_000n + BigInt((fraction ?? "").padEnd(4, "0"));
        expect(parseDecimal(text)).toBe(Number(sign === "-" ? -expected : expected));
      }),
    );
  });
});

describe("formatting", () => {
  it("prints four places and keeps the sign on small negatives", () => {
    expect(toDecimalString(fixed(301_234))).toBe("30.1234");
    expect(toDecimalString(fixed(-500))).toBe("-0.0500");
    expect(toDecimalString(ZERO)).toBe("0.0000");
    expect(toDecimalString(fixed(25_000_000))).toBe("2500.0000");
  });

  it("prints cents with the requested rounding", () => {
    expect(toCentsString(fixed(1_234_567), "nearest")).toBe("123.46");
    expect(toCentsString(fixed(1_234_567), "floor")).toBe("123.45");
    expect(toCentsString(fixed(-50), "floor")).toBe("-0.01");
    expect(toCentsString(fixed(-50), "ceil")).toBe("0.00");
  });

  it("builds Fixed from number literals without float drift", () => {
    expect(fromNumber(0.1)).toBe(1_000);
    expect(fromNumber(2500)).toBe(25_000_000);
    expect(fromNumber(19.6)).toBe(196_000);
    expect(() => fromNumber(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });
});

describe("addition and subtraction", () => {
  it("is exact and invertible", () => {
    fc.assert(
      fc.property(fixedArb, fixedArb, (a, b) => {
        expect(sub(add(a, b), b)).toBe(a);
        expect(add(a, b)).toBe(add(b, a));
        expect(add(a, neg(a))).toBe(0);
      }),
    );
  });

  it("refuses to overflow the safe range", () => {
    expect(() => add(fixed(Number.MAX_SAFE_INTEGER), fixed(1))).toThrow(MoneyError);
    expect(() => sub(fixed(-Number.MAX_SAFE_INTEGER), fixed(2))).toThrow(MoneyError);
  });

  it("orders values", () => {
    expect(compare(fixed(1), fixed(2))).toBe(-1);
    expect(compare(fixed(2), fixed(2))).toBe(0);
    expect(compare(fixed(3), fixed(2))).toBe(1);
  });
});

describe("rounding modes", () => {
  const cases: Array<[number, number, Record<RoundingMode, number>]> = [
    [7, 2, { floor: 3, ceil: 4, trunc: 3, nearest: 4 }],
    [-7, 2, { floor: -4, ceil: -3, trunc: -3, nearest: -4 }],
    [7, -2, { floor: -4, ceil: -3, trunc: -3, nearest: -4 }],
    [-7, -2, { floor: 3, ceil: 4, trunc: 3, nearest: 4 }],
    [5, 2, { floor: 2, ceil: 3, trunc: 2, nearest: 3 }],
    [-5, 2, { floor: -3, ceil: -2, trunc: -2, nearest: -3 }],
    [1, 3, { floor: 0, ceil: 1, trunc: 0, nearest: 0 }],
    [-1, 3, { floor: -1, ceil: 0, trunc: 0, nearest: 0 }],
    [6, 3, { floor: 2, ceil: 2, trunc: 2, nearest: 2 }],
  ];

  it("resolves every sign combination as documented", () => {
    for (const [n, d, expected] of cases) {
      for (const mode of MODES) {
        expect(divInt(fixed(n), d, mode), `${n}/${d} ${mode}`).toBe(expected[mode]);
      }
    }
  });

  it("rejects division by zero", () => {
    expect(() => divInt(fixed(1), 0, "floor")).toThrow(MoneyError);
    expect(() => divToCount(fixed(1), ZERO, "floor")).toThrow(MoneyError);
    expect(() => divToRatio(fixed(1), ZERO, "floor")).toThrow(MoneyError);
  });
});

describe("multiplication and division against a BigInt reference", () => {
  it("mulInt is exact", () => {
    fc.assert(
      fc.property(fixedArb, smallCount, (a, n) => {
        expect(mulInt(a, n)).toBe(Number(BigInt(a) * BigInt(n)));
      }),
    );
  });

  it("mulRatio matches the reference in every mode", () => {
    fc.assert(
      fc.property(fixedArb, ratioArb, modeArb, (a, r, mode) => {
        expect(mulRatio(a, r, mode)).toBe(Number(refDivide(BigInt(a) * BigInt(r), 10_000n, mode)));
      }),
    );
  });

  it("divInt matches the reference in every mode", () => {
    fc.assert(
      fc.property(fixedArb, nonZeroCount, modeArb, (a, n, mode) => {
        expect(divInt(a, n, mode)).toBe(Number(refDivide(BigInt(a), BigInt(n), mode)));
      }),
    );
  });

  it("divToRatio and divToCount match the reference in every mode", () => {
    const nonZeroFixed = fixedArb.filter((v) => v !== 0);
    fc.assert(
      fc.property(fixedArb, nonZeroFixed, modeArb, (a, b, mode) => {
        expect(divToRatio(a, b, mode)).toBe(Number(refDivide(BigInt(a) * 10_000n, BigInt(b), mode)));
        expect(divToCount(a, b, mode)).toBe(Number(refDivide(BigInt(a), BigInt(b), mode)));
      }),
    );
  });

  it("refuses products outside the safe range", () => {
    expect(() => mulInt(fixed(1_000_000_000_000), 100_000)).toThrow(MoneyError);
    expect(() => mulInt(fixed(1), 1.5)).toThrow(MoneyError);
  });

  it("reproduces the sizing worked example and the whole-share boundaries", () => {
    // $2,500 equity, 1% risk, entry $20.00, stop $19.60: 62.5 risk-based shares floor to 62.
    const riskDollars = mulRatio(fromNumber(2500), ratio(100), "floor");
    expect(riskDollars).toBe(fromNumber(25));
    const stopDistance = sub(fromNumber(20), fromNumber(19.6));
    expect(divToCount(riskDollars, stopDistance, "floor")).toBe(62);
    expect(divToCount(fixed(999), fixed(1_000), "floor")).toBe(0);
    expect(divToCount(fixed(1_000), fixed(1_000), "floor")).toBe(1);
  });
});

describe("wholeShares", () => {
  it("floors and rejects negatives and non-numbers", () => {
    expect(wholeShares(0.999)).toBe(0);
    expect(wholeShares(1)).toBe(1);
    expect(wholeShares(62.5)).toBe(62);
    expect(() => wholeShares(-1)).toThrow(MoneyError);
    expect(() => wholeShares(Number.NaN)).toThrow(MoneyError);
  });
});

describe("ticks", () => {
  it("switches from sub-penny to penny at exactly one dollar", () => {
    expect(tickSize(fixed(9_999))).toBe(SUB_PENNY);
    expect(tickSize(ONE_DOLLAR)).toBe(PENNY);
    expect(tickSize(fixed(10_001))).toBe(PENNY);
  });

  it("snaps prices to the tick with the requested mode and leaves sub-dollar prices alone", () => {
    const price = parseDecimal("1.0050");
    expect(roundToTick(price, "nearest")).toBe(parseDecimal("1.01"));
    expect(roundToTick(price, "floor")).toBe(parseDecimal("1.00"));
    expect(roundToTick(price, "ceil")).toBe(parseDecimal("1.01"));
    expect(roundToTick(parseDecimal("30.1234"), "trunc")).toBe(parseDecimal("30.12"));
    expect(roundToTick(parseDecimal("0.1234"), "nearest")).toBe(parseDecimal("0.1234"));
    expect(roundToTick(ONE_DOLLAR, "floor")).toBe(ONE_DOLLAR);
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }).map(fixed), modeArb, (price, mode) => {
        const once = roundToTick(price, mode);
        expect(roundToTick(once, mode)).toBe(once);
      }),
    );
  });
});

describe("spread", () => {
  it("measures width, midpoint, and basis points exactly", () => {
    const bid = parseDecimal("100.00");
    const ask = parseDecimal("100.02");
    expect(spread(bid, ask)).toBe(parseDecimal("0.02"));
    expect(midpoint(bid, ask, "nearest")).toBe(parseDecimal("100.01"));
    // 0.02 / 100.01 = 1.9998 bps
    expect(spreadBps(bid, ask, "nearest")).toBe(2);
    expect(spreadBps(bid, ask, "floor")).toBe(1);
    expect(spreadBps(bid, ask, "ceil")).toBe(2);
    expect(spreadBps(bid, bid, "nearest")).toBe(0);
  });

  it("rejects a crossed market and a non-positive midpoint", () => {
    expect(() => spread(parseDecimal("10"), parseDecimal("9.99"))).toThrow(MoneyError);
    expect(() => spreadBps(ZERO, ZERO, "nearest")).toThrow(MoneyError);
  });

  it("keeps a full-scale ratio equal to SCALE", () => {
    expect(divToRatio(fixed(50), fixed(50), "nearest")).toBe(SCALE);
  });
});
