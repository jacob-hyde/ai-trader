/**
 * The backtest adapter: stored minute bars replayed into the simulated broker, in strict time order
 * across every symbol (F.2).
 *
 * The replay walks one session at a time and one minute at a time. Each minute, every symbol's bar for
 * that minute reaches the broker first, then the engine sees them as bar and quote events, then the
 * replay waits for the engine. So an order placed in response to minute m first meets minute m + 1,
 * whichever symbol it is for, as at a real broker. The fill rules are SimulatedExecution's: a bar that
 * reaches the stop and anything favorable is a stop-out, a gap through a level fills at the open, a
 * halt has no bars and so fills nothing, and every fill is priced by the cost model (C.8), which
 * refuses a zero allowance. No fill is ever frictionless.
 *
 * At each close the broker ends the session: working day orders expire, and a position the engine left
 * open exits at its symbol's last close. The report lists both, since a day-trading run that needs the
 * forced exit has an engine bug.
 *
 * The adapter also raises the replay's own clock (ReplayEvents): a session starting, every minute
 * closing whether or not any symbol printed in it, and the close. An engine that acts on time, such as
 * cancelling entries at 15:30 or flattening at 15:50, listens to that. A live engine uses a wall clock
 * for the same thing, and a thin name that skips a minute must not make either one late.
 *
 * Nothing in it is random, so there is no seed to set: the same store, range, and engine give the
 * same events, whatever the database's timing. Reads of the store run in parallel, but every call the
 * engine makes is answered in the order it was made, and the replay waits for all of them before the
 * next minute. That holds as long as the engine waits on nothing but the adapter and plain promises
 * between bars. A timer or a network call of its own would let the replay run ahead of it.
 *
 * The symbols that replay each session are the universe plus whatever the engine subscribes to, asks a
 * snapshot of, or trades. Picking the universe without look-ahead is the caller's job: an in-play list
 * ranked on opening volume is only known at 09:35, and the engine must not act on it before then.
 *
 * The bad-tick filter (H.8) is not built in: wrap the source in withBadTickFilter to put it between the
 * store and the broker. Replayed without it, a single bad print fills a resting stop entry and, in the
 * same bar, a target.
 *
 * Quotes are modeled. The store has bars only, so a bar's quote is its close with the cost model's
 * spread around it: the quote the broker fills against, and the one a cost gate should see.
 */

import type {
  Bar,
  Fixed,
  IsoTimestamp,
  NewsItem,
  Order,
  Quote,
  RunMode,
  ScreenerKind,
  ScreenerRow,
  SessionDate,
  SymbolBar,
  SymbolSnapshot,
} from "@trader/contracts";
import { type CostModelConfig, quoteFromReference } from "@trader/core";
import {
  type Adapter,
  AdapterError,
  type DataAdapter,
  type DataEvents,
  type HistoricalBarsRequest,
  type NewsRequest,
} from "./adapter.js";
import type { SessionClock } from "./clock.js";
import { Emitter } from "./events.js";
import { type ReplaySource, type SessionHours, type StoredBar, restate } from "./replaySource.js";
import { SimulatedExecution } from "./simulatedExecution.js";

const MINUTE = 60_000;
/** How far back to look for the session before this one. Covers the longest exchange closure since 2001. */
const PREVIOUS_SESSION_LOOKBACK = 14 * 24 * 60 * MINUTE;

/** The symbols to replay: the same every session, or chosen per session. */
export type Universe =
  readonly string[] | ((hours: SessionHours) => readonly string[] | Promise<readonly string[]>);

export interface BacktestAdapterConfig {
  readonly source: ReplaySource;
  /** First and last session to replay, inclusive. */
  readonly from: SessionDate;
  readonly to: SessionDate;
  /** Symbols whose bars reach the broker each session, before anything the engine adds. */
  readonly universe: Universe;
  readonly costModel: CostModelConfig;
  readonly startingCash: Fixed;
}

