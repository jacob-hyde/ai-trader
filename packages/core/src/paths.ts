/**
 * Generates seeded synthetic one-minute sessions: bars, and the quote at each bar's close.
 *
 * For proving the machine, not the edge. The same seed and config always give the same path, bit for
 * bit, on any platform: the generator is integer arithmetic plus a square root, with no logarithm,
 * exponential, or trig call whose last digit could differ between runtimes.
 *
 * Scenarios:
 *
 * - driftlessWalk: a geometric random walk with no drift, the null model. Each step multiplies price by
 *   1 + sigma * z with E[z] = 0, so price is an exact martingale and any strategy that profits on it
 *   after costs is reading the future or miscounting.
 * - oscillateAroundStop: after the breakout, lows sit one tick above the stop bar after bar, and on
 *   about half of seeds one finally touches it. Catches off-by-one-tick stop logic.
 * - gapThroughStop: the bar after the breakout opens well under the stop.
 * - stopRunWick: one bar wicks a few ticks through the stop and closes back above the entry.
 * - haltAndReopen: bars stop arriving for 10 to 30 minutes, then trading reopens with a 1% to 5% gap,
 *   up or down by seed.
 * - badTick: one bar carries an outlier high or low 20% to 50% away while its open and close are normal.
 *
 * Every scripted scenario opens with a bullish opening range and a clean breakout bar, so the ORB
 * signals on it and the entry fills. The script is written around the range high as the entry and
 * `stopDistance` below it as the stop, and reports both so a harness can check it hit what it aimed at.
 * After the scripted part the session finishes as a driftless walk.
 *
 * Spreads come from a configurable distribution of whole ticks with a floor of one, so a zero spread
 * cannot be generated. Slippage is the cost model's job, applied on top. Price is floored at $1.00,
 * which a sane volatility never reaches.
 *
 * Partial fills, a websocket disconnect, and a crash followed by a reconcile are not here. Those are
 * adapter and engine events, not price paths, and wait on the adapter interface.
 */

import type { Bar } from "./bars.js";
import type { Quote } from "./costs.js";
import { type Fixed, PENNY, fixed } from "./money.js";

export const SCRIPTED_SCENARIOS = [
  "oscillateAroundStop",
  "gapThroughStop",
  "stopRunWick",
  "haltAndReopen",
  "badTick",
] as const;

export type ScriptedScenario = (typeof SCRIPTED_SCENARIOS)[number];
export type Scenario = "driftlessWalk" | ScriptedScenario;

/** Quoted spread in whole ticks, drawn uniformly from the inclusive range. The floor of one is enforced. */
export interface SpreadDistribution {
  readonly minTicks: number;
  readonly maxTicks: number;
}

export interface PathConfig {
  readonly seed: number;
  readonly scenario: Scenario;
  /** Trading date the bars carry. */
  readonly session: string;
  /** Opening price, on the penny grid, at or above $2.00. */
  readonly startPrice: Fixed;
  /** Length of the session in minutes. 390 is a full day. */
  readonly minutes: number;
  /** Standard deviation of one minute's return, in basis points. 10 is roughly a 2% day. */
  readonly volatilityBps: number;
  readonly spread: SpreadDistribution;
  /** Entry-to-stop distance the scripted scenarios are written around. Ignored by driftlessWalk. */
  readonly stopDistance: Fixed;
  /**
   * Price moves inside each bar of the walk. Sets how far a jump through a level overshoots it: 5 is
   * coarse and quick, 60 is one move a second and makes the overshoot tick-sized, as it is in real
   * minute bars. The tripwire needs the fine setting or the overshoot alone reads as an edge.
   */
  readonly stepsPerBar: number;
}

export const DEFAULT_PATH_CONFIG: Omit<PathConfig, "seed" | "scenario"> = {
  session: "2026-01-05",
  startPrice: fixed(200_000),
  minutes: 390,
  volatilityBps: 10,
  spread: { minTicks: 1, maxTicks: 4 },
  stopDistance: fixed(1_500),
  stepsPerBar: 5,
};

