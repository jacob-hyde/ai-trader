import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Bar } from "./bars.js";
import { fromNumber, ratio, type Fixed } from "./money.js";
import { ORB_ID, ORB_VERSION, orbSetupDefinition } from "./orb.js";
import {
  SetupError,
  loadSetup,
  planTrade,
  type MarketState,
  type SetupSignal,
  type SymbolState,
} from "./setup.js";

const usd = fromNumber;
const SESSION = "2026-01-05";

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
    volume: 50_000,
    vwap: null,
    closed: true,
    ...more,
  };
}

// Bullish opening range: open 20.00, high 20.30, low 19.95, close 20.22.
const BULLISH: readonly Bar[] = [
  bar(0, 20.0, 20.1, 19.95, 20.05),
  bar(1, 20.05, 20.2, 20.0, 20.15),
  bar(2, 20.15, 20.3, 20.1, 20.25),
  bar(3, 20.25, 20.28, 20.12, 20.18),
  bar(4, 20.18, 20.26, 20.15, 20.22),
];
// Its mirror: open 20.00, high 20.05, low 19.70, close 19.78.
const BEARISH: readonly Bar[] = [
  bar(0, 20.0, 20.05, 19.9, 19.95),
  bar(1, 19.95, 20.0, 19.8, 19.85),
  bar(2, 19.85, 19.9, 19.7, 19.75),
  bar(3, 19.75, 19.88, 19.72, 19.82),
  bar(4, 19.82, 19.85, 19.74, 19.78),
];

const symbol: SymbolState = {
  symbol: "AAA",
  session: SESSION,
  minuteOfSession: 4,
  lastClose: usd(20.22),
  dailyAtr: usd(1.5),
  rsi: 61,
  sessionVwap: usd(20.12),
  openingRvol: ratio(25_000),
  runningRvol: ratio(25_000),
};
const market: MarketState = { session: SESSION, minuteOfSession: 5, closeMinute: 390, regime: null };

const orb = (params: Record<string, unknown> = {}) => loadSetup(orbSetupDefinition, params);

const LEVELS = { rangeOpen: usd(20), rangeHigh: usd(20.3), rangeLow: usd(19.95), rangeClose: usd(20.22) };
const LONG_SIGNAL: SetupSignal = {
  setupId: ORB_ID,
  setupVersion: ORB_VERSION,
  symbol: "AAA",
  direction: "long",
  session: SESSION,
  minuteOfSession: 4,
  entryType: "stop",
  entry: usd(20.3),
  levels: LEVELS,
};

describe("ORB parameters", () => {
  it("defaults to the published strategy", () => {
    expect(orb().params).toEqual({
      openingRangeMinutes: 5,
      minOpeningRvol: 10_000,
      minDailyAtr: usd(0.5),
      allowShort: false,
      stop: { kind: "atrFraction", fraction: 1_000 },
      exit: { kind: "eod" },
      entryWindowMinutes: null,
      lastEntryMinute: 360,
    });
  });

  it("declares its identity, both directions, and its warmup", () => {
    const setup = orb();
    expect([setup.id, setup.version]).toEqual(["orb", "1.0.0"]);
    expect(setup.directions).toEqual(["long", "short"]);
    expect(setup.warmup).toEqual({ dailyBars: 14, sessions: 14, sessionBars: 5 });
  });

  it("fails at load on out-of-bounds, misspelled, or inconsistent parameters", () => {
    const bad: readonly Record<string, unknown>[] = [
      { stop: { kind: "atrFraction", fraction: 0 } },
      { stop: { kind: "atrFraction", fraction: 1.5 } },
      { stop: { kind: "atrFraction", fraction: 0.1, fracton: 0.5 } },
      { stop: { kind: "openingRange", fraction: 0.1 } },
      { stop: { kind: "trailing" } },
      { exit: { kind: "fixedR" } },
      { exit: { kind: "fixedR", targetR: 0.1 } },
      { exit: { kind: "fixedR", targetR: 2, breakevenAtR: 2 } },
      { exit: { kind: "eod", targetR: 2 } },
      { openingRangeMinutes: 0 },
      { minOpeningRvol: -1 },
      { minDailyAtr: "0.50" },
      { lastEntryMinute: 391 },
      { entryWindowMinutes: 0 },
      { allowShorts: true },
    ];
    for (const params of bad) {
      expect(() => orb(params), JSON.stringify(params)).toThrow(SetupError);
    }
  });
});