/** The replay's clock. Raised by BacktestAdapter, in this order, around every session. */
export type ReplayEvents = {
  /** A session's bars are loaded and its first minute is next. `minutes` is its length: 390, or 210 on a half day. */
  sessionStart: { readonly hours: SessionHours; readonly minutes: number };
  /**
   * A minute has closed: its bars reached the broker and went out as events. Raised for every minute
   * of the session, bars or none, before the replay waits on the engine.
   */
  minute: { readonly session: SessionDate; readonly minuteOfSession: number; readonly minutes: number };
  /** The close: what the broker closed and expired there (SimulatedExecution.endSession). */
  sessionEnd: {
    readonly hours: SessionHours;
    readonly closed: readonly Order[];
    readonly expired: readonly Order[];
  };
};

export interface MissingBars {
  readonly session: SessionDate;
  readonly symbol: string;
}

export interface ReplayReport {
  readonly sessions: number;
  /** Bars handed to the broker. */
  readonly bars: number;
  /** Exits the broker filled at a close because the engine left the position open into it. */
  readonly closedAtSessionEnd: readonly Order[];
  /** Entries still working at a close, expired there. */
  readonly expiredEntries: readonly Order[];
  /**
   * Symbols the engine brought in (a subscription, a snapshot, an order) whose minute bars were never
   * loaded for that month. They replayed as silence, and an order on one could not fill.
   */
  readonly unloaded: readonly MissingBars[];
}

/** Bars read for a session, not yet put into the replay. */
interface Fetched {
  readonly symbols: readonly string[];
  readonly loaded: ReadonlySet<string>;
  readonly bars: readonly SymbolBar[];
}

/** A clock over the replay's calendar: minute m is its session's open plus m minutes, in UTC. */
export function calendarClock(sessions: readonly SessionHours[]): SessionClock {
  const opens = new Map(sessions.map((hours) => [hours.session, hours.openAt]));
  return (session, minuteOfSession) => {
    const open = opens.get(session);
    if (open === undefined) {
      throw new AdapterError("UNSUPPORTED", `${session} is not a session of this replay`, false);
    }
    return new Date(open + minuteOfSession * MINUTE).toISOString();
  };
}

/** Code-unit order, the same under every locale. Symbols never compare equal: each is listed once. */
function bySymbol(a: string, b: string): number {
  return a < b ? -1 : 1;
}

/** The day so far, as a live snapshot's daily bar shows it. */
function dayOf(bars: readonly SymbolBar[], closed: boolean): Bar {
  const first = bars[0] as SymbolBar;
  const last = bars.at(-1) as SymbolBar;
  let high = first.high;
  let low = first.low;
  let volume = 0;
  for (const bar of bars) {
    high = bar.high > high ? bar.high : high;
    low = bar.low < low ? bar.low : low;
    volume += bar.volume;
  }
  return {
    session: first.session,
    minuteOfSession: 0,
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
    vwap: null,
    closed,
  };
}

function withoutSymbol(bar: SymbolBar): Bar {
  const { symbol: _symbol, ...rest } = bar;
  return rest;
}

/**
 * The data half of the backtest. Everything it answers is point in time: nothing after the last
 * minute replayed, and a lookback restated for splits as of the session being replayed.
 *
 * beginSession, advance, deliver, endSession, require, and drain are the replay loop's, not the
 * engine's.
 */
export class BacktestDataAdapter extends Emitter<DataEvents> implements DataAdapter {
  readonly #source: ReplaySource;
  readonly #costModel: CostModelConfig;
  readonly #clock: SessionClock;
  readonly #subscribed = new Set<string>();
  /** Calls the engine made that have not settled. The replay waits for them. */
  readonly #pending = new Set<Promise<unknown>>();
  /** Settles after the last call made so far has finished. */
  #tail: Promise<unknown> = Promise.resolve();
  readonly #unloaded: MissingBars[] = [];
  /** This session's bars of every symbol replaying, oldest first. */
  readonly #bars = new Map<string, readonly SymbolBar[]>();
  /** Each symbol's next bar to replay, as an index into its bars. */
  readonly #next = new Map<string, number>();
  /** Symbols whose bars are being read for this session and not yet put in. */
  readonly #fetching = new Set<string>();
  readonly #factors = new Map<string, Promise<number | null>>();
  readonly #previousDay = new Map<string, Promise<Bar | null>>();
  /** Symbols replaying this session in code-unit order, so a minute's bars go out in the same order every run. */
  #order: string[] = [];
  #session: SessionHours;
  #minute = -1;
  /** Between beginSession and endSession. */
  #live = false;
  #ended = false;
  connected = false;

