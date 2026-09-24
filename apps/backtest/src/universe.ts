/**
 * The study's universe: which names are in play each session (Pre-Registration section 3).
 *
 * A symbol is eligible on session D when, on the sessions before D only:
 *
 * - its prior close is inside the price band, both ends included;
 * - its mean daily volume over its last `lookbackSessions` sessions is strictly above the minimum;
 * - its daily ATR (core's Atr, Wilder, run from the symbol's first stored bar) is strictly above the
 *   minimum;
 * - those last `lookbackSessions` sessions all fall inside the last `lookbackWindowSessions` sessions of
 *   the calendar, which drops a new listing and a ticker just reused by another company;
 * - it is not on the exclusion list;
 * - its bars that session are not corrupted: the bad-tick filter (H.8) cuts them no more than
 *   maxCutsPerSession times. A corrupted symbol-session is left out whole, as if the symbol had not
 *   traded: never ranked, and skipped in every later lookback, like an excluded session but for one name.
 *
 * Eligible names rank by opening RVOL: the volume of the first `openingRangeMinutes` minutes of D over
 * the mean of the same minutes across those same lookback sessions, floored to basis points exactly as
 * core's RelativeVolume floors it. Only names strictly above the minimum qualify, highest first, ties
 * by symbol. The top N are in play.
 *
 * Every number is split-restated as of D, the way a scanner showed it that morning: the lookback moves
 * onto D's share basis, and nothing after D is read. The ATR runs on bars put on today's basis and is
 * then moved to D's, so a split inside the lookback neither widens it nor shrinks it. A bar with no
 * split factor takes the latest one before it, never a later one, as the backtest adapter does.
 *
 * The calendar handed in has any excluded session taken out already, so a day such as 2022-03-08 is
 * never traded and never counted in a lookback (Amendment 1).
 *
 * The ranking reads D's opening minutes, so the list is only known at the range close. The replay uses
 * it to pick which symbols to load, where it is harmless (the broker holds no order on them yet), and
 * the engine must not act on it before the range has closed. That is engine.ts's job.
 *
 * It walks the calendar forward one month at a time, reading a month of daily bars and opening volumes
 * in one query each, and keeps only a rolling window per symbol. So memory stays flat over a decade.
 */

import { type StoredBar, basisRatio, restatePrice, restateVolume } from "@trader/adapters";
import type { Bar, Fixed, Ratio, SessionDate } from "@trader/contracts";
import { fixed } from "@trader/contracts";
import { Atr, type BadTickConfig, countCuts, fromNumber, ratio } from "@trader/core";
import { type RunConfig, badTickConfigFor, toRatio } from "./config.js";

export interface OpeningVolume {
  readonly symbol: string;
  readonly session: SessionDate;
  /** Shares traded in the session's first minutes, as traded. */
  readonly volume: number;
}

/** A symbol-session with a bar whose high or low reaches more than 9% past its body. */
export interface WideWickSession {
  readonly symbol: string;
  readonly session: SessionDate;
  /** How many such bars. The filter can cut at most two extremes from each. */
  readonly wideBars: number;
}

/** What the universe reads. The Timescale store in production, memory in tests. */
export interface StudySource {
  /** Daily bars of every symbol on the sessions of a month ("2021-03"), as traded, with split factors. */
  dailyBars(month: string): Promise<readonly StoredBar[]>;
  /**
   * Summed volume of each symbol's first `minutes` minutes, per session of the month. A symbol-session
   * with no bar in those minutes is absent, and counts as zero where its month is loaded.
   */
  openingVolumes(month: string, minutes: number): Promise<readonly OpeningVolume[]>;
  /** The months ("2021-03") each symbol has complete minute bars for. */
  minuteMonths(): Promise<ReadonlyMap<string, ReadonlySet<string>>>;
  /**
   * The month's symbol-sessions with a wick more than 9% past its bar's body: the only places a
   * bad-tick filter limited to 10% or more can cut.
   */
  wideWickSessions(month: string): Promise<readonly WideWickSession[]>;
  /** One symbol's minute bars for one session, in minute order. */
  sessionMinuteBars(symbol: string, session: SessionDate): Promise<readonly Bar[]>;
  /** What the store holds, as far as a run can tell, and an id for it (L.5). */
  dataSnapshot(): Promise<DataSnapshot>;
}

/**
 * Names the data a run read. Two runs of one configuration at one commit on the same snapshot give the
 * same result. The id hashes the facts, so equal ids mean equal facts.
 */
export interface DataSnapshot {
  readonly id: string;
  readonly facts: Readonly<Record<string, unknown>>;
}

