import { describe, expect, it } from "vitest";
import badTickBars from "./__fixtures__/orb/bad-tick-before-trigger.bars.csv?raw";
import {
  type BadTickConfig,
  BadTickError,
  BadTickFilter,
  DEFAULT_BAD_TICK_CONFIG,
  DEFAULT_MAX_CUTS_PER_SESSION,
  assertBadTickConfig,
  countCuts,
  isSanePrint,
  isSaneQuote,
} from "./badTicks.js";
import type { Bar } from "./bars.js";
import { DEFAULT_COST_MODEL } from "./costs.js";
import { type Fixed, fixed, mulInt, parseDecimal, ratio } from "./money.js";
import { orbSetupDefinition } from "./orb.js";
import { DEFAULT_PATH_CONFIG, type Scenario, generatePath } from "./paths.js";
import { type SetupSignal, type SymbolState, loadSetup, planTrade } from "./setup.js";
import { simulateTrade } from "./tradeSim.js";

const SESSION = "2026-01-05";
/** The arithmetic below is worked by hand at 10%. The defaults are checked on their own further down. */
const TEN: BadTickConfig = { ...DEFAULT_BAD_TICK_CONFIG, maxExcursion: ratio(1_000) };
const px = (dollars: number): Fixed => fixed(Math.round(dollars * 10_000));

function bar(minute: number, o: number, h: number, l: number, c: number, session = SESSION): Bar {
  return {
    session,
    minuteOfSession: minute,
    open: px(o),
    high: px(h),
    low: px(l),
    close: px(c),
    volume: 1_000,
    vwap: null,
    closed: true,
  };
}

/** Feeds a filter every bar and returns what came out. */
function run(bars: readonly Bar[], filter = new BadTickFilter(TEN)) {
  return bars.map((b) => filter.filter(b));
}

