/**
 * Where a backtest's bars come from: the stored history, read one session at a time.
 *
 * The backtest adapter only ever reads through this interface, so it runs the same over the Timescale
 * bar store (H.7) and over bars held in memory for a test. Everything here is as traded: prices are
 * never adjusted for later splits. Each daily bar carries its split factor instead (shares today per
 * share on that date), and restate() puts a lookback on one share basis as of the session being
 * replayed, so a split never leaks in from the future.
 */

import type { Fixed, IsoTimestamp, SessionDate, SymbolBar } from "@trader/contracts";
import { fixed } from "@trader/contracts";

/** One regular session: its New York date and its open and close as epoch milliseconds. Half days close early. */
export interface SessionHours {
  readonly session: SessionDate;
  readonly openAt: number;
  readonly closeAt: number;
}

/** A stored bar, as traded, with the split factor of its session. */
export interface StoredBar extends SymbolBar {
  /** Shares today per share on this bar's session. Null when the store could not measure it. */
  readonly splitFactor: number | null;
}

export interface ReplaySource {
  /** Regular sessions from `from` through `to`, inclusive, oldest first. */
  sessions(from: SessionDate, to: SessionDate): Promise<readonly SessionHours[]>;

  /**
   * Which of these symbols have minute bars loaded for the month holding the session. A loaded symbol
   * with no bars on a session did not trade that session. One that is not loaded was never fetched,
   * and replaying it would look exactly like a halt.
   */
  loaded(session: SessionDate, symbols: readonly string[]): Promise<ReadonlySet<string>>;

  /** Every minute bar of these symbols in one session, as traded, in any order. */
  sessionBars(hours: SessionHours, symbols: readonly string[]): Promise<readonly SymbolBar[]>;

  /** Daily bars of the sessions that open in [from, to), oldest first, each with its own split factor. */
  dailyBars(symbol: string, from: IsoTimestamp, to: IsoTimestamp): Promise<readonly StoredBar[]>;

  /** Minute bars that start in [from, to), oldest first, each with its session's split factor. */
  minuteBars(symbol: string, from: IsoTimestamp, to: IsoTimestamp): Promise<readonly StoredBar[]>;

  /** The split factor on a session, or on the latest session before it that has one. Null if none. */
  splitFactor(symbol: string, session: SessionDate): Promise<number | null>;
}

/**
 * Two factors this close are the same share basis. Split factors come from volume ratios, so noise
 * sits around one part in a million for a liquid name. No real split or stock dividend is within 0.1%.
 */
const SAME_BASIS = 0.001;

/**
 * A stored bar on the share basis of another session: prices times asOf / its own factor, volume
 * divided by the same. On the same basis the bar comes back untouched, so a price stays on its tick.
 * A missing factor on either side leaves the bar as traded.
 */
export function restate(bar: StoredBar, asOf: number | null): SymbolBar {
  const { splitFactor, ...plain } = bar;
  const ratio = basisRatio(splitFactor, asOf);
  if (ratio === null) {
    return plain;
  }
  // Rounding is monotone, so low <= open, close <= high survives it.
  const price = (units: Fixed): Fixed => restatePrice(units, ratio);
  return {
    ...plain,
    open: price(bar.open),
    high: price(bar.high),
    low: price(bar.low),
    close: price(bar.close),
    vwap: bar.vwap === null ? null : price(bar.vwap),
    volume: restateVolume(bar.volume, ratio),
  };
}

/**
 * What restate multiplies a price by to move it from a session with factor `own` to the basis of
 * `asOf`. Null when the two are the same basis or either factor is missing: the value stays as traded.
 * For a caller restating many numbers without building bars, with restatePrice and restateVolume.
 */
export function basisRatio(own: number | null, asOf: number | null): number | null {
  if (own === null || asOf === null) {
    return null;
  }
  const ratio = asOf / own;
  return Math.abs(ratio - 1) < SAME_BASIS ? null : ratio;
}

/** A price on another basis, never below one unit. `ratio` from basisRatio; null leaves it as traded. */
export function restatePrice(units: Fixed, ratio: number | null): Fixed {
  return ratio === null ? units : fixed(Math.max(1, Math.round(units * ratio)));
}

/** A volume on another basis: more shares after a split, fewer after a reverse split. */
export function restateVolume(volume: number, ratio: number | null): number {
  return ratio === null ? volume : Math.round(volume / ratio);
}

/**
 * A replay source with some sessions taken out, as if the exchange had been closed on them. They leave
 * the calendar, and no daily or minute bar of theirs comes back from a lookback, so a replay neither
 * trades them nor counts them in an average. For a day the store holds but cannot be trusted, such as
 * 2022-03-08 (Pre-Registration, Amendment 1).
 *
 * Split factors pass through: a factor says which share basis a date is on, and that is still true of
 * a day taken out.
 */