describe("ORB golden cases: exact entry, stop, and target for each variant", () => {
  const atrStop = { kind: "atrFraction", fraction: 0.1 };
  const wideAtrStop = { kind: "atrFraction", fraction: 0.5 };
  const rangeStop = { kind: "openingRange" };
  const eod = { kind: "eod" };
  const fixed2R = { kind: "fixedR", targetR: 2, breakevenAtR: 1 };

  // Daily ATR is $1.50, so 10% is $0.15 and 50% is $0.75. The range is $0.35 tall.
  const cases = [
    { name: "published: 10% ATR stop, EOD exit", stop: atrStop, exit: eod, want: [20.3, 20.15, null, null] },
    { name: "10% ATR stop, 2R target", stop: atrStop, exit: fixed2R, want: [20.3, 20.15, 20.6, 10_000] },
    { name: "range-low stop, EOD exit", stop: rangeStop, exit: eod, want: [20.3, 19.95, null, null] },
    { name: "range-low stop, 2R target", stop: rangeStop, exit: fixed2R, want: [20.3, 19.95, 21.0, 10_000] },
    { name: "50% ATR stop, EOD exit", stop: wideAtrStop, exit: eod, want: [20.3, 19.55, null, null] },
    { name: "50% ATR stop, 2R target", stop: wideAtrStop, exit: fixed2R, want: [20.3, 19.55, 21.8, 10_000] },
  ] as const;

  for (const { name, stop, exit, want } of cases) {
    it(`long, ${name}`, () => {
      const setup = orb({ stop, exit });
      const signal = setup.detectTrigger(symbol, BULLISH, null);
      expect(signal).toEqual(LONG_SIGNAL);
      const plan = planTrade(setup, signal as SetupSignal, symbol);
      const [entry, stopPrice, target, breakevenAtR] = want;
      expect(plan.signal.entry).toBe(usd(entry));
      expect(plan.stop).toBe(usd(stopPrice));
      expect(plan.target).toBe(target === null ? null : usd(target));
      expect(plan.management).toEqual({ breakevenAtR });
    });
  }

  // The mirror: entry at the range low, stops above it, targets below it.
  const shortCases = [
    { name: "10% ATR stop, EOD exit", stop: atrStop, exit: eod, want: [19.7, 19.85, null] },
    { name: "10% ATR stop, 2R target", stop: atrStop, exit: fixed2R, want: [19.7, 19.85, 19.4] },
    { name: "range-high stop, EOD exit", stop: rangeStop, exit: eod, want: [19.7, 20.05, null] },
    { name: "range-high stop, 2R target", stop: rangeStop, exit: fixed2R, want: [19.7, 20.05, 19.0] },
  ] as const;

  for (const { name, stop, exit, want } of shortCases) {
    it(`short, ${name}`, () => {
      const setup = orb({ stop, exit, allowShort: true });
      const signal = setup.detectTrigger({ ...symbol, lastClose: usd(19.78) }, BEARISH, null) as SetupSignal;
      expect(signal.direction).toBe("short");
      expect(signal.levels).toEqual({
        rangeOpen: usd(20),
        rangeHigh: usd(20.05),
        rangeLow: usd(19.7),
        rangeClose: usd(19.78),
      });
      const plan = planTrade(setup, signal, symbol);
      const [entry, stopPrice, target] = want;
      expect(plan.signal.entry).toBe(usd(entry));
      expect(plan.stop).toBe(usd(stopPrice));
      expect(plan.target).toBe(target === null ? null : usd(target));
    });
  }

  it("rounds a fractional-R target to the nearest tick", () => {
    // 1.5R on a $0.15 stop is $0.225 above $20.30.
    const setup = orb({ exit: { kind: "fixedR", targetR: 1.5 } });
    const plan = planTrade(setup, LONG_SIGNAL, symbol);
    expect(plan.target).toBe(usd(20.53));
    expect(plan.management).toEqual({ breakevenAtR: null });
  });

  it("rounds an ATR stop to the nearest tick and never closer than one tick", () => {
    // 10% of $1.537 is $0.1537, so the stop sits $0.15 away once on the penny grid.
    expect(orb().stop(LONG_SIGNAL, { ...symbol, dailyAtr: usd(1.537) })).toBe(usd(20.15));
    // 10% of a $0.02 ATR is a fifth of a cent. The stop still sits a full tick away.
    const tiny = orb({ minDailyAtr: 0 });
    expect(tiny.stop(LONG_SIGNAL, { ...symbol, dailyAtr: usd(0.02) })).toBe(usd(20.29));
  });
});

