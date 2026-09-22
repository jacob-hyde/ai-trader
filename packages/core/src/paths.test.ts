import { describe, expect, it } from "vitest";
import { isBarAfter, isWellFormedBar, type Bar } from "./bars.js";
import { DEFAULT_COST_MODEL } from "./costs.js";
import { fixed, mulInt, ratio, type Fixed } from "./money.js";
import { orbSetupDefinition } from "./orb.js";
import {
  DEFAULT_PATH_CONFIG,
  PathError,
  SCRIPTED_SCENARIOS,
  createRng,
  generatePath,
  type PathConfig,
  type Scenario,
  type SyntheticPath,
} from "./paths.js";
import { loadSetup, planTrade, type SetupSignal, type SymbolState } from "./setup.js";
import { simulateTrade, type FilledTrade } from "./tradeSim.js";

const ALL_SCENARIOS: readonly Scenario[] = ["driftlessWalk", ...SCRIPTED_SCENARIOS];
const path = (scenario: Scenario, seed: number, more: Partial<PathConfig> = {}): SyntheticPath =>
  generatePath({ ...DEFAULT_PATH_CONFIG, scenario, seed, ...more });
const seeds = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);
// The first six closes of the driftless walk for seed 1, in units.
const PINNED_CLOSES: readonly number[] = [200_000, 199_900, 200_100, 200_200, 200_000, 199_800];

/** Runs the published ORB on a scripted path, with the ATR that puts its stop where the script aimed. */
function tradeOn(generated: SyntheticPath): { signal: SetupSignal; stop: Fixed; trade: FilledTrade } {
  const setup = loadSetup(orbSetupDefinition, {});
  const range = generated.bars.filter((bar) => bar.minuteOfSession < 5);
  const last = range.at(-1) as Bar;
  const symbol: SymbolState = {
    symbol: "SYN",
    session: generated.session,
    minuteOfSession: last.minuteOfSession,
    lastClose: last.close,
    dailyAtr: mulInt(DEFAULT_PATH_CONFIG.stopDistance, 10),
    rsi: null,
    sessionVwap: null,
    openingRvol: ratio(20_000),
    runningRvol: null,
  };
  const signal = setup.detectTrigger(symbol, range, null) as SetupSignal;
  const plan = planTrade(setup, signal, symbol);
  const trade = simulateTrade(plan, generated.bars, {
    shares: 10,
    costModel: DEFAULT_COST_MODEL,
    lastEntryMinute: 360,
    flattenMinute: 380,
  });
  if (!trade.filled) {
    throw new Error(`seed ${generated.seed} ${generated.scenario}: expected a fill, got ${trade.reason}`);
  }
  return { signal, stop: plan.stop, trade };
}