describe("the bar filter", () => {
  it("passes clean bars through untouched", () => {
    const bars = [
      bar(0, 20, 20.1, 19.95, 20.05),
      bar(1, 20.05, 20.2, 20, 20.15),
      bar(2, 20.15, 20.3, 20.1, 20.25),
    ];
    const out = run(bars);
    expect(out.map((o) => o.bar)).toEqual(bars);
    expect(out.every((o, i) => o.bar === bars[i] && o.clipped.length === 0)).toBe(true);
  });

  it("cuts a high past both the body and the last close back to the body", () => {
    const [, spike] = run([bar(0, 20, 20.05, 19.95, 20), bar(1, 20, 25, 19.95, 20.05)]);
    // 10% past the higher of the close (20.05) and the last close (20.00) is 22.055.
    expect(spike?.clipped).toEqual([{ side: "high", reported: px(25), kept: px(20.05), limit: px(22.055) }]);
    expect(spike?.bar).toEqual(bar(1, 20, 20.05, 19.95, 20.05));
  });

  it("cuts a low past both the body and the last close back to the body, and both sides of one bar", () => {
    const [, low, both] = run([
      bar(0, 20, 20.05, 19.95, 20),
      bar(1, 20, 20.05, 15, 19.98),
      bar(2, 19.98, 30, 10, 20),
    ]);
    // 10% under the lower of the body's bottom (19.98) and the last close (20.00) is 17.982.
    expect(low?.clipped).toEqual([{ side: "low", reported: px(15), kept: px(19.98), limit: px(17.982) }]);
    expect(low?.bar.low).toBe(px(19.98));
    expect(both?.clipped.map((c) => [c.side, c.kept])).toEqual([
      ["high", px(20)],
      ["low", px(19.98)],
    ]);
    expect([both?.bar.high, both?.bar.low]).toEqual([px(20), px(19.98)]);
  });

  it("lets a real move through: a gap, a halt reopening, a bar whose body travels", () => {
    const bars = [
      bar(0, 20, 20.05, 19.95, 20),
      // Opens 15% higher after a halt, and trades 2% above its body.
      bar(12, 23, 23.46, 22.9, 23.3),
      // Falls 12% inside one minute, open to close.
      bar(13, 23.3, 23.35, 20.4, 20.5),
    ];
    const out = run(bars);
    expect(out.map((o) => o.clipped)).toEqual([[], [], []]);
    expect(out.map((o) => o.bar)).toEqual(bars);
  });

  it("judges a session's first bar on its body alone, and starts each session afresh", () => {
    const filter = new BadTickFilter(TEN);
    // 10% past the body's top (20.10) is 22.11.
    expect(filter.filter(bar(0, 20, 22.1, 19.95, 20.1)).clipped).toEqual([]);
    expect(filter.lastClose).toBe(px(20.1));
    const next = new BadTickFilter(TEN);
    expect(next.filter(bar(0, 20, 22.2, 19.95, 20.1)).clipped).toEqual([
      { side: "high", reported: px(22.2), kept: px(20.1), limit: px(22.11) },
    ]);
    // An overnight gap of 50% is not a move to judge.
    expect(filter.filter(bar(0, 30, 30.5, 29.9, 30.2, "2026-01-06")).clipped).toEqual([]);
    expect(filter.lastClose).toBe(px(30.2));
    expect(filter.averageRange).toBeNull();
  });

  it("judges a name against its own pace once it has enough bars, and a spike never widens that pace", () => {
    const volatile = new BadTickFilter(TEN);
    const quiet = new BadTickFilter(TEN);
    for (let m = 0; m < 30; m += 1) {
      volatile.filter(bar(m, 20, 20.5, 19.5, 20));
      quiet.filter(bar(m, 20, 20.01, 19.99, 20));
    }
    expect([volatile.averageRange, quiet.averageRange]).toEqual([px(1), px(0.02)]);
    // Ten dollar-wide minutes allow $10 past $20, so a wick to $30.50 is cut.
    expect(volatile.filter(bar(30, 20, 30.5, 19.9, 20)).clipped[0]?.limit).toBe(px(30));
    // The cut bar counts at its clean range, a dime, never at the spike's: 29 dollars and a dime over 30.
    expect(volatile.averageRange).toBe(px(0.97));
    // So the pace allows $9.70, and a wick to $29 is still its own.
    expect(volatile.filter(bar(31, 20, 29, 19.9, 20)).clipped).toEqual([]);
    // Two cents a minute allows 20 cents, less than 10%, so 10% governs.
    expect(quiet.filter(bar(30, 20, 21.9, 19.99, 20)).clipped).toEqual([]);
    expect(quiet.filter(bar(31, 20, 22.1, 19.99, 20)).clipped[0]?.limit).toBe(px(22));
  });

  it("uses the percentage alone when the range multiple is turned off", () => {
    const filter = new BadTickFilter({ ...TEN, maxExcursionRanges: 0, rangeBars: 1 });
    filter.filter(bar(0, 20, 21, 19, 20));
    expect(filter.averageRange).toBe(px(2));
    expect(filter.filter(bar(1, 20, 22.5, 19.9, 20)).clipped[0]?.limit).toBe(px(22));
  });

  it("refuses a config outside its bounds, naming every problem", () => {
    expect(() => assertBadTickConfig(DEFAULT_BAD_TICK_CONFIG)).not.toThrow();
    expect(
      () => new BadTickFilter({ maxExcursion: ratio(50), maxExcursionRanges: 1.5, rangeBars: 0 }),
    ).toThrow(BadTickError);
    expect(() =>
      assertBadTickConfig({ maxExcursion: ratio(50), maxExcursionRanges: 1.5, rangeBars: 0 }),
    ).toThrow(/maxExcursion must .*; maxExcursionRanges must .*; rangeBars must/);
  });
});

