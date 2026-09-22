import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Bar } from "./bars.js";
import { noCommission, type CostModelConfig } from "./costs.js";
import { fixed, fromNumber, ratio, type Fixed, type Ratio } from "./money.js";
import type { TradePlan } from "./setup.js";
import type { Direction } from "./sizing.js";
import { simulateTrade, type FilledTrade, type SimulationOptions } from "./tradeSim.js";

const usd = fromNumber;
const SESSION = "2026-01-05";

// Flat costs so every fill can be checked by hand. The synthetic quote sits a cent either side of the
// reference. A buy then pays 2 ticks more on a stop entry, 3 on a stop exit, and 1 otherwise, so:
//   buy  stop entry = ref + 0.03    sell stop exit = ref - 0.04    sell market = ref - 0.02
//   sell stop entry = ref - 0.03    buy  stop exit = ref + 0.04    buy  market = ref + 0.02
const COSTS: CostModelConfig = {
  spread: { bps: ratio(0), minTicks: 2 },
  slippage: {
    market: { bps: ratio(0), ticks: 1 },
    stopEntry: { bps: ratio(0), ticks: 2 },
    stopExit: { bps: ratio(0), ticks: 3 },
  },
  commission: noCommission,
};
const OPTIONS: SimulationOptions = { shares: 10, costModel: COSTS, lastEntryMinute: 360, flattenMinute: 380 };

function bar(
  minute: number,
  open: number,
  high: number,
  low: number,
  close: number,
  more: Partial<Bar> = {},
): Bar {
  return {
    session: SESSION,
    minuteOfSession: minute,
    open: usd(open),
    high: usd(high),
    low: usd(low),
    close: usd(close),
    volume: 10_000,
    vwap: null,
    closed: true,
    ...more,
  };
}

function plan(
  direction: Direction,
  entry: number,
  stop: number,
  target: number | null = null,
  breakevenAtR: Ratio | null = null,
): TradePlan {
  return {
    signal: {
      setupId: "orb",
      setupVersion: "1.0.0",
      symbol: "AAA",
      direction,
      session: SESSION,
      minuteOfSession: 4,
      entryType: "stop",
      entry: usd(entry),
      levels: {},
    },
    stop: usd(stop),
    target: target === null ? null : usd(target),
    management: { breakevenAtR },
  };
}

function filled(tradePlan: TradePlan, bars: readonly Bar[], options = OPTIONS): FilledTrade {
  const outcome = simulateTrade(tradePlan, bars, options);
  if (!outcome.filled) {
    throw new Error(`expected a fill, got ${outcome.reason}`);
  }
  return outcome;
}

// Long at 20.30 with a 20.15 stop: R is $0.15 a share.
const LONG = plan("long", 20.3, 20.15);
const QUIET = bar(5, 20.22, 20.28, 20.18, 20.25);
const BREAKOUT = bar(6, 20.25, 20.35, 20.24, 20.33);