export interface SyntheticPath {
  readonly seed: number;
  readonly scenario: Scenario;
  readonly session: string;
  readonly bars: readonly Bar[];
  /** quotes[i] is the NBBO at the close of bars[i]. Never locked or crossed. */
  readonly quotes: readonly Quote[];
  /** The levels a scripted scenario was written around. Null for driftlessWalk. */
  readonly script: { readonly entry: Fixed; readonly stop: Fixed } | null;
}

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform whole number in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** Mean 0, variance 1, bounded at about 3.46 standard deviations. */
  normal(): number;
}

const SQRT_3 = Math.sqrt(3);

/**
 * Builds a mulberry32 generator. 32-bit integer state, so it is identical everywhere.
 *
 * normal() is the sum of four uniforms, recentred and rescaled. Close enough to a bell for price steps,
 * exactly symmetric so it adds no drift, and free of transcendental functions.
 */
export function createRng(seed: number): Rng {
  if (!Number.isSafeInteger(seed)) {
    throw new PathError(`seed must be a whole number, got ${String(seed)}`);
  }
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    normal: () => (next() + next() + next() + next() - 2) * SQRT_3,
  };
}

const FLOOR_PRICE = 10_000;
const TICK = PENNY;

function assertConfig(config: PathConfig): void {
  const whole = (value: number, min: number): boolean => Number.isSafeInteger(value) && value >= min;
  const problems: string[] = [];
  if (!whole(config.startPrice, 2 * FLOOR_PRICE) || config.startPrice % TICK !== 0) {
    problems.push("startPrice must be on the penny grid, at or above $2.00");
  }
  if (!whole(config.minutes, 60)) {
    problems.push("minutes must be a whole number of at least 60, so every script fits");
  }
  if (!whole(config.volatilityBps, 1) || config.volatilityBps > 500) {
    problems.push("volatilityBps must be a whole number from 1 to 500");
  }
  if (!whole(config.spread.minTicks, 1) || !whole(config.spread.maxTicks, config.spread.minTicks)) {
    problems.push("spread needs 1 <= minTicks <= maxTicks, so a zero spread cannot exist");
  }
  const stopFits = config.stopDistance % TICK === 0 && config.stopDistance * 4 <= config.startPrice;
  if (!whole(config.stopDistance, 5 * TICK) || !stopFits) {
    problems.push("stopDistance must be on the penny grid, from five ticks to a quarter of startPrice");
  }
  if (config.session.length === 0) {
    problems.push("session is empty");
  }
  if (!whole(config.stepsPerBar, 1) || config.stepsPerBar > 600) {
    problems.push("stepsPerBar must be a whole number from 1 to 600");
  }
  if (problems.length > 0) {
    throw new PathError(problems.join("; "));
  }
}

/** Accumulates bars and the quote at each close. Owns the rules every generated bar obeys. */
class Session {
  readonly bars: Bar[] = [];
  readonly quotes: Quote[] = [];
  readonly #config: PathConfig;
  readonly #rng: Rng;
  /** Last close, in units. The next bar opens here unless told otherwise. */
  price: number;
  minute = 0;

  constructor(config: PathConfig, rng: Rng) {
    this.#config = config;
    this.#rng = rng;
    this.price = config.startPrice;
  }

  get done(): boolean {
    return this.minute >= this.#config.minutes;
  }

  /** Appends one bar from explicit prices. Snaps to the penny grid and keeps high and low consistent. */
  push(open: number, high: number, low: number, close: number): void {
    const snap = (value: number): number => Math.max(FLOOR_PRICE, Math.round(value / TICK) * TICK);
    const o = snap(open);
    const c = snap(close);
    const h = Math.max(snap(high), o, c);
    const l = Math.min(snap(low), o, c);
    const busy = this.minute < 5 ? 4 : 1;
    this.bars.push({
      session: this.#config.session,
      minuteOfSession: this.minute,
      open: fixed(o),
      high: fixed(h),
      low: fixed(l),
      close: fixed(c),
      volume: busy * this.#rng.int(1_000, 50_000),
      vwap: null,
      closed: true,
    });
    const ticks = this.#rng.int(this.#config.spread.minTicks, this.#config.spread.maxTicks);
    const bid = c - Math.floor(ticks / 2) * TICK;
    this.quotes.push({ bid: fixed(bid), ask: fixed(bid + ticks * TICK) });
    this.price = c;
    this.minute += 1;
  }