describe("a session's cuts", () => {
  it("counts every high and low cut across a symbol's day, so a corrupted day can be left out whole", () => {
    // A day trading at two levels: every other bar prints the phantom one.
    const corrupted = Array.from({ length: 12 }, (_, m) =>
      m % 2 === 0 ? bar(m, 47, 47.1, 46.9, 47) : bar(m, 47, 63.6, 46.9, 47),
    );
    expect(countCuts(corrupted)).toBe(6);
    expect(countCuts(corrupted) > DEFAULT_MAX_CUTS_PER_SESSION).toBe(true);
    expect(countCuts([bar(0, 20, 20.1, 19.9, 20)])).toBe(0);
    expect(countCuts(corrupted, { ...DEFAULT_BAD_TICK_CONFIG, maxExcursion: ratio(5_000) })).toBe(0);
  });
});

describe("live prints and quotes", () => {
  const reference = { lastClose: px(20), averageRange: null };
  const quote = { bid: px(19.99), ask: px(20.01) };

  it("takes a print near the last close and inside the NBBO's margin", () => {
    expect(isSanePrint(px(21.9), reference, null, TEN)).toBe(true);
    expect(isSanePrint(px(20.02), reference, quote, TEN)).toBe(true);
    // 5% of the midpoint past either side of the quote.
    expect(isSanePrint(px(21.01), reference, quote, TEN)).toBe(true);
    expect(isSanePrint(px(18.99), reference, quote, TEN)).toBe(true);
  });

  it("drops a print too far from the last close or outside the NBBO's margin", () => {
    expect(isSanePrint(px(22.01), reference, null, TEN)).toBe(false);
    expect(isSanePrint(px(17.99), reference, null, TEN)).toBe(false);
    expect(isSanePrint(px(21.02), reference, quote, TEN)).toBe(false);
    expect(isSanePrint(px(18.98), reference, quote, TEN)).toBe(false);
    expect(isSanePrint(px(21.02), reference, quote, TEN, ratio(600))).toBe(true);
    // A fast name's own pace widens the first check, never the quote's.
    expect(isSanePrint(px(25), { lastClose: px(20), averageRange: px(1) }, null, TEN)).toBe(true);
  });

  it("drops a quote that is malformed or whose midpoint is too far from the last close", () => {
    expect(isSaneQuote(quote, reference, TEN)).toBe(true);
    expect(isSaneQuote({ bid: px(20.02), ask: px(20.01) }, reference, TEN)).toBe(false);
    expect(isSaneQuote({ bid: fixed(0), ask: px(20.01) }, reference, TEN)).toBe(false);
    expect(isSaneQuote({ bid: 1.5 as Fixed, ask: px(20.01) }, reference, TEN)).toBe(false);
    expect(isSaneQuote({ bid: px(22.1), ask: px(22.2) }, reference, TEN)).toBe(false);
    expect(isSaneQuote({ bid: px(17.8), ask: px(17.9) }, reference, TEN)).toBe(false);
  });
});