export interface UniverseRules {
  readonly priceMin: Fixed;
  readonly priceMax: Fixed;
  readonly minAverageVolume: number;
  readonly minDailyAtr: Fixed;
  readonly lookbackSessions: number;
  readonly lookbackWindowSessions: number;
  readonly openingRangeMinutes: number;
  readonly minOpeningRvol: Ratio;
  readonly topN: number;
  /** Symbols never ranked, from the session given on, or for all their history when it is null. */
  readonly excludeSymbols: ReadonlyMap<string, SessionDate | null>;
  /** The bad-tick filter, whose cuts decide which symbol-sessions are corrupted. Null finds none. */
  readonly badTicks: BadTickConfig | null;
  /** More cuts than this in a symbol-session and it is left out whole. */
  readonly maxCutsPerSession: number;
}

export function rulesFor(config: RunConfig): UniverseRules {
  const u = config.universe;
  return {
    priceMin: fromNumber(u.priceMin),
    priceMax: fromNumber(u.priceMax),
    minAverageVolume: u.minAverageVolume,
    minDailyAtr: fromNumber(u.minDailyAtr),
    lookbackSessions: u.lookbackSessions,
    lookbackWindowSessions: u.lookbackWindowSessions,
    openingRangeMinutes: u.openingRangeMinutes,
    minOpeningRvol: toRatio(u.minOpeningRvol),
    topN: u.topN,
    excludeSymbols: new Map(
      u.excludeSymbols.map((entry) =>
        typeof entry === "string" ? [entry, null] : [entry.symbol, entry.from],
      ),
    ),
    badTicks: badTickConfigFor(config),
    maxCutsPerSession: config.badTicks?.maxCutsPerSession ?? 0,
  };
}

export interface InPlayName {
  readonly symbol: string;
  /** 1 is the highest opening RVOL. */
  readonly rank: number;
  readonly openingRvol: Ratio;
  /** On the session's own share basis, as is everything here. */
  readonly dailyAtr: Fixed;
  readonly priorClose: Fixed;
  readonly averageVolume: number;
}

/**
 * Eligible and traded in the opening minutes, but with nothing to rank on: minute bars never loaded for
 * the session's month or a lookback session's, or a lookback that traded nothing in the opening minutes.
 * Reported, never guessed at.
 */
export type UnrankableReason = "minutesNotLoaded" | "baselineEmpty";

/** A name that passed the screen, before any ranking: what a strategy that does not rank on RVOL reads. */
export interface EligibleName {
  readonly symbol: string;
  /** On the session's own share basis. */
  readonly priorClose: Fixed;
  readonly dailyAtr: Fixed;
  readonly averageVolume: number;
}

export interface SessionPlan {
  readonly session: SessionDate;
  readonly eligible: number;
  /** Every eligible name, in symbol order. */
  readonly eligibleNames: readonly EligibleName[];
  /** Eligible with opening RVOL above the minimum. The in-play names are the first topN of these. */
  readonly qualified: number;
  readonly inPlay: readonly InPlayName[];
  readonly unrankable: ReadonlyArray<{ readonly symbol: string; readonly reason: UnrankableReason }>;
  /** Symbols left out this session as corrupted: never ranked, and never in a later lookback. */
  readonly corrupt: readonly string[];
}

/** One session a symbol traded, as the lookback keeps it. */
interface Day {
  /** Position in the calendar. */
  readonly index: number;
  /** As traded, carrying the split factor it is on. */
  readonly bar: StoredBar;
  /** Opening-minutes volume, as traded. Null where the month has no minute bars, or was never read. */
  readonly opening: number | null;
}

interface History {
  /** On today's share basis. */
  readonly atr: Atr;
  /** The last lookbackSessions sessions it traded, oldest first. */
  readonly recent: Day[];
  /** The latest split factor seen. */
  factor: number | null;
}

/** A bar on today's share basis, for an indicator that runs across splits. */
function todayBasis(bar: StoredBar): Bar {
  const toToday = basisRatio(bar.splitFactor, 1);
  return {
    session: bar.session,
    minuteOfSession: 0,
    open: restatePrice(bar.open, toToday),
    high: restatePrice(bar.high, toToday),
    low: restatePrice(bar.low, toToday),
    close: restatePrice(bar.close, toToday),
    volume: 0,
    vwap: null,
    closed: true,
  };
}