  /** One bar of the driftless walk: a few multiplicative steps, tracked for the high and low. */
  walk(): void {
    const steps = this.#config.stepsPerBar;
    const sigma = this.#config.volatilityBps / 10_000 / Math.sqrt(steps);
    const open = this.price;
    let last = open;
    let high = open;
    let low = open;
    for (let step = 0; step < steps; step += 1) {
      last = Math.max(FLOOR_PRICE, last * (1 + sigma * this.#rng.normal()));
      high = Math.max(high, last);
      low = Math.min(low, last);
    }
    this.push(open, high, low, last);
  }

  /** Skips minutes with no bars at all, the way a halt arrives on a bar feed. */
  halt(minutes: number): void {
    this.minute += minutes;
  }
}

/** A bullish five-minute range, then a breakout bar that clears the range high and never nears the stop. */
function openWithBreakout(session: Session, rng: Rng, stopDistance: number): { entry: number; stop: number } {
  for (let minute = 0; minute < 5; minute += 1) {
    const open = session.price;
    const close = open + rng.int(1, 6) * TICK;
    session.push(open, close + rng.int(0, 2) * TICK, open - rng.int(0, 2) * TICK, close);
  }
  const entry = Math.max(...session.bars.map((bar) => bar.high));
  const stop = entry - stopDistance;
  const open = session.price;
  const high = entry + rng.int(2, 6) * TICK;
  const low = Math.max(open - rng.int(0, 2) * TICK, stop + 2 * TICK);
  session.push(open, high, low, entry + TICK);
  return { entry, stop };
}

function runScript(
  scenario: ScriptedScenario,
  session: Session,
  rng: Rng,
  entry: number,
  stop: number,
): void {
  const above = entry + TICK;
  switch (scenario) {
    case "oscillateAroundStop": {
      const touches = rng.next() < 0.5;
      for (let i = 0; i < 8; i += 1) {
        session.push(session.price, above + TICK, stop + TICK, i % 2 === 0 ? stop + 3 * TICK : above);
      }
      if (touches) {
        session.push(session.price, above, stop, stop + 2 * TICK);
      }
      return;
    }
    case "gapThroughStop": {
      const open = stop - rng.int(5, 30) * TICK;
      session.push(open, open + 2 * TICK, open - rng.int(2, 10) * TICK, open - TICK);
      return;
    }
    case "stopRunWick":
      session.push(session.price, above + 2 * TICK, stop - rng.int(1, 3) * TICK, above + TICK);
      return;
    case "haltAndReopen": {
      session.halt(rng.int(10, 30));
      const direction = rng.next() < 0.5 ? -1 : 1;
      const open = session.price * (1 + (direction * rng.int(100, 500)) / 10_000);
      session.push(open, open + 3 * TICK, open - 3 * TICK, open + direction * TICK);
      return;
    }
    case "badTick": {
      const upward = rng.next() < 0.5;
      const outlier = session.price * (1 + ((upward ? 1 : -1) * rng.int(2_000, 5_000)) / 10_000);
      const close = session.price + TICK;
      session.push(
        session.price,
        upward ? outlier : close + TICK,
        upward ? session.price - TICK : outlier,
        close,
      );
      return;
    }
  }
}

/** Generates one session. Throws PathError on a config that could produce a degenerate path. */
export function generatePath(config: PathConfig): SyntheticPath {
  assertConfig(config);
  const rng = createRng(config.seed);
  const session = new Session(config, rng);
  let script: SyntheticPath["script"] = null;

  if (config.scenario !== "driftlessWalk") {
    const { entry, stop } = openWithBreakout(session, rng, config.stopDistance);
    runScript(config.scenario, session, rng, entry, stop);
    script = { entry: fixed(entry), stop: fixed(stop) };
  }
  while (!session.done) {
    session.walk();
  }
  return {
    seed: config.seed,
    scenario: config.scenario,
    session: config.session,
    bars: session.bars,
    quotes: session.quotes,
    script,
  };
}