describe("ORB cases that must not signal", () => {
  it("skips a doji", () => {
    const doji = [...BULLISH.slice(0, 4), bar(4, 20.18, 20.26, 19.98, 20.0)];
    expect(orb().detectTrigger(symbol, doji, null)).toBeNull();
  });

  it("skips relative volume at or below the gate, and unknown relative volume", () => {
    const setup = orb();
    expect(setup.detectTrigger({ ...symbol, openingRvol: ratio(10_000) }, BULLISH, null)).toBeNull();
    expect(setup.detectTrigger({ ...symbol, openingRvol: ratio(9_000) }, BULLISH, null)).toBeNull();
    expect(setup.detectTrigger({ ...symbol, openingRvol: null }, BULLISH, null)).toBeNull();
    expect(setup.detectTrigger({ ...symbol, openingRvol: ratio(10_001) }, BULLISH, null)).not.toBeNull();
  });

  it("skips an ATR at or below the floor, and an ATR that is not warm", () => {
    const setup = orb();
    expect(setup.detectTrigger({ ...symbol, dailyAtr: usd(0.5) }, BULLISH, null)).toBeNull();
    expect(setup.detectTrigger({ ...symbol, dailyAtr: null }, BULLISH, null)).toBeNull();
    expect(setup.detectTrigger({ ...symbol, dailyAtr: usd(0.51) }, BULLISH, null)).not.toBeNull();
  });

  it("skips a bearish range unless shorts are allowed", () => {
    expect(orb().detectTrigger(symbol, BEARISH, null)).toBeNull();
    expect(orb({ allowShort: true }).detectTrigger(symbol, BEARISH, null)).not.toBeNull();
  });

  it("needs the range to have closed: no signal from the first four minutes", () => {
    const setup = orb();
    for (let count = 0; count < 5; count += 1) {
      expect(setup.detectTrigger(symbol, BULLISH.slice(0, count), null), `${count} bars`).toBeNull();
    }
  });

  it("does not count a last range bar that is still forming", () => {
    const forming = [...BULLISH.slice(0, 4), { ...(BULLISH[4] as Bar), closed: false }];
    expect(orb().detectTrigger(symbol, forming, null)).toBeNull();
  });

  it("skips a session with no bar inside the range", () => {
    expect(orb().detectTrigger(symbol, [bar(7, 20.1, 20.2, 20.0, 20.15)], null)).toBeNull();
  });

  it("refuses to chase once price has traded through the entry after the range", () => {
    const setup = orb();
    const through = [...BULLISH, bar(5, 20.22, 20.3, 20.2, 20.28)];
    const below = [...BULLISH, bar(5, 20.22, 20.29, 20.2, 20.28)];
    expect(setup.detectTrigger(symbol, through, null)).toBeNull();
    expect(setup.detectTrigger(symbol, below, null)).toEqual(LONG_SIGNAL);

    const short = orb({ allowShort: true });
    expect(short.detectTrigger(symbol, [...BEARISH, bar(5, 19.78, 19.8, 19.7, 19.75)], null)).toBeNull();
    expect(short.detectTrigger(symbol, [...BEARISH, bar(5, 19.78, 19.8, 19.71, 19.75)], null)).not.toBeNull();
  });
});

