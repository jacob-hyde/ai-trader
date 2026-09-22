/**
 * ORB golden cases. Each case is a CSV of bars and a JSON expectation under "__fixtures__/orb".
 *
 * The expectations were worked out by hand from the spec and the default cost model, then locked. A
 * change that alters any output fails here until the fixture is updated on purpose, in the same PR.
 * Bumping ORB_VERSION fails every case for the same reason: a new version has to re-earn its goldens.
 */

import { describe, expect, it } from "vitest";
import badTickBars from "./__fixtures__/orb/bad-tick-before-trigger.bars.csv?raw";
import badTick from "./__fixtures__/orb/bad-tick-before-trigger.json" with { type: "json" };
import cleanBreakoutBars from "./__fixtures__/orb/clean-breakout-long.bars.csv?raw";
import cleanBreakout from "./__fixtures__/orb/clean-breakout-long.json" with { type: "json" };
import dojiBars from "./__fixtures__/orb/doji-skip.bars.csv?raw";
import doji from "./__fixtures__/orb/doji-skip.json" with { type: "json" };
import eodVsTargetBars from "./__fixtures__/orb/eod-vs-target.bars.csv?raw";
import eodVsTarget from "./__fixtures__/orb/eod-vs-target.json" with { type: "json" };
import gapThroughStopBars from "./__fixtures__/orb/gap-through-stop.bars.csv?raw";
import gapThroughStop from "./__fixtures__/orb/gap-through-stop.json" with { type: "json" };
import lowRvolBars from "./__fixtures__/orb/low-rvol-skip.bars.csv?raw";
import lowRvol from "./__fixtures__/orb/low-rvol-skip.json" with { type: "json" };
import shortMirrorBars from "./__fixtures__/orb/short-mirror.bars.csv?raw";
import shortMirror from "./__fixtures__/orb/short-mirror.json" with { type: "json" };
import tightVsWideBars from "./__fixtures__/orb/tight-vs-wide-stop.bars.csv?raw";
import tightVsWide from "./__fixtures__/orb/tight-vs-wide-stop.json" with { type: "json" };
import type { Bar } from "./bars.js";
import { DEFAULT_COST_MODEL } from "./costs.js";
import { parseDecimal, ratio, type Fixed } from "./money.js";
import { ORB_ID, ORB_VERSION, orbSetupDefinition } from "./orb.js";
import { loadSetup, planTrade, type SymbolState } from "./setup.js";
import { simulateTrade } from "./tradeSim.js";

interface ExpectedOutcome {
  filled: boolean;
  entryMinute: number;
  entryReference: string;
  entryFill: string;
  exitMinute: number;
  exitReason: string;
  exitReference: string;
  exitFill: string;
  grossR: number;
  netR: number;
}

interface Expectation {
  signal: { direction: string; entry: string; minute: number } | null;
  stop?: string;
  target?: string | null;
  breakevenAtR?: number | null;
  outcome?: ExpectedOutcome;
}

interface GoldenCase {
  fixtureVersion: number;
  setup: string;
  description: string;
  costModel: string;
  session: string;
  symbol: string;
  dailyAtr: string;
  openingRvol: number;
  shares: number;
  flattenMinute: number;
  variants: { name: string; params: Record<string, unknown>; expect: Expectation }[];
}

const CASES: readonly (readonly [string, GoldenCase, string])[] = [
  ["clean-breakout-long", cleanBreakout, cleanBreakoutBars],
  ["doji-skip", doji, dojiBars],
  ["low-rvol-skip", lowRvol, lowRvolBars],
  ["gap-through-stop", gapThroughStop, gapThroughStopBars],
  ["bad-tick-before-trigger", badTick, badTickBars],
  ["eod-vs-target", eodVsTarget, eodVsTargetBars],
  ["tight-vs-wide-stop", tightVsWide, tightVsWideBars],
  ["short-mirror", shortMirror, shortMirrorBars],
];