describe("simulateTrade entries", () => {
  it("fills a stop entry on the first bar to reach the trigger, and runs to the flatten", () => {
    const bars = [QUIET, BREAKOUT, bar(7, 20.33, 20.9, 20.3, 20.85), bar(380, 21.5, 21.55, 21.4, 21.45)];
    expect(filled(LONG, bars)).toEqual({
      filled: true,
      shares: 10,
      riskPerShare: usd(0.15),
      entryMinute: 6,
      entryReference: usd(20.3),
      entryFill: usd(20.33),
      exitMinute: 380,
      exitReason: "eod",
      exitReference: usd(21.5),
      exitFill: usd(21.48),
      // $1.20 a share gross is exactly 8R. $1.15 net is 7.67R, floored.
      grossPnl: usd(12),
      netPnl: usd(11.5),
      grossR: 80_000,
      netR: 76_666,
    });
  });

  it("fills a gap through the trigger at the open, not at the trigger", () => {
    const trade = filled(LONG, [bar(6, 20.5, 20.6, 20.45, 20.55), bar(380, 20.55, 20.6, 20.5, 20.55)]);
    expect(trade.entryReference).toBe(usd(20.5));
    expect(trade.entryFill).toBe(usd(20.53));
    expect(trade.riskPerShare).toBe(usd(0.15));
  });

  it("never fills when price does not reach the trigger", () => {
    expect(simulateTrade(LONG, [QUIET, bar(6, 20.25, 20.29, 20.2, 20.22)], OPTIONS)).toEqual({
      filled: false,
      reason: "NEVER_TRIGGERED",
    });
    expect(simulateTrade(LONG, [], OPTIONS)).toEqual({ filled: false, reason: "NEVER_TRIGGERED" });
  });

  it("never fills at or after the last entry minute, or the flatten minute if that is earlier", () => {
    const late = [bar(360, 20.25, 20.4, 20.24, 20.35)];
    expect(simulateTrade(LONG, late, OPTIONS).filled).toBe(false);
    expect(simulateTrade(LONG, [bar(359, 20.25, 20.4, 20.24, 20.35)], OPTIONS).filled).toBe(true);
    const earlyFlatten = { ...OPTIONS, flattenMinute: 200 };
    expect(simulateTrade(LONG, [bar(200, 20.25, 20.4, 20.24, 20.35)], earlyFlatten).filled).toBe(false);
  });

  it("reads only closed, well-formed bars of its own session that come after the signal", () => {
    const ignored = [
      bar(3, 20.25, 20.5, 20.24, 20.4),
      bar(4, 20.25, 20.5, 20.24, 20.4),
      bar(5, 20.25, 20.5, 20.24, 20.4, { closed: false }),
      bar(5, 20.25, 20.5, 20.24, 20.4, { session: "2026-01-06" }),
      bar(5, 20.25, 20.5, 20.24, 20.4, { high: usd(20.2) }),
    ];
    expect(simulateTrade(LONG, ignored, OPTIONS)).toEqual({ filled: false, reason: "NEVER_TRIGGERED" });
    expect(filled(LONG, [...ignored, BREAKOUT]).entryMinute).toBe(6);
  });

  it("does not simulate entry types it has no model for, or a plan with no risk to measure in", () => {
    const limit = { ...LONG, signal: { ...LONG.signal, entryType: "limit" as const } };
    expect(simulateTrade(limit, [BREAKOUT], OPTIONS)).toEqual({
      filled: false,
      reason: "UNSUPPORTED_ENTRY_TYPE",
    });
    expect(simulateTrade(plan("long", 20.3, 20.3), [BREAKOUT], OPTIONS)).toEqual({
      filled: false,
      reason: "INVALID_PLAN",
    });
    expect(simulateTrade(plan("short", 19.7, 19.6), [BREAKOUT], OPTIONS)).toEqual({
      filled: false,
      reason: "INVALID_PLAN",
    });
  });
});

describe("simulateTrade stops", () => {
  it("stops out at the stop price when a later bar trades through it", () => {
    const trade = filled(LONG, [BREAKOUT, bar(7, 20.3, 20.32, 20.1, 20.12)]);
    expect(trade.exitReason).toBe("stop");
    expect(trade.exitReference).toBe(usd(20.15));
    expect(trade.exitFill).toBe(usd(20.11));
    expect(trade.grossR).toBe(-10_000);
    // Bought 20.33, sold 20.11: $0.22 lost on $0.15 of risk is -1.47R.
    expect(trade.netR).toBe(-14_667);
  });

  it("fills a gap through the stop at the open, which loses more than 1R", () => {
    const trade = filled(LONG, [BREAKOUT, bar(7, 19.9, 19.95, 19.8, 19.85)]);
    expect(trade.exitReference).toBe(usd(19.9));
    expect(trade.exitFill).toBe(usd(19.86));
    expect(trade.grossR).toBe(-26_667);
    expect(trade.netR).toBe(-31_334);
  });

  it("treats an entry bar that also reaches the stop as an entry and a loss", () => {
    const trade = filled(LONG, [bar(6, 20.25, 20.35, 20.1, 20.2)]);
    expect(trade.entryMinute).toBe(6);
    expect(trade.exitMinute).toBe(6);
    expect(trade.exitReason).toBe("stop");
    expect(trade.exitReference).toBe(usd(20.15));
  });

  it("does not read the entry bar's open as a gap through the stop", () => {
    // Opens under the stop, then rallies through the trigger. Still a stop-out, but at the stop.
    const trade = filled(LONG, [bar(6, 20.05, 20.35, 20.0, 20.3)]);
    expect(trade.exitReason).toBe("stop");
    expect(trade.exitReference).toBe(usd(20.15));
  });
});