describe("the synthetic bad ticks (D.2)", () => {
  const path = (scenario: Scenario, seed: number) => generatePath({ ...DEFAULT_PATH_CONFIG, scenario, seed });

  /** ORB's plan on a scripted path: entry at the range high, the stop where the script put it, 2R target. */
  function planOn(bars: readonly Bar[], session: string) {
    const setup = loadSetup(orbSetupDefinition, { exit: { kind: "fixedR", targetR: 2, breakevenAtR: null } });
    const range = bars.filter((b) => b.minuteOfSession < 5);
    const last = range.at(-1) as Bar;
    const symbol: SymbolState = {
      symbol: "SYN",
      session,
      minuteOfSession: last.minuteOfSession,
      lastClose: last.close,
      dailyAtr: mulInt(DEFAULT_PATH_CONFIG.stopDistance, 10),
      rsi: null,
      sessionVwap: null,
      openingRvol: ratio(20_000),
      runningRvol: null,
    };
    return planTrade(setup, setup.detectTrigger(symbol, range, null) as SetupSignal, symbol);
  }

  const simulate = (bars: readonly Bar[], session: string) =>
    simulateTrade(planOn(bars, session), bars, {
      shares: 10,
      costModel: DEFAULT_COST_MODEL,
      lastEntryMinute: 360,
      flattenMinute: 380,
    });

  it("cuts exactly the spike on every seed: no false target above, no false stop-out below", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 60; seed += 1) {
      const generated = path("badTick", seed);
      const filter = new BadTickFilter();
      const out = generated.bars.map((b) => filter.filter(b));
      const cut = out.filter((o) => o.clipped.length > 0);
      expect(
        cut.map((o) => o.bar.minuteOfSession),
        `seed ${String(seed)}`,
      ).toEqual([6]);
      const side = cut[0]?.clipped[0]?.side as "high" | "low";
      seen.add(side);
      // Open, close, and volume are the feed's.
      const spike = generated.bars[6] as Bar;
      expect(cut[0]?.bar).toMatchObject({ open: spike.open, close: spike.close, volume: spike.volume });

      const raw = simulate(generated.bars, generated.session);
      const clean = simulate(
        out.map((o) => o.bar),
        generated.session,
      );
      // Unfiltered, the spike alone decides the trade at minute 6. Filtered, it cannot.
      expect(raw.filled && [raw.exitMinute, raw.exitReason], `seed ${String(seed)}`).toEqual([
        6,
        side === "high" ? "target" : "stop",
      ]);
      expect(clean.filled && clean.exitMinute, `seed ${String(seed)}`).not.toBe(6);
    }
    expect([...seen].sort()).toEqual(["high", "low"]);
  });

  it("keeps a bad print from triggering an entry before any real breakout", () => {
    const [, ...rows] = badTickBars.trim().split("\n");
    const bars = rows.map((row): Bar => {
      const [minute, open, high, low, close, volume] = row.split(",");
      return {
        session: SESSION,
        minuteOfSession: Number(minute),
        open: parseDecimal(open as string),
        high: parseDecimal(high as string),
        low: parseDecimal(low as string),
        close: parseDecimal(close as string),
        volume: Number(volume),
        vwap: null,
        closed: true,
      };
    });
    const filter = new BadTickFilter();
    const out = bars.map((b) => filter.filter(b));
    // At the default 20%, 20% past 20.26 is 24.312, and the print is 24.90.
    expect(out.flatMap((o) => o.clipped)).toEqual([
      { side: "high", reported: px(24.9), kept: px(20.26), limit: px(24.312) },
    ]);
    // The golden locks that the unfiltered print fills the entry at minute 6. Filtered, it does not.
    const setup = loadSetup(orbSetupDefinition, {});
    const range = bars.filter((b) => b.minuteOfSession < 5);
    const symbol: SymbolState = {
      symbol: "AAA",
      session: SESSION,
      minuteOfSession: 4,
      lastClose: (range.at(-1) as Bar).close,
      dailyAtr: px(1.5),
      rsi: null,
      sessionVwap: null,
      openingRvol: ratio(25_000),
      runningRvol: null,
    };
    const plan = planTrade(setup, setup.detectTrigger(symbol, range, null) as SetupSignal, symbol);
    const options = { shares: 25, costModel: DEFAULT_COST_MODEL, lastEntryMinute: 360, flattenMinute: 380 };
    const raw = simulateTrade(plan, bars, options);
    const clean = simulateTrade(
      plan,
      out.map((o) => o.bar),
      options,
    );
    expect(raw.filled && raw.entryMinute).toBe(6);
    expect(clean.filled ? clean.entryMinute : "never").not.toBe(6);
  });

  it("never touches a real fast move in the other scenarios", () => {
    for (const scenario of ["driftlessWalk", "gapThroughStop", "haltAndReopen", "stopRunWick"] as const) {
      for (let seed = 1; seed <= 40; seed += 1) {
        const generated = generatePath({
          ...DEFAULT_PATH_CONFIG,
          scenario,
          seed,
          volatilityBps: scenario === "driftlessWalk" ? 60 : DEFAULT_PATH_CONFIG.volatilityBps,
        });
        const filter = new BadTickFilter();
        const cuts = generated.bars.flatMap((b) => filter.filter(b).clipped);
        expect(cuts, `${scenario} seed ${String(seed)}`).toEqual([]);
      }
    }
  });
});