function parseBars(csv: string, session: string): Bar[] {
  const [header, ...rows] = csv.trim().split("\n");
  expect(header).toBe("minute,open,high,low,close,volume");
  return rows.map((row) => {
    const [minute, open, high, low, close, volume] = row.split(",") as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    return {
      session,
      minuteOfSession: Number(minute),
      open: parseDecimal(open),
      high: parseDecimal(high),
      low: parseDecimal(low),
      close: parseDecimal(close),
      volume: Number(volume),
      vwap: null,
      closed: true,
    };
  });
}

const price = (text: string | null | undefined): Fixed | null =>
  text === null || text === undefined ? null : parseDecimal(text);

describe("ORB golden cases", () => {
  it("covers every case the spec lists", () => {
    expect(CASES.map(([name]) => name)).toEqual([
      "clean-breakout-long",
      "doji-skip",
      "low-rvol-skip",
      "gap-through-stop",
      "bad-tick-before-trigger",
      "eod-vs-target",
      "tight-vs-wide-stop",
      "short-mirror",
    ]);
  });

  for (const [name, golden, csv] of CASES) {
    describe(name, () => {
      it("was locked against this version of the setup and the default cost model", () => {
        expect(golden.fixtureVersion).toBe(1);
        expect(golden.setup).toBe(`${ORB_ID}@${ORB_VERSION}`);
        expect(golden.costModel).toBe("default");
        expect(golden.description.length).toBeGreaterThan(40);
      });

      for (const variant of golden.variants) {
        it(`${variant.name}: produces exactly the locked signal, stop, target, fill, and R`, () => {
          const setup = loadSetup(orbSetupDefinition, variant.params);
          const bars = parseBars(csv, golden.session);
          // The engine asks at the range close, so the setup sees nothing that came after it.
          const rangeBars = bars.filter((bar) => bar.minuteOfSession < setup.params.openingRangeMinutes);
          const lastRangeBar = rangeBars.at(-1) as Bar;
          const symbol: SymbolState = {
            symbol: golden.symbol,
            session: golden.session,
            minuteOfSession: lastRangeBar.minuteOfSession,
            lastClose: lastRangeBar.close,
            dailyAtr: parseDecimal(golden.dailyAtr),
            rsi: null,
            sessionVwap: null,
            openingRvol: ratio(Math.round(golden.openingRvol * 10_000)),
            runningRvol: null,
          };

          const signal = setup.detectTrigger(symbol, rangeBars, null);
          const want = variant.expect;
          if (want.signal === null) {
            expect(signal).toBeNull();
            return;
          }
          expect(signal).not.toBeNull();
          if (signal === null) {
            return;
          }
          const plan = planTrade(setup, signal, symbol);
          const outcome = simulateTrade(plan, bars, {
            shares: golden.shares,
            costModel: DEFAULT_COST_MODEL,
            lastEntryMinute: setup.params.lastEntryMinute,
            flattenMinute: golden.flattenMinute,
          });

          const actual = {
            signal: { direction: signal.direction, entry: signal.entry, minute: signal.minuteOfSession },
            stop: plan.stop,
            target: plan.target,
            breakevenAtR: plan.management.breakevenAtR,
            outcome: outcome.filled
              ? {
                  filled: true,
                  entryMinute: outcome.entryMinute,
                  entryReference: outcome.entryReference,
                  entryFill: outcome.entryFill,
                  exitMinute: outcome.exitMinute,
                  exitReason: outcome.exitReason,
                  exitReference: outcome.exitReference,
                  exitFill: outcome.exitFill,
                  grossR: outcome.grossR,
                  netR: outcome.netR,
                }
              : { filled: false },
          };
          const locked = want.outcome as ExpectedOutcome;
          expect(actual).toEqual({
            signal: {
              direction: want.signal.direction,
              entry: price(want.signal.entry),
              minute: want.signal.minute,
            },
            stop: price(want.stop),
            target: price(want.target),
            breakevenAtR: want.breakevenAtR ?? null,
            outcome: {
              filled: locked.filled,
              entryMinute: locked.entryMinute,
              entryReference: price(locked.entryReference),
              entryFill: price(locked.entryFill),
              exitMinute: locked.exitMinute,
              exitReason: locked.exitReason,
              exitReference: price(locked.exitReference),
              exitFill: price(locked.exitFill),
              grossR: locked.grossR,
              netR: locked.netR,
            },
          });
        });
      }
    });
  }
});