describe("simulateTrade targets", () => {
  const WITH_TARGET = plan("long", 20.3, 20.15, 20.6);

  it("exits at the target, paying the market allowance", () => {
    const trade = filled(WITH_TARGET, [BREAKOUT, bar(8, 20.5, 20.65, 20.45, 20.6)]);
    expect(trade.exitReason).toBe("target");
    expect(trade.exitReference).toBe(usd(20.6));
    expect(trade.exitFill).toBe(usd(20.58));
    expect(trade.grossR).toBe(20_000);
    expect(trade.netR).toBe(16_666);
  });

  it("never fills a target better than its limit, even on a gap above it", () => {
    const trade = filled(WITH_TARGET, [BREAKOUT, bar(8, 20.8, 20.9, 20.75, 20.85)]);
    expect(trade.exitReference).toBe(usd(20.6));
  });

  it("takes the stop when one bar reaches both the stop and the target", () => {
    const trade = filled(WITH_TARGET, [BREAKOUT, bar(8, 20.3, 20.7, 20.1, 20.5)]);
    expect(trade.exitReason).toBe("stop");
  });

  it("can enter and hit the target in one bar when the stop is untouched", () => {
    const trade = filled(WITH_TARGET, [bar(6, 20.25, 20.65, 20.24, 20.6)]);
    expect([trade.entryMinute, trade.exitMinute, trade.exitReason]).toEqual([6, 6, "target"]);
  });
});

describe("simulateTrade breakeven", () => {
  // Breakeven at +1R is 20.45. Target at 4R is 20.90.
  const MANAGED = plan("long", 20.3, 20.15, 20.9, ratio(10_000));

  it("moves the stop to entry from the bar after price reaches the threshold", () => {
    const bars = [BREAKOUT, bar(7, 20.33, 20.5, 20.32, 20.48), bar(8, 20.4, 20.42, 20.28, 20.3)];
    const trade = filled(MANAGED, bars);
    expect(trade.exitReason).toBe("breakevenStop");
    expect(trade.exitReference).toBe(usd(20.3));
    expect(trade.grossR).toBe(0);
    // Bought 20.33, sold 20.26: breakeven still costs the round trip.
    expect(trade.netR).toBe(-4_667);
  });

  it("does not protect inside the bar that reaches the threshold", () => {
    // Minute 7 reaches 20.50 and dips to 20.20: above the original stop, so the trade survives it.
    const bars = [BREAKOUT, bar(7, 20.33, 20.5, 20.2, 20.45), bar(380, 20.7, 20.75, 20.65, 20.7)];
    const trade = filled(MANAGED, bars);
    expect(trade.exitReason).toBe("eod");
    expect(trade.exitMinute).toBe(380);
  });

  it("fills a gap through the breakeven stop at the open", () => {
    const bars = [BREAKOUT, bar(7, 20.33, 20.5, 20.32, 20.48), bar(8, 20.2, 20.25, 20.16, 20.2)];
    const trade = filled(MANAGED, bars);
    expect(trade.exitReason).toBe("breakevenStop");
    expect(trade.exitReference).toBe(usd(20.2));
  });

  it("leaves the stop alone when price never reaches the threshold", () => {
    const bars = [
      BREAKOUT,
      bar(7, 20.33, 20.44, 20.32, 20.4),
      bar(8, 20.4, 20.42, 20.28, 20.3),
      bar(9, 20.3, 20.31, 20.1, 20.12),
    ];
    const trade = filled(MANAGED, bars);
    expect(trade.exitReason).toBe("stop");
    expect(trade.exitMinute).toBe(9);
  });
});

describe("simulateTrade flatten", () => {
  it("flattens at the open of the first bar at or after the flatten minute", () => {
    const trade = filled(LONG, [
      BREAKOUT,
      bar(379, 20.8, 20.9, 20.7, 20.85),
      bar(382, 20.6, 20.7, 20.5, 20.55),
    ]);
    expect([trade.exitMinute, trade.exitReason]).toEqual([382, "eod"]);
    expect(trade.exitReference).toBe(usd(20.6));
  });

  it("flattens at the last close when the bars run out first", () => {
    const trade = filled(LONG, [BREAKOUT, bar(200, 20.8, 20.9, 20.7, 20.85)]);
    expect([trade.exitMinute, trade.exitReason]).toEqual([200, "eod"]);
    expect(trade.exitReference).toBe(usd(20.85));
    expect(filled(LONG, [BREAKOUT]).exitReference).toBe(usd(20.33));
  });
});