/** Code-unit order, the same under every locale. */
function bySymbol(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class StudyUniverse {
  readonly #source: StudySource;
  readonly #rules: UniverseRules;
  readonly #calendar: readonly SessionDate[];
  readonly #index: ReadonlyMap<SessionDate, number>;
  /** Opening volumes are read from this calendar index on: nothing earlier can sit in a lookback. */
  readonly #openingFrom: number;
  readonly #onMonth: (month: string) => void | Promise<void>;
  readonly #histories = new Map<string, History>();
  #minuteMonths: ReadonlyMap<string, ReadonlySet<string>> | null = null;
  /** The next calendar index whose bars have not been folded into the histories. */
  #next = 0;
  /** The calendar index last planned. */
  #planned = -1;
  #month: string | null = null;
  #daily = new Map<SessionDate, StoredBar[]>();
  #opening = new Map<SessionDate, Map<string, number>>();
  #corrupt = new Map<SessionDate, Set<string>>();

  /**
   * `calendar` is every session from the start of the store through the last one to plan, oldest
   * first, with excluded sessions already taken out. `from` is the first session to be planned.
   * `onMonth` hears each month as it is read, for progress.
   */
  constructor(
    source: StudySource,
    rules: UniverseRules,
    calendar: readonly SessionDate[],
    from: SessionDate,
    onMonth: (month: string) => void | Promise<void> = () => undefined,
  ) {
    this.#source = source;
    this.#rules = rules;
    this.#calendar = calendar;
    this.#index = new Map(calendar.map((session, i) => [session, i]));
    const first = calendar.findIndex((session) => session >= from);
    this.#openingFrom = Math.max(0, (first === -1 ? calendar.length : first) - rules.lookbackWindowSessions);
    this.#onMonth = onMonth;
  }

  /** The plan for a session. Sessions must be asked for in calendar order; each once. */
  async plan(session: SessionDate): Promise<SessionPlan> {
    const d = this.#index.get(session);
    if (d === undefined) {
      throw new RangeError(`${session} is not in the study calendar`);
    }
    if (d <= this.#planned) {
      throw new RangeError(`${session} was already planned or passed; plan sessions in order`);
    }
    this.#planned = d;
    this.#minuteMonths ??= await this.#source.minuteMonths();
    while (this.#next < d) {
      await this.#fold(this.#next);
      this.#next += 1;
    }
    await this.#load(session.slice(0, 7));
    return this.#rank(session, d);
  }

  /** Reads a month's daily bars and, once lookbacks can reach it, its opening volumes. */
  async #load(month: string): Promise<void> {
    if (this.#month === month) {
      return;
    }
    const openingMonth = (this.#calendar[this.#openingFrom] ?? "9999").slice(0, 7);
    const [bars, volumes] = await Promise.all([
      this.#source.dailyBars(month),
      month >= openingMonth
        ? this.#source.openingVolumes(month, this.#rules.openingRangeMinutes)
        : Promise.resolve([]),
    ]);
    this.#daily = new Map();
    for (const bar of bars) {
      (this.#daily.get(bar.session) ?? this.#daily.set(bar.session, []).get(bar.session))?.push(bar);
    }
    this.#opening = new Map();
    for (const row of volumes) {
      (this.#opening.get(row.session) ?? this.#opening.set(row.session, new Map()).get(row.session))?.set(
        row.symbol,
        row.volume,
      );
    }
    this.#corrupt = await this.#corruptSessions(month);
    this.#month = month;
    await this.#onMonth(month);
  }

  /**
   * The month's symbol-sessions the filter cuts more than maxCutsPerSession times. Only a session with a
   * wide wick can be cut at all, so the exact filter runs over those alone.
   */
  async #corruptSessions(month: string): Promise<Map<SessionDate, Set<string>>> {
    const corrupt = new Map<SessionDate, Set<string>>();
    const config = this.#rules.badTicks;
    if (config === null) {
      return corrupt;
    }
    const limit = this.#rules.maxCutsPerSession;
    for (const candidate of await this.#source.wideWickSessions(month)) {
      if (2 * candidate.wideBars <= limit) {
        continue;
      }
      const bars = await this.#source.sessionMinuteBars(candidate.symbol, candidate.session);
      if (countCuts(bars, config) > limit) {
        (
          corrupt.get(candidate.session) ?? corrupt.set(candidate.session, new Set()).get(candidate.session)
        )?.add(candidate.symbol);
      }
    }
    return corrupt;
  }

  /** Adds one session's daily bars to every history. Bars within a symbol arrive oldest first. */
  async #fold(i: number): Promise<void> {
    const session = this.#calendar[i] as SessionDate;
    const month = session.slice(0, 7);
    await this.#load(month);
    const opening = this.#opening.get(session);
    const readOpening = i >= this.#openingFrom;
    const { lookbackSessions } = this.#rules;
    const corrupt = this.#corrupt.get(session);
    for (const raw of this.#daily.get(session) ?? []) {
      // A corrupted day counts as a day the symbol did not trade.
      if (corrupt?.has(raw.symbol) === true) {
        continue;
      }
      let history = this.#histories.get(raw.symbol);
      if (history === undefined) {
        history = { atr: new Atr(lookbackSessions), recent: [], factor: null };
        this.#histories.set(raw.symbol, history);
      }
      const factor = raw.splitFactor ?? history.factor;
      history.factor = factor;
      const bar = raw.splitFactor === factor ? raw : { ...raw, splitFactor: factor };
      history.atr.update(todayBasis(bar));
      const loaded = readOpening && (this.#minuteMonths?.get(raw.symbol)?.has(month) ?? false);
      history.recent.push({ index: i, bar, opening: loaded ? (opening?.get(raw.symbol) ?? 0) : null });
      if (history.recent.length > lookbackSessions) {
        history.recent.shift();
      }
    }
  }

  #rank(session: SessionDate, d: number): SessionPlan {
    const rules = this.#rules;
    const L = rules.lookbackSessions;
    const month = session.slice(0, 7);
    const today = new Map((this.#daily.get(session) ?? []).map((bar) => [bar.symbol, bar]));
    const opening = this.#opening.get(session);
    const corrupt = this.#corrupt.get(session) ?? new Set<string>();
    const qualified: Array<Omit<InPlayName, "rank">> = [];
    const unrankable: Array<{ symbol: string; reason: UnrankableReason }> = [];
    const eligibleNames: EligibleName[] = [];
    let eligible = 0;

    for (const [symbol, history] of this.#histories) {
      const { recent } = history;
      const oldest = recent[0];
      if (recent.length < L || oldest === undefined || oldest.index < d - rules.lookbackWindowSessions) {
        continue;
      }
      const excludedFrom = rules.excludeSymbols.get(symbol);
      if (
        (excludedFrom !== undefined && (excludedFrom === null || session >= excludedFrom)) ||
        corrupt.has(symbol)
      ) {
        continue;
      }
      const atrToday = history.atr.value;
      if (atrToday === null) {
        continue;
      }
      // A split takes effect at the open, so D's own factor is known before anything trades.
      const asOf = today.get(symbol)?.splitFactor ?? history.factor;
      const last = recent[L - 1] as Day;
      const priorClose = restatePrice(last.bar.close, basisRatio(last.bar.splitFactor, asOf));
      if (priorClose < rules.priceMin || priorClose > rules.priceMax) {
        continue;
      }
      let volume = 0;
      for (const day of recent) {
        volume += restateVolume(day.bar.volume, basisRatio(day.bar.splitFactor, asOf));
      }
      if (!(volume > rules.minAverageVolume * L)) {
        continue;
      }
      const dailyAtr = fixed(Math.round(atrToday * (asOf ?? 1)));
      if (!(dailyAtr > rules.minDailyAtr)) {
        continue;
      }
      eligible += 1;
      eligibleNames.push({ symbol, priorClose, dailyAtr, averageVolume: volume / L });

      // With no opening volume today a name cannot qualify, whatever its baseline, so it is never
      // unrankable. One that did not trade at all today (no daily bar, e.g. a ticker gone or renamed
      // while still inside its window) has nothing to load and reads as zero. The ranking is the same
      // either way; this only keeps "unrankable" meaning a real hole.
      const monthLoaded = this.#minuteMonths?.get(symbol)?.has(month) ?? false;
      const todayVolume = monthLoaded ? (opening?.get(symbol) ?? 0) : today.has(symbol) ? null : 0;
      if (todayVolume === 0) {
        continue;
      }
      if (todayVolume === null || recent.some((day) => day.opening === null)) {
        unrankable.push({ symbol, reason: "minutesNotLoaded" });
        continue;
      }
      let baseline = 0n;
      for (const day of recent) {
        baseline += BigInt(restateVolume(day.opening as number, basisRatio(day.bar.splitFactor, asOf)));
      }
      if (baseline === 0n) {
        unrankable.push({ symbol, reason: "baselineEmpty" });
        continue;
      }
      const openingRvol = ratio(Number((BigInt(todayVolume) * BigInt(L) * 10_000n) / baseline));
      if (openingRvol > rules.minOpeningRvol) {
        qualified.push({ symbol, openingRvol, dailyAtr, priorClose, averageVolume: volume / L });
      }
    }

    qualified.sort((a, b) => b.openingRvol - a.openingRvol || bySymbol(a.symbol, b.symbol));
    unrankable.sort((a, b) => bySymbol(a.symbol, b.symbol));
    return {
      session,
      eligible,
      eligibleNames: eligibleNames.sort((a, b) => bySymbol(a.symbol, b.symbol)),
      qualified: qualified.length,
      inPlay: qualified.slice(0, rules.topN).map((name, i) => ({ ...name, rank: i + 1 })),
      unrankable,
      corrupt: [...corrupt].sort(bySymbol),
    };
  }
}