  constructor(source: ReplaySource, costModel: CostModelConfig, clock: SessionClock, first: SessionHours) {
    super();
    this.#source = source;
    this.#costModel = costModel;
    this.#clock = clock;
    this.#session = first;
  }

  /** Epoch milliseconds up to which the market is known: the end of the last minute replayed. */
  get knownThrough(): number {
    return this.#ended ? this.#session.closeAt : this.#session.openAt + (this.#minute + 1) * MINUTE;
  }

  /** Symbols the engine brought in whose minute bars were never loaded, in the order found. */
  get unloaded(): readonly MissingBars[] {
    return this.#unloaded;
  }

  subscribe(symbols: readonly string[]): Promise<void> {
    if (!this.connected) {
      return Promise.reject(new AdapterError("NOT_CONNECTED", "backtest adapter is not connected"));
    }
    for (const symbol of symbols) {
      this.#subscribed.add(symbol);
    }
    return this.#sequence(this.#fetch(symbols), (fetched) => {
      this.#apply(fetched);
    });
  }

  unsubscribe(symbols: readonly string[]): Promise<void> {
    for (const symbol of symbols) {
      this.#subscribed.delete(symbol);
    }
    return Promise.resolve();
  }

  subscriptions(): readonly string[] {
    return [...this.#subscribed].sort(bySymbol);
  }

  /**
   * Closed bars in the range, as far as the replay has reached: `to` is cut back to the last minute
   * replayed, and a daily bar appears once its session has closed. Split-restated as of the session
   * being replayed, so a lookback across a split is on one share basis, as Alpaca's split adjustment
   * shows it on that day. Dividends are not adjusted.
   */
  getHistoricalBars(request: HistoricalBarsRequest): Promise<readonly SymbolBar[]> {
    return this.#sequence(this.#history(request), (bars) => bars);
  }

  /**
   * What the replay has shown of each symbol today: its last minute bar and modeled quote, the day so
   * far, and the previous session's daily bar. A symbol with no bar yet this session is omitted.
   */
  getSnapshots(symbols: readonly string[]): Promise<readonly SymbolSnapshot[]> {
    const unique = [...new Set(symbols)];
    const reads = Promise.all([
      this.#fetch(unique),
      Promise.all(unique.map((symbol) => this.#previousDailyBar(symbol))),
    ]);
    return this.#sequence(reads, ([fetched, previous]) => {
      this.#apply(fetched);
      const asOf = new Date(this.knownThrough).toISOString();
      return unique.flatMap((symbol, i): SymbolSnapshot[] => {
        const today = this.#replayed(symbol);
        const last = today.at(-1);
        if (last === undefined) {
          return [];
        }
        return [
          {
            symbol,
            asOf,
            lastTrade: { price: last.close, at: this.#clock(last.session, last.minuteOfSession) },
            quote: this.#quote(last.close),
            minuteBar: withoutSymbol(last),
            dailyBar: dayOf(today, this.#ended),
            previousDailyBar: previous[i] as Bar | null,
          },
        ];
      });
    });
  }

  /**
   * Ranks what is replaying by volume so far this session. There is no stored screener history, so the
   * kind is ignored and the ranking only covers symbols already in the replay.
   */
  getScreener(_kind: ScreenerKind, limit: number): Promise<readonly ScreenerRow[]> {
    return this.#sequence(Promise.resolve(), () =>
      this.#order
        .flatMap((symbol) => {
          const today = this.#replayed(symbol);
          const last = today.at(-1);
          return last === undefined
            ? []
            : [{ symbol, volume: today.reduce((sum, bar) => sum + bar.volume, 0), lastPrice: last.close }];
        })
        .sort((a, b) => b.volume - a.volume || bySymbol(a.symbol, b.symbol))
        .slice(0, limit)
        .map((row, i): ScreenerRow => ({ ...row, rank: i + 1, changeBps: null })),
    );
  }

  /** No news is stored yet (the archiver, EPIC-B), so there is none to replay. */
  getNews(_request: NewsRequest): Promise<readonly NewsItem[]> {
    return this.#sequence(Promise.resolve(), () => []);
  }

  /** Starts a session and loads these symbols' bars. Returns the ones never loaded for its month. */
  async beginSession(hours: SessionHours, symbols: readonly string[]): Promise<readonly string[]> {
    this.#session = hours;
    this.#minute = -1;
    this.#live = true;
    this.#ended = false;
    this.#bars.clear();
    this.#next.clear();
    this.#factors.clear();
    this.#previousDay.clear();
    this.#order = [];
    return this.#apply(await this.#fetch(symbols));
  }

  /** Moves to a minute and returns its bars, one per symbol that traded in it, in symbol order. */
  advance(minute: number): SymbolBar[] {
    this.#minute = minute;
    const batch: SymbolBar[] = [];
    for (const symbol of this.#order) {
      const i = this.#next.get(symbol) as number;
      const bar = (this.#bars.get(symbol) as readonly SymbolBar[])[i];
      if (bar !== undefined && bar.minuteOfSession === minute) {
        batch.push(bar);
        this.#next.set(symbol, i + 1);
      }
    }
    return batch;
  }

  /**
   * Raises a bar event and then its quote for each subscribed symbol in the minute's bars. A
   * subscription changed while the minute is going out applies from the next one.
   */
  deliver(batch: readonly SymbolBar[]): void {
    const at = new Date(this.knownThrough).toISOString();
    const subscribed = new Set(this.#subscribed);
    for (const bar of batch) {
      if (subscribed.has(bar.symbol)) {
        this.emit("bar", bar);
        this.emit("quote", { symbol: bar.symbol, quote: this.#quote(bar.close), at });
      }
    }
  }

  endSession(): void {
    this.#live = false;
    this.#ended = true;
  }

  /** Brings a symbol into the replay from the next minute on, so an order on it meets its bars. */
  require(symbol: string): void {
    if (this.#live && !this.#bars.has(symbol) && !this.#fetching.has(symbol)) {
      void this.#sequence(this.#fetch([symbol]), (fetched) => {
        this.#apply(fetched);
      });
    }
  }

  /**
   * Waits until the engine has nothing left to do: every microtask run, and every call it made to this
   * adapter answered, including calls made by the code that ran when earlier ones were.
   */
  async drain(): Promise<void> {
    for (;;) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.#pending.size === 0) {
        return;
      }
      await Promise.allSettled([...this.#pending]);
    }
  }

  /**
   * Answers one call from the engine. `reads` runs now, alongside any other call's; `finish` runs in
   * call order, once every call made before this one has finished. The store may answer in any order,
   * but the engine hears back in the order it asked, and only a finish changes the replay's state. That
   * is what makes a replay independent of the database's timing.
   */
  #sequence<T, R>(reads: Promise<T>, finish: (value: T) => R): Promise<R> {
    const previous = this.#tail;
    const result = reads.then(
      (value) => previous.then(() => finish(value)),
      (error: unknown) =>
        previous.then(() => {
          throw error;
        }),
    );
    const settled = (): void => {
      this.#pending.delete(result);
    };
    this.#pending.add(result);
    this.#tail = result.then(settled, settled);
    return result;
  }

  /**
   * Reads this session's bars for symbols not replaying yet. Only reads: #apply puts them in. Outside
   * a session it reads nothing, since the next session loads what it needs.
   */
  #fetch(symbols: readonly string[]): Promise<Fetched> {
    const fresh = this.#live
      ? [...new Set(symbols)].filter((symbol) => !this.#bars.has(symbol) && !this.#fetching.has(symbol))
      : [];
    if (fresh.length === 0) {
      return Promise.resolve({ symbols: [], loaded: new Set(), bars: [] });
    }
    for (const symbol of fresh) {
      this.#fetching.add(symbol);
    }
    return Promise.all([
      this.#source.loaded(this.#session.session, fresh),
      this.#source.sessionBars(this.#session, fresh),
    ]).then(
      ([loaded, bars]) => ({ symbols: fresh, loaded, bars }),
      (error: unknown) => {
        for (const symbol of fresh) {
          this.#fetching.delete(symbol);
        }
        throw error;
      },
    );
  }

  /**
   * Puts fetched bars into the replay. Bars the replay has already passed are history, not replay, so
   * a symbol joins from the next minute. Returns the symbols whose month was never loaded; they replay
   * as silence.
   */
  #apply(fetched: Fetched): readonly string[] {
    const lists = new Map(fetched.symbols.map((symbol) => [symbol, [] as SymbolBar[]]));
    for (const bar of fetched.bars) {
      lists.get(bar.symbol)?.push(bar);
    }
    for (const [symbol, list] of lists) {
      list.sort((a, b) => a.minuteOfSession - b.minuteOfSession);
      const next = list.findIndex((bar) => bar.minuteOfSession > this.#minute);
      this.#bars.set(symbol, list);
      this.#next.set(symbol, next === -1 ? list.length : next);
      this.#fetching.delete(symbol);
    }
    this.#order = [...this.#bars.keys()].sort(bySymbol);
    const missing = fetched.symbols.filter((symbol) => !fetched.loaded.has(symbol));
    for (const symbol of missing) {
      this.#unloaded.push({ session: this.#session.session, symbol });
    }
    return missing;
  }

  async #history(request: HistoricalBarsRequest): Promise<readonly SymbolBar[]> {
    const from = Date.parse(request.from);
    const to = Math.min(Date.parse(request.to), this.knownThrough);
    if (!(from < to)) {
      return [];
    }
    const range = [new Date(from).toISOString(), new Date(to).toISOString()] as const;
    const asOf = await this.#factor(request.symbol);
    if (request.timeframe === "1Min") {
      const rows = await this.#source.minuteBars(request.symbol, ...range);
      return (await this.#withFactors(request.symbol, rows)).map((row) => restate(row, asOf));
    }
    const session = this.#session.session;
    const rows = await this.#source.dailyBars(request.symbol, ...range);
    return (await this.#withFactors(request.symbol, rows))
      .filter((row) => row.session !== session || this.#ended)
      .map((row) => restate(row, asOf));
  }

  /** The bars of a symbol the replay has already shown this session. */
  #replayed(symbol: string): readonly SymbolBar[] {
    return (this.#bars.get(symbol) ?? []).slice(0, this.#next.get(symbol) ?? 0);
  }

  #previousDailyBar(symbol: string): Promise<Bar | null> {
    let cached = this.#previousDay.get(symbol);
    if (cached === undefined) {
      const open = this.#session.openAt;
      cached = Promise.all([
        this.#source.dailyBars(
          symbol,
          new Date(open - PREVIOUS_SESSION_LOOKBACK).toISOString(),
          new Date(open).toISOString(),
        ),
        this.#factor(symbol),
      ]).then(async ([rows, asOf]) => {
        const last = (await this.#withFactors(symbol, rows.slice(-1)))[0];
        return last === undefined ? null : withoutSymbol(restate(last, asOf));
      });
      this.#previousDay.set(symbol, cached);
    }
    return cached;
  }

  /**
   * Gives a bar whose session has no split factor the factor of the latest session before it that has
   * one. Factors only change on a split, so that is its basis. Never a later one: a split between the
   * two would put the bar on the wrong side of it.
   */
  async #withFactors(symbol: string, rows: readonly StoredBar[]): Promise<readonly StoredBar[]> {
    const gaps = [...new Set(rows.filter((row) => row.splitFactor === null).map((row) => row.session))];
    const found = new Map(
      await Promise.all(
        gaps.map(async (session) => [session, await this.#source.splitFactor(symbol, session)] as const),
      ),
    );
    return rows.map((row) =>
      row.splitFactor === null ? { ...row, splitFactor: found.get(row.session) ?? null } : row,
    );
  }

  /** The symbol's split factor on the session being replayed: the basis every lookback is put on. */
  #factor(symbol: string): Promise<number | null> {
    let cached = this.#factors.get(symbol);
    if (cached === undefined) {
      cached = this.#source.splitFactor(symbol, this.#session.session);
      this.#factors.set(symbol, cached);
    }
    return cached;
  }

  #quote(close: Fixed): Quote {
    return quoteFromReference(close, this.#costModel.spread);
  }
}

export class BacktestAdapter extends Emitter<ReplayEvents> implements Adapter {
  readonly mode: RunMode = "backtest";
  readonly data: BacktestDataAdapter;
  readonly execution: SimulatedExecution;
  /** The sessions this backtest replays, oldest first. */
  readonly sessions: readonly SessionHours[];
  readonly #universe: Universe;
  #started = false;

  /** Reads the calendar for the range and builds the adapter. Throws when the range holds no session. */
  static async create(config: BacktestAdapterConfig): Promise<BacktestAdapter> {
    if (!(config.from <= config.to)) {
      throw new AdapterError("UNSUPPORTED", `from ${config.from} is after to ${config.to}`, false);
    }
    const sessions = await config.source.sessions(config.from, config.to);
    if (sessions.length === 0) {
      throw new AdapterError("UNSUPPORTED", `no sessions from ${config.from} to ${config.to}`, false);
    }
    return new BacktestAdapter(config, sessions);
  }

  private constructor(config: BacktestAdapterConfig, sessions: readonly SessionHours[]) {
    super();
    const first = sessions[0] as SessionHours;
    const clock = calendarClock(sessions);
    this.sessions = sessions;
    this.#universe = config.universe;
    this.execution = new SimulatedExecution({
      costModel: config.costModel,
      startingCash: config.startingCash,
      clock,
      start: { session: first.session, minuteOfSession: 0 },
    });
    this.data = new BacktestDataAdapter(config.source, config.costModel, clock, first);
    // An order on a symbol that is not replaying still has to meet that symbol's bars.
    this.execution.on("orderUpdate", (order) => {
      this.data.require(order.symbol);
    });
  }

  connect(): Promise<void> {
    this.data.connected = true;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.data.connected = false;
    return Promise.resolve();
  }

  /** The instant of the last replayed bar, as the broker stamps orders. */
  get now(): IsoTimestamp {
    return this.execution.now;
  }

  /**
   * Replays every session, then reports. Once per adapter: the broker's account carries from session to
   * session, so a second pass would start where the first ended. Throws when a universe symbol has no
   * minute bars loaded for the session's month, since replaying it would look like a halt.
   */
  async replay(): Promise<ReplayReport> {
    if (!this.data.connected) {
      throw new AdapterError("NOT_CONNECTED", "backtest adapter is not connected");
    }
    if (this.#started) {
      throw new AdapterError("UNSUPPORTED", "a backtest adapter replays once", false);
    }
    this.#started = true;
    let bars = 0;
    const closed: Order[] = [];
    const expired: Order[] = [];
    for (const hours of this.sessions) {
      const universe = typeof this.#universe === "function" ? await this.#universe(hours) : this.#universe;
      const missing = await this.data.beginSession(hours, [
        ...universe,
        ...this.data.subscriptions(),
        ...this.execution.activeSymbols(),
      ]);
      const absent = missing.filter((symbol) => universe.includes(symbol));
      if (absent.length > 0) {
        throw new AdapterError(
          "UNSUPPORTED",
          `no minute bars loaded for ${absent.join(", ")} in ${hours.session.slice(0, 7)}`,
          false,
        );
      }
      const minutes = Math.round((hours.closeAt - hours.openAt) / MINUTE);
      this.emit("sessionStart", { hours, minutes });
      for (let minute = 0; minute < minutes; minute += 1) {
        const batch = this.data.advance(minute);
        for (const bar of batch) {
          this.execution.onBar(bar);
        }
        this.data.deliver(batch);
        this.emit("minute", { session: hours.session, minuteOfSession: minute, minutes });
        bars += batch.length;
        await this.data.drain();
      }
      const end = this.execution.endSession({ session: hours.session, minuteOfSession: minutes });
      this.data.endSession();
      closed.push(...end.closed);
      expired.push(...end.expired);
      this.emit("sessionEnd", { hours, closed: end.closed, expired: end.expired });
      await this.data.drain();
    }
    return {
      sessions: this.sessions.length,
      bars,
      closedAtSessionEnd: closed,
      expiredEntries: expired,
      unloaded: [...this.data.unloaded],
    };
  }
}