describe("simulateTrade shorts", () => {
  // Short at 19.70 with a 19.85 stop and a 19.40 target.
  const SHORT = plan("short", 19.7, 19.85, 19.4);
  const BREAKDOWN = bar(6, 19.75, 19.76, 19.65, 19.67);

  it("mirrors the entry, the target, and the costs", () => {
    const trade = filled(SHORT, [BREAKDOWN, bar(7, 19.6, 19.62, 19.35, 19.4)]);
    expect(trade.entryReference).toBe(usd(19.7));
    expect(trade.entryFill).toBe(usd(19.67));
    expect(trade.exitReason).toBe("target");
    expect(trade.exitFill).toBe(usd(19.42));
    expect(trade.grossR).toBe(20_000);
    expect(trade.netR).toBe(16_666);
  });

  it("mirrors the gaps: a lower open on entry and a higher open through the stop", () => {
    const trade = filled(SHORT, [bar(6, 19.6, 19.62, 19.55, 19.58), bar(7, 20.0, 20.05, 19.95, 20.0)]);
    expect(trade.entryReference).toBe(usd(19.6));
    expect(trade.exitReason).toBe("stop");
    expect(trade.exitReference).toBe(usd(20));
    expect(trade.exitFill).toBe(usd(20.04));
  });

  it("mirrors the move to breakeven", () => {
    // Breakeven at +1R is 19.55.
    const managed = plan("short", 19.7, 19.85, 19.1, ratio(10_000));
    const bars = [BREAKDOWN, bar(7, 19.66, 19.68, 19.5, 19.52), bar(8, 19.6, 19.72, 19.58, 19.7)];
    const trade = filled(managed, bars);
    expect(trade.exitReason).toBe("breakevenStop");
    expect(trade.exitReference).toBe(usd(19.7));
  });
});

describe("simulateTrade costs", () => {
  it("takes commissions out of net and leaves gross alone", () => {
    const charged: SimulationOptions = {
      ...OPTIONS,
      costModel: { ...COSTS, commission: ({ side }) => (side === "sell" ? usd(0.5) : usd(0)) },
    };
    const bars = [BREAKOUT, bar(380, 21.5, 21.55, 21.4, 21.45)];
    const free = filled(LONG, bars);
    const paid = filled(LONG, bars, charged);
    expect(paid.grossPnl).toBe(free.grossPnl);
    expect(paid.netPnl).toBe(free.netPnl - usd(0.5));
  });

  it("always nets less than gross, whatever the path", () => {
    const pathArb = fc.array(
      fc.record({
        open: fc.integer({ min: 1_950, max: 2_150 }),
        up: fc.integer({ min: 0, max: 60 }),
        down: fc.integer({ min: 0, max: 60 }),
        drift: fc.integer({ min: -30, max: 30 }),
      }),
      { minLength: 1, maxLength: 40 },
    );
    fc.assert(
      fc.property(
        pathArb,
        fc.constantFrom<Direction>("long", "short"),
        fc.boolean(),
        (path, direction, managed) => {
          const bars = path.map((step, i) => {
            const close = step.open + step.drift;
            const high = Math.max(step.open, close) + step.up;
            const low = Math.min(step.open, close) - step.down;
            return bar(5 + i, step.open / 100, high / 100, low / 100, close / 100);
          });
          const tradePlan =
            direction === "long"
              ? plan("long", 20.3, 20.15, 20.75, managed ? ratio(10_000) : null)
              : plan("short", 20.3, 20.45, 19.85, managed ? ratio(10_000) : null);
          const outcome = simulateTrade(tradePlan, bars, OPTIONS);
          if (outcome.filled) {
            expect(outcome.netPnl).toBeLessThan(outcome.grossPnl);
            expect(outcome.netR).toBeLessThan(outcome.grossR);
            expect(outcome.exitMinute).toBeGreaterThanOrEqual(outcome.entryMinute);
            // A target caps the gross win at its R, and nothing caps the loss: gaps go through stops.
            expect(outcome.grossR).toBeLessThanOrEqual(30_000);
          }
          expect(simulateTrade(tradePlan, bars, OPTIONS)).toEqual(outcome);
        },
      ),
    );
  });

  it("measures R with exact flooring", () => {
    // One share, one unit of price below entry at the flatten: a hair under zero gross.
    const tiny: SimulationOptions = { ...OPTIONS, shares: 1 };
    const trade = filled(LONG, [BREAKOUT, bar(380, 20.2999, 20.3, 20.29, 20.3)], tiny);
    expect(trade.grossPnl).toBe(fixed(-1) as Fixed);
    expect(trade.grossR).toBe(-7);
  });
});