export function withoutSessions(source: ReplaySource, excluded: readonly SessionDate[]): ReplaySource {
  const out = new Set(excluded);
  const keep = <T extends { readonly session: SessionDate }>(rows: readonly T[]): readonly T[] =>
    rows.filter((row) => !out.has(row.session));
  return {
    sessions: async (from, to) => keep(await source.sessions(from, to)),
    loaded: (session, symbols) => source.loaded(session, symbols),
    sessionBars: async (hours, symbols) => (out.has(hours.session) ? [] : source.sessionBars(hours, symbols)),
    dailyBars: async (symbol, from, to) => keep(await source.dailyBars(symbol, from, to)),
    minuteBars: async (symbol, from, to) => keep(await source.minuteBars(symbol, from, to)),
    splitFactor: (symbol, session) => source.splitFactor(symbol, session),
  };
}

export interface MemoryReplaySourceData {
  readonly sessions: readonly SessionHours[];
  /** Minute bars, any order. */
  readonly minuteBars: readonly SymbolBar[];
  /** Daily bars with their split factors, any order. */
  readonly dailyBars?: readonly StoredBar[];
  /** Symbol-months ("SYM|2026-01") treated as loaded. Default: every one with a minute bar. */
  readonly loaded?: readonly string[];
  /** Milliseconds each call waits before answering, to stand in for a database. Default none. */
  readonly delay?: () => number;
}

/** A replay source over bars held in memory. For tests, and for replaying hand-made sessions. */
export class MemoryReplaySource implements ReplaySource {
  readonly #sessions: readonly SessionHours[];
  readonly #hours: ReadonlyMap<SessionDate, SessionHours>;
  readonly #minute: readonly SymbolBar[];
  readonly #daily: readonly StoredBar[];
  readonly #loaded: ReadonlySet<string>;
  readonly #delay: () => number;
  /** Every call made, in order, as "method symbol-or-session". */
  readonly calls: string[] = [];

  constructor(data: MemoryReplaySourceData) {
    this.#sessions = [...data.sessions].sort((a, b) => (a.session < b.session ? -1 : 1));
    this.#hours = new Map(this.#sessions.map((hours) => [hours.session, hours]));
    const stray = data.minuteBars.find((bar) => !this.#hours.has(bar.session));
    if (stray !== undefined) {
      throw new RangeError(
        `minute bar of ${stray.symbol} on ${stray.session}, which is not a listed session`,
      );
    }
    this.#minute = [...data.minuteBars].sort((a, b) => this.#startOf(a) - this.#startOf(b));
    this.#daily = [...(data.dailyBars ?? [])].sort((a, b) => (a.session < b.session ? -1 : 1));
    this.#loaded = new Set(
      data.loaded ?? data.minuteBars.map((bar) => `${bar.symbol}|${bar.session.slice(0, 7)}`),
    );
    this.#delay = data.delay ?? (() => 0);
  }

  async sessions(from: SessionDate, to: SessionDate): Promise<readonly SessionHours[]> {
    await this.#wait(`sessions ${from}`);
    return this.#sessions.filter((hours) => hours.session >= from && hours.session <= to);
  }

  async loaded(session: SessionDate, symbols: readonly string[]): Promise<ReadonlySet<string>> {
    await this.#wait(`loaded ${session}`);
    return new Set(symbols.filter((symbol) => this.#loaded.has(`${symbol}|${session.slice(0, 7)}`)));
  }

  async sessionBars(hours: SessionHours, symbols: readonly string[]): Promise<readonly SymbolBar[]> {
    await this.#wait(`sessionBars ${hours.session}`);
    const wanted = new Set(symbols);
    return this.#minute.filter((bar) => bar.session === hours.session && wanted.has(bar.symbol));
  }

  async dailyBars(symbol: string, from: IsoTimestamp, to: IsoTimestamp): Promise<readonly StoredBar[]> {
    await this.#wait(`dailyBars ${symbol}`);
    const start = Date.parse(from);
    const end = Date.parse(to);
    return this.#daily.filter((bar) => {
      const open = this.#hours.get(bar.session)?.openAt;
      return bar.symbol === symbol && open !== undefined && open >= start && open < end;
    });
  }

  async minuteBars(symbol: string, from: IsoTimestamp, to: IsoTimestamp): Promise<readonly StoredBar[]> {
    await this.#wait(`minuteBars ${symbol}`);
    const start = Date.parse(from);
    const end = Date.parse(to);
    return this.#minute
      .filter((bar) => bar.symbol === symbol && this.#startOf(bar) >= start && this.#startOf(bar) < end)
      .map((bar) => ({ ...bar, splitFactor: this.#factor(symbol, bar.session, true) }));
  }

  async splitFactor(symbol: string, session: SessionDate): Promise<number | null> {
    await this.#wait(`splitFactor ${symbol}`);
    return this.#factor(symbol, session, false);
  }

  /** The session's own factor, or with `exact` false the latest one at or before it. */
  #factor(symbol: string, session: SessionDate, exact: boolean): number | null {
    let found: number | null = null;
    for (const bar of this.#daily) {
      if (bar.symbol !== symbol || bar.session > session || (exact && bar.session !== session)) {
        continue;
      }
      found = bar.splitFactor ?? found;
    }
    return found;
  }

  /** When a bar starts. Every minute bar's session is listed; the constructor checks. */
  #startOf(bar: SymbolBar): number {
    return (this.#hours.get(bar.session) as SessionHours).openAt + bar.minuteOfSession * 60_000;
  }

  async #wait(call: string): Promise<void> {
    this.calls.push(call);
    const ms = this.#delay();
    if (ms > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    }
  }
}