describe("createRng", () => {
  it("is pinned, because every seed in every report depends on it", () => {
    const rng = createRng(1);
    expect([rng.next(), rng.next(), rng.next()]).toEqual([
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522,
    ]);
  });

  it("gives the same stream for the same seed and a different one otherwise", () => {
    const draw = (seed: number) => {
      const rng = createRng(seed);
      return Array.from({ length: 50 }, () => rng.next());
    };
    expect(draw(42)).toEqual(draw(42));
    expect(draw(42)).not.toEqual(draw(43));
  });

  it("draws whole numbers across the whole inclusive range", () => {
    const rng = createRng(7);
    const seen = new Set(Array.from({ length: 2_000 }, () => rng.int(3, 8)));
    expect([...seen].sort()).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it("draws a symmetric unit-variance normal", () => {
    const rng = createRng(11);
    const draws = Array.from({ length: 200_000 }, () => rng.normal());
    const mean = draws.reduce((sum, z) => sum + z, 0) / draws.length;
    const variance = draws.reduce((sum, z) => sum + (z - mean) ** 2, 0) / draws.length;
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(Math.abs(variance - 1)).toBeLessThan(0.01);
    let largest = 0;
    for (const z of draws) {
      largest = Math.max(largest, Math.abs(z));
    }
    expect(largest).toBeLessThanOrEqual(2 * Math.sqrt(3));
  });

  it("rejects a seed that is not a whole number", () => {
    expect(() => createRng(1.5)).toThrow(PathError);
    expect(() => createRng(Number.NaN)).toThrow(PathError);
  });
});

describe("generatePath", () => {
  it("is reproducible from its seed, for every scenario", () => {
    for (const scenario of ALL_SCENARIOS) {
      expect(path(scenario, 99), scenario).toEqual(path(scenario, 99));
      expect(path(scenario, 99).bars, scenario).not.toEqual(path(scenario, 100).bars);
    }
  });

  it("is pinned for one seed, so a change to the generator is a deliberate one", () => {
    const closes = path("driftlessWalk", 1)
      .bars.slice(0, 6)
      .map((bar) => bar.close);
    expect(closes).toEqual(PINNED_CLOSES);
  });

  it("emits only well-formed, closed, strictly ordered bars on the penny grid, inside the session", () => {
    for (const scenario of ALL_SCENARIOS) {
      for (const seed of seeds(40)) {
        const { bars } = path(scenario, seed);
        expect(bars.length).toBeGreaterThan(300);
        bars.forEach((bar, i) => {
          const where = `${scenario} seed ${seed} bar ${i}`;
          expect(isWellFormedBar(bar) && bar.closed, where).toBe(true);
          expect(
            [bar.open, bar.high, bar.low, bar.close].every((price) => price % 100 === 0),
            where,
          ).toBe(true);
          expect(bar.minuteOfSession, where).toBeLessThan(DEFAULT_PATH_CONFIG.minutes);
          if (i > 0) {
            expect(isBarAfter(bar, bars[i - 1] as Bar), where).toBe(true);
          }
        });
      }
    }
  });

  it("never quotes a zero or crossed spread, and the quote always brackets the close", () => {
    for (const scenario of ALL_SCENARIOS) {
      for (const seed of seeds(40)) {
        const { bars, quotes } = path(scenario, seed, { spread: { minTicks: 1, maxTicks: 6 } });
        expect(quotes.length).toBe(bars.length);
        quotes.forEach((quote, i) => {
          const width = quote.ask - quote.bid;
          expect(width, `${scenario} seed ${seed} quote ${i}`).toBeGreaterThanOrEqual(100);
          expect(width).toBeLessThanOrEqual(600);
          expect(quote.bid).toBeLessThanOrEqual((bars[i] as Bar).close);
          expect(quote.ask).toBeGreaterThanOrEqual((bars[i] as Bar).close);
        });
      }
    }
  });

  it("draws spreads across the whole configured distribution", () => {
    const widths = new Set(
      path("driftlessWalk", 5, { spread: { minTicks: 2, maxTicks: 4 } }).quotes.map((q) => q.ask - q.bid),
    );
    expect([...widths].sort()).toEqual([200, 300, 400]);
  });

  it("honors the session length and label", () => {
    const short = path("driftlessWalk", 3, { minutes: 210, session: "2026-11-27" });
    expect(short.bars.length).toBe(210);
    expect(short.bars.every((bar) => bar.session === "2026-11-27")).toBe(true);
    expect(short.script).toBeNull();
  });

  it("rejects a config that could produce a degenerate path, naming every problem", () => {
    const bad: readonly Partial<PathConfig>[] = [
      { startPrice: fixed(19_900) },
      { startPrice: fixed(200_050) },
      { minutes: 59 },
      { minutes: 100.5 },
      { volatilityBps: 0 },
      { volatilityBps: 501 },
      { spread: { minTicks: 0, maxTicks: 3 } },
      { spread: { minTicks: 3, maxTicks: 2 } },
      { stopDistance: fixed(400) },
      { stopDistance: fixed(1_550) },
      { stopDistance: fixed(60_000) },
      { session: "" },
    ];
    for (const overrides of bad) {
      expect(() => path("driftlessWalk", 1, overrides), JSON.stringify(overrides)).toThrow(PathError);
    }
    expect(() => path("driftlessWalk", 1, { minutes: 1, session: "" })).toThrow(/minutes.*; session/);
  });
});

describe("driftlessWalk", () => {
  it("has no drift: the mean return across many seeds is zero to within sampling error", () => {
    const returns = seeds(3_000).map((seed) => {
      const { bars } = path("driftlessWalk", seed);
      return (bars.at(-1) as Bar).close / DEFAULT_PATH_CONFIG.startPrice - 1;
    });
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const sd = Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length);
    // About a 2% day, so the standard error of the mean over 3,000 days is about 0.04%.
    expect(sd).toBeGreaterThan(0.015);
    expect(sd).toBeLessThan(0.025);
    expect(Math.abs(mean)).toBeLessThan(4 * (sd / Math.sqrt(returns.length)));
  });

  it("scales its range with the configured volatility", () => {
    const spreadOf = (volatilityBps: number) => {
      const closes = path("driftlessWalk", 8, { volatilityBps }).bars.map((bar) => bar.close);
      return Math.max(...closes) - Math.min(...closes);
    };
    expect(spreadOf(30)).toBeGreaterThan(2 * spreadOf(5));
  });

  it("never goes below the one dollar floor, even at absurd volatility", () => {
    const { bars } = path("driftlessWalk", 2, { startPrice: fixed(20_000), volatilityBps: 500 });
    expect(Math.min(...bars.map((bar) => bar.low))).toBeGreaterThanOrEqual(10_000);
  });
});

describe("scripted scenarios", () => {
  it("open with a bullish range and a breakout the ORB signals on and fills, at the scripted levels", () => {
    for (const scenario of SCRIPTED_SCENARIOS) {
      for (const seed of seeds(60)) {
        const generated = path(scenario, seed);
        const { signal, stop, trade } = tradeOn(generated);
        const where = `${scenario} seed ${seed}`;
        expect(signal.direction, where).toBe("long");
        expect(signal.entry, where).toBe(generated.script?.entry);
        expect(stop, where).toBe(generated.script?.stop);
        expect(trade.entryMinute, where).toBe(5);
        expect(trade.entryReference, where).toBe(signal.entry);
      }
    }
  });

  it("gapThroughStop: exits on the next bar at its open, below the stop, for more than a 1R loss", () => {
    for (const seed of seeds(60)) {
      const { stop, trade } = tradeOn(path("gapThroughStop", seed));
      expect([trade.exitMinute, trade.exitReason]).toEqual([6, "stop"]);
      expect(trade.exitReference).toBeLessThan(stop);
      expect(trade.grossR).toBeLessThan(-10_000);
    }
  });

  it("stopRunWick: stops out at the stop price even though the bar closes back above the entry", () => {
    for (const seed of seeds(60)) {
      const generated = path("stopRunWick", seed);
      const { signal, stop, trade } = tradeOn(generated);
      expect([trade.exitMinute, trade.exitReason]).toEqual([6, "stop"]);
      expect(trade.exitReference).toBe(stop);
      expect(trade.grossR).toBe(-10_000);
      expect((generated.bars[6] as Bar).close).toBeGreaterThan(signal.entry);
    }
  });

  it("oscillateAroundStop: survives lows one tick above the stop, and stops out only on the touch", () => {
    const outcomes = seeds(60).map((seed) => {
      const generated = path("oscillateAroundStop", seed);
      const { stop, trade } = tradeOn(generated);
      const oscillation = generated.bars.slice(6, 14);
      expect(oscillation.every((bar) => bar.low === stop + 100)).toBe(true);
      expect(trade.exitMinute).toBeGreaterThanOrEqual(14);
      const touched = (generated.bars[14] as Bar).low === stop;
      if (touched) {
        expect([trade.exitMinute, trade.exitReason, trade.exitReference]).toEqual([14, "stop", stop]);
      }
      return touched;
    });
    // Both branches of the script are exercised.
    expect(outcomes.filter(Boolean).length).toBeGreaterThan(15);
    expect(outcomes.filter((touched) => !touched).length).toBeGreaterThan(15);
  });

  it("haltAndReopen: no bars for 10 to 30 minutes, then a 1% to 5% gap in either direction", () => {
    const directions = new Set<number>();
    for (const seed of seeds(60)) {
      const { bars } = path("haltAndReopen", seed);
      const before = bars[5] as Bar;
      const reopen = bars[6] as Bar;
      const halted = reopen.minuteOfSession - before.minuteOfSession - 1;
      expect(halted).toBeGreaterThanOrEqual(10);
      expect(halted).toBeLessThanOrEqual(30);
      const gap = reopen.open / before.close - 1;
      expect(Math.abs(gap)).toBeGreaterThan(0.0095);
      expect(Math.abs(gap)).toBeLessThan(0.0505);
      directions.add(Math.sign(gap));
    }
    expect([...directions].sort()).toEqual([-1, 1]);
  });

  it("badTick: exactly one bar carries an outlier print, with a normal open and close", () => {
    const directions = new Set<string>();
    for (const seed of seeds(60)) {
      const { bars } = path("badTick", seed);
      const outliers = bars.filter((bar) => bar.high > bar.open * 1.15 || bar.low < bar.open * 0.85);
      expect(outliers.length).toBe(1);
      const spike = outliers[0] as Bar;
      expect(spike.minuteOfSession).toBe(6);
      expect(Math.abs(spike.close / spike.open - 1)).toBeLessThan(0.002);
      directions.add(spike.high > spike.open * 1.15 ? "up" : "down");
    }
    expect([...directions].sort()).toEqual(["down", "up"]);
  });
});