describe("ORB range construction", () => {
  it("closes the range on the first bar past it when the last range minute has no bar", () => {
    const gapped = [...BULLISH.slice(0, 4), bar(6, 20.18, 20.25, 20.1, 20.2)];
    const signal = orb().detectTrigger(symbol, gapped, null) as SetupSignal;
    expect(signal.minuteOfSession).toBe(6);
    expect(signal.entry).toBe(usd(20.3));
    expect(signal.levels["rangeClose"]).toBe(usd(20.18));
  });

  it("ignores bars from any other session", () => {
    const yesterday = bar(200, 30, 45, 29, 44, { session: "2026-01-02" });
    expect(orb().detectTrigger(symbol, [yesterday, ...BULLISH], null)).toEqual(LONG_SIGNAL);
  });

  it("honors a different range length", () => {
    const signal = orb({ openingRangeMinutes: 3 }).detectTrigger(symbol, BULLISH.slice(0, 3), null);
    expect(signal?.entry).toBe(usd(20.3));
    expect(signal?.minuteOfSession).toBe(2);
    expect(signal?.levels["rangeClose"]).toBe(usd(20.25));
  });

  it("ignores the quote", () => {
    const quote = { bid: usd(25), ask: usd(25.1) };
    expect(orb().detectTrigger(symbol, BULLISH, quote)).toEqual(LONG_SIGNAL);
  });
});

describe("ORB no look-ahead", () => {
  const laterBarArb = fc
    .record({
      base: fc.integer({ min: 1_900, max: 2_100 }),
      up: fc.integer({ min: 0, max: 40 }),
      down: fc.integer({ min: 0, max: 40 }),
    })
    .map(({ base, up, down }) => ({ open: base / 100, high: (base + up) / 100, low: (base - down) / 100 }));

  it("gives the same signal whatever comes after the range, until price trades through the entry", () => {
    fc.assert(
      fc.property(fc.array(laterBarArb, { maxLength: 20 }), (later) => {
        const after = later.map((b, i) => bar(5 + i, b.open, b.high, b.low, b.open));
        const through = after.some((b) => b.high >= usd(20.3));
        const signal = orb().detectTrigger(symbol, [...BULLISH, ...after], null);
        expect(signal).toEqual(through ? null : LONG_SIGNAL);
      }),
    );
  });
});

