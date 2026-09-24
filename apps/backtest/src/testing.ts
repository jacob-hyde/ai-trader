/**
 * Fixtures for the runner's tests: a small calendar, symbols that pass the screen, quiet warm-up
 * sessions, and busy synthetic sessions that put every symbol in play.
 */

import { readFileSync } from "node:fs";
import { MemoryReplaySource, type SessionHours, type StoredBar } from "@trader/adapters";
import type { Fixed, SymbolBar } from "@trader/contracts";
import { fixed } from "@trader/contracts";
import { DEFAULT_PATH_CONFIG, type Scenario, generatePath } from "@trader/core";
import { type RunConfig, type RunConfigInput, parseRunConfig } from "./config.js";
import type { GitState } from "./guard.js";
import { MemoryStudySource } from "./memory.js";
import { REGISTRATION_PATH, type Registration, parseRegistration } from "./registration.js";
import type { RunDependencies } from "./run.js";

/** Dollars to units. */
export const px = (dollars: number): Fixed => fixed(Math.round(dollars * 10_000));

/** Weekdays from `first`, as winter sessions: 09:30 to 16:00 New York is 14:30Z to 21:00Z. */
export function weekdays(first: string, count: number): SessionHours[] {
  const sessions: SessionHours[] = [];
  for (let day = Date.parse(`${first}T00:00:00Z`); sessions.length < count; day += 86_400_000) {
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) {
      continue;
    }
    const session = new Date(day).toISOString().slice(0, 10);
    sessions.push({ session, openAt: day + 14.5 * 3_600_000, closeAt: day + 21 * 3_600_000 });
  }
  return sessions;
}

/** The same session closing at 13:00 New York: 210 minutes. */
export function halfDay(hours: SessionHours): SessionHours {
  return { ...hours, closeAt: hours.openAt + 210 * 60_000 };
}

export function minutesOf(hours: SessionHours): number {
  return Math.round((hours.closeAt - hours.openAt) / 60_000);
}

/** A daily bar: open and close at `close`, a dollar of range, `volume` shares. */
export function dailyBar(
  symbol: string,
  session: string,
  close: number,
  { volume = 2_000_000, range = 1, splitFactor = 1 as number | null } = {},
): StoredBar {
  return {
    symbol,
    session,
    minuteOfSession: 0,
    open: px(close),
    high: px(close + range / 2),
    low: px(close - range / 2),
    close: px(close),
    volume,
    vwap: null,
    closed: true,
    splitFactor,
  };
}

/** Minutes from..to (exclusive) at one price. */
export function quietMinutes(
  symbol: string,
  session: string,
  price: number,
  { from = 0, to = 5, volume = 100 } = {},
): SymbolBar[] {
  return Array.from({ length: to - from }, (_, i) => ({
    symbol,
    session,
    minuteOfSession: from + i,
    open: px(price),
    high: px(price),
    low: px(price),
    close: px(price),
    volume,
    vwap: null,
    closed: true,
  }));
}

export interface Market {
  readonly sessions: readonly SessionHours[];
  readonly daily: readonly StoredBar[];
  readonly minute: readonly SymbolBar[];
}

/**
 * `warmup` quiet sessions for every symbol, then each test session replayed from a synthetic path. The
 * quiet sessions trade 100 shares a minute at the open, so any path's opening RVOL is far above 1 and
 * every symbol is in play. Daily bars make every symbol pass the screen: $20, 2M shares, a dollar of ATR.
 */
export function syntheticMarket(options: {
  readonly symbols: readonly string[];
  readonly warmup: readonly SessionHours[];
  readonly sessions: readonly SessionHours[];
  readonly scenario: (symbol: string, session: string) => Scenario;
  readonly volatilityBps?: number;
}): Market {
  const daily: StoredBar[] = [];
  const minute: SymbolBar[] = [];
  for (const hours of options.warmup) {
    for (const symbol of options.symbols) {
      daily.push(dailyBar(symbol, hours.session, 20));
      minute.push(...quietMinutes(symbol, hours.session, 20));
    }
  }
  options.sessions.forEach((hours, day) => {
    options.symbols.forEach((symbol, s) => {
      daily.push(dailyBar(symbol, hours.session, 20));
      const scenario = options.scenario(symbol, hours.session);
      const path = generatePath({
        ...DEFAULT_PATH_CONFIG,
        scenario,
        seed: 1_000 * (day + 1) + s,
        session: hours.session,
        minutes: minutesOf(hours),
        volatilityBps:
          options.volatilityBps ?? (scenario === "driftlessWalk" ? 60 : DEFAULT_PATH_CONFIG.volatilityBps),
      });
      minute.push(...path.bars.map((bar) => ({ ...bar, symbol })));
    });
  });
  return { sessions: [...options.warmup, ...options.sessions], daily, minute };
}

export const CLEAN: GitState = { commit: "0123456789abcdef", dirty: false };

/** The real registration, with the samples moved onto the test calendar. */
export function registrationFor(options: {
  readonly holdoutFrom: string;
  readonly excluded?: readonly string[];
  readonly frozen?: RunConfig | null;
}): Registration {
  const real = parseRegistration(readFileSync(REGISTRATION_PATH, "utf8"));
  return {
    ...real,
    thresholds: {
      ...real.thresholds,
      samples: {
        ...real.thresholds.samples,
        holdout: { from: options.holdoutFrom, to: "2099-12-31" },
        excludedSessions: [...(options.excluded ?? [])],
      },
    },
    frozen: options.frozen ?? null,
  };
}

export function dependencies(
  market: Market,
  registration: Registration,
  git: GitState = CLEAN,
): RunDependencies {
  return {
    replay: new MemoryReplaySource({
      sessions: market.sessions,
      minuteBars: market.minute,
      dailyBars: market.daily,
    }),
    study: new MemoryStudySource({ dailyBars: market.daily, minuteBars: market.minute }),
    registration,
    git,
  };
}

/** The pre-registration's confirmatory pair plus the ATR diagnostics, per signal, on a test range. */
export function testConfig(overrides: Partial<RunConfigInput> = {}): RunConfig {
  return parseRunConfig({
    name: "test",
    from: "2026-02-02",
    to: "2026-02-06",
    universe: {
      priceMin: 5,
      priceMax: 100,
      minAverageVolume: 1_000_000,
      minDailyAtr: 0.5,
      lookbackSessions: 14,
      lookbackWindowSessions: 20,
      openingRangeMinutes: 5,
      minOpeningRvol: 1,
      topN: 20,
    },
    shorts: true,
    variants: [
      { id: "A", stop: { kind: "openingRange" }, exit: { kind: "eod" } },
      { id: "B", stop: { kind: "openingRange" }, exit: { kind: "fixedR", targetR: 2, breakevenAtR: 1 } },
      { id: "atr10A", stop: { kind: "atrFraction", fraction: 0.1 }, exit: { kind: "eod" } },
    ],
    session: { lastEntryMinutesBeforeClose: 30, flattenMinutesBeforeClose: 10 },
    costs: {
      spread: { bps: 10, minTicks: 1 },
      market: { bps: 2, ticks: 1 },
      stopEntry: { bps: 10, ticks: 2 },
      stopExit: { bps: 10, ticks: 2 },
    },
    maxCostToRisk: 0.15,
    account: { kind: "perSignal", shares: 10 },
    seed: 20260922,
    ...overrides,
  });
}
