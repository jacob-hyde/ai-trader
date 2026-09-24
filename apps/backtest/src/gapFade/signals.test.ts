import type { AlpacaBar } from "@trader/adapters/alpaca";
import type { Fixed } from "@trader/contracts";
import { describe, expect, it } from "vitest";
import { gapOf, lastPremarket } from "./signals.js";

const bar = (t: string, c: number, v: number): AlpacaBar =>
  ({ t, o: c, h: c, l: c, c, v, n: 1, vw: c }) as AlpacaBar;

describe("the pre-market price by 09:25", () => {
  // 09:25 New York on a winter day is 14:25Z.
  const cutoff = Date.parse("2019-01-15T14:25:00Z");
  const bars = [
    bar("2019-01-15T09:00:00Z", 20.1, 100),
    bar("2019-01-15T14:15:00Z", 20.4, 300),
    // Closes at 14:25 exactly: the last one known by then.
    bar("2019-01-15T14:20:00Z", 20.5, 200),
    // Closes at 14:30, after the cutoff.
    bar("2019-01-15T14:25:00Z", 21, 900),
  ];

  it("is the close of the last bar that ended by the cutoff, with the volume up to it", () => {
    expect(lastPremarket(bars, cutoff)).toEqual({
      price: 205_000,
      volume: 600,
      asOf: Date.parse("2019-01-15T14:25:00Z"),
    });
  });

  it("is nothing without a pre-market trade by then", () => {
    expect(lastPremarket([], cutoff)).toBeNull();
    expect(lastPremarket(bars.slice(3), cutoff)).toBeNull();
  });

  it("gaps as a fraction of the prior close", () => {
    expect(gapOf(200_000 as Fixed, 206_000 as Fixed)).toBeCloseTo(0.03, 12);
    expect(gapOf(200_000 as Fixed, 190_000 as Fixed)).toBeCloseTo(-0.05, 12);
  });
});