describe("ORB evaluateContext", () => {
  const setup = orb();

  it("applies to a warm, high relative-volume name once the range has closed", () => {
    expect(setup.evaluateContext(symbol, market)).toEqual({ applies: true });
  });

  it("names every reason it does not apply", () => {
    const reasonsFor = (state: Partial<SymbolState>, clock: Partial<MarketState> = {}) => {
      const verdict = setup.evaluateContext({ ...symbol, ...state }, { ...market, ...clock });
      return verdict.applies ? [] : verdict.reasons;
    };
    expect(reasonsFor({ openingRvol: null })).toEqual(["ORB_RVOL_NOT_WARM"]);
    expect(reasonsFor({ openingRvol: ratio(10_000) })).toEqual(["ORB_RVOL_BELOW_MIN"]);
    expect(reasonsFor({ dailyAtr: null })).toEqual(["ORB_ATR_NOT_WARM"]);
    expect(reasonsFor({ dailyAtr: usd(0.5) })).toEqual(["ORB_ATR_BELOW_MIN"]);
    expect(reasonsFor({ minuteOfSession: 3 })).toEqual(["ORB_RANGE_NOT_CLOSED"]);
    expect(reasonsFor({}, { minuteOfSession: 360 })).toEqual(["ORB_SESSION_GATE_CLOSED"]);
    expect(reasonsFor({}, { minuteOfSession: 359 })).toEqual([]);
    expect(
      reasonsFor({ openingRvol: null, dailyAtr: null, minuteOfSession: 0 }, { minuteOfSession: 380 }),
    ).toEqual(["ORB_RVOL_NOT_WARM", "ORB_ATR_NOT_WARM", "ORB_RANGE_NOT_CLOSED", "ORB_SESSION_GATE_CLOSED"]);
  });

  it("closes the session gate at the close on a half day", () => {
    const halfDay = { ...market, closeMinute: 210 };
    expect(setup.evaluateContext(symbol, { ...halfDay, minuteOfSession: 209 })).toEqual({ applies: true });
    expect(setup.evaluateContext(symbol, { ...halfDay, minuteOfSession: 210 })).toEqual({
      applies: false,
      reasons: ["ORB_SESSION_GATE_CLOSED"],
    });
  });
});

describe("ORB invalidation", () => {
  const at = (minuteOfSession: number, lastClose: number, more: Partial<SymbolState> = {}): SymbolState => ({
    ...symbol,
    minuteOfSession,
    lastClose: usd(lastClose),
    ...more,
  });
  const SHORT_SIGNAL: SetupSignal = { ...LONG_SIGNAL, direction: "short", entry: usd(19.7) };

  it("keeps the published entry working all day, until the session gate", () => {
    const setup = orb();
    expect(setup.invalidation(LONG_SIGNAL, at(200, 20.0))).toBe(false);
    expect(setup.invalidation(LONG_SIGNAL, at(359, 20.0))).toBe(false);
    expect(setup.invalidation(LONG_SIGNAL, at(360, 20.0))).toBe(true);
  });

  it("drops a signal from another session", () => {
    expect(orb().invalidation(LONG_SIGNAL, at(10, 20.0, { session: "2026-01-06" }))).toBe(true);
  });

  it("cancels after the entry window when price is back inside the range", () => {
    const setup = orb({ entryWindowMinutes: 30 });
    expect(setup.invalidation(LONG_SIGNAL, at(34, 20.1))).toBe(false);
    expect(setup.invalidation(LONG_SIGNAL, at(35, 20.1))).toBe(true);
    // Still pressing the level: a fill is imminent, so the order stays.
    expect(setup.invalidation(LONG_SIGNAL, at(35, 20.3))).toBe(false);
  });

  it("mirrors the window rule for a short", () => {
    const setup = orb({ entryWindowMinutes: 30, allowShort: true });
    expect(setup.invalidation(SHORT_SIGNAL, at(35, 19.9))).toBe(true);
    expect(setup.invalidation(SHORT_SIGNAL, at(35, 19.7))).toBe(false);
  });
});

describe("ORB contract edges", () => {
  it("throws when asked for a range stop on a signal that carries no levels", () => {
    const setup = orb({ stop: { kind: "openingRange" } });
    expect(() => setup.stop({ ...LONG_SIGNAL, levels: {} }, symbol)).toThrow(SetupError);
    expect(() => setup.stop({ ...LONG_SIGNAL, direction: "short", levels: {} }, symbol)).toThrow(SetupError);
  });

  it("throws when asked for an ATR stop without a warm ATR", () => {
    expect(() => orb().stop(LONG_SIGNAL, { ...symbol, dailyAtr: null })).toThrow(SetupError);
    expect(() => orb().target(LONG_SIGNAL, { ...symbol, dailyAtr: null as Fixed | null })).toThrow(
      SetupError,
    );
  });
});
