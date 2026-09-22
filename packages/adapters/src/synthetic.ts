/**
 * The synthetic adapter: seeded sessions from the path generator, replayed into the simulated broker.
 *
 * Gives the property suite and the null model the real adapter interface, so the engine's own loop can
 * be driven over thousands of generated sessions without a broker or a feed. Each symbol has its own
 * path. replay() walks the bars of every symbol in time order, hands each to the broker first and then
 * to the engine as a bar event followed by a quote event, and lets the event loop drain before the next.
 * Whatever the engine submits in response rests until the next bar, exactly as at a real broker.
 * Unsubscribed symbols still trade at the broker but raise no events.
 *
 * Disconnects are not simulated yet. That wires in with the engine's reconnect handling.
 */

import type {
  Bar,
  Fixed,
  IsoTimestamp,
  NewsItem,
  Quote,
  RunMode,
  ScreenerKind,
  ScreenerRow,
  SymbolBar,
  SymbolSnapshot,
} from "@trader/contracts";
import { type CostModelConfig, type PathConfig, type SyntheticPath, generatePath } from "@trader/core";
import {
  type Adapter,
  AdapterError,
  type DataAdapter,
  type DataEvents,
  type HistoricalBarsRequest,
  type NewsRequest,
} from "./adapter.js";
import { type SessionClock, labelClock } from "./clock.js";
import { Emitter } from "./events.js";
import { SimulatedExecution } from "./simulatedExecution.js";

export interface SyntheticSymbol {
  readonly symbol: string;
  readonly path: Omit<PathConfig, "session">;
}

export interface SyntheticAdapterConfig {
  readonly session: string;
  readonly symbols: readonly SyntheticSymbol[];
  readonly costModel: CostModelConfig;
  readonly startingCash: Fixed;
  /** Defaults to the label clock. */
  readonly clock?: SessionClock;
}

interface Replayed {
  readonly bar: SymbolBar;
  readonly quote: Quote;
}

export class SyntheticDataAdapter extends Emitter<DataEvents> implements DataAdapter {
  readonly #subscribed = new Set<string>();
  readonly #paths = new Map<string, SyntheticPath>();
  readonly #latest = new Map<string, Replayed>();
  readonly #clock: SessionClock;
  connected = false;

  constructor(paths: ReadonlyMap<string, SyntheticPath>, clock: SessionClock) {
    super();
    this.#paths = new Map(paths);
    this.#clock = clock;
  }

  /** The generated paths, by symbol. */
  get paths(): ReadonlyMap<string, SyntheticPath> {
    return this.#paths;
  }

  subscribe(symbols: readonly string[]): Promise<void> {
    if (!this.connected) {
      return Promise.reject(new AdapterError("NOT_CONNECTED", "synthetic adapter is not connected"));
    }
    for (const symbol of symbols) {
      this.#subscribed.add(symbol);
    }
    return Promise.resolve();
  }

  unsubscribe(symbols: readonly string[]): Promise<void> {
    for (const symbol of symbols) {
      this.#subscribed.delete(symbol);
    }
    return Promise.resolve();
  }

  subscriptions(): readonly string[] {
    return [...this.#subscribed].sort();
  }

  /** Bars of the symbol whose labeled instant falls in the range. Daily bars are not generated. */
  getHistoricalBars(request: HistoricalBarsRequest): Promise<readonly SymbolBar[]> {
    if (request.timeframe !== "1Min") {
      return Promise.reject(
        new AdapterError("UNSUPPORTED", "the synthetic feed has minute bars only", false),
      );
    }
    const path = this.#paths.get(request.symbol);
    if (path === undefined) {
      return Promise.resolve([]);
    }
    return Promise.resolve(
      path.bars
        .filter((bar) => {
          const at = this.#clock(bar.session, bar.minuteOfSession);
          return at >= request.from && at < request.to;
        })
        .map((bar) => ({ symbol: request.symbol, ...bar })),
    );
  }

  /** What has been replayed so far. A symbol with no bar yet is omitted, as a feed that does not know it would be. */
  getSnapshots(symbols: readonly string[]): Promise<readonly SymbolSnapshot[]> {
    const snapshots: SymbolSnapshot[] = [];
    for (const symbol of symbols) {
      const latest = this.#latest.get(symbol);
      if (latest === undefined) {
        continue;
      }
      const at = this.#clock(latest.bar.session, latest.bar.minuteOfSession);
      snapshots.push({
        symbol,
        asOf: at,
        lastTrade: { price: latest.bar.close, at },
        quote: latest.quote,
        minuteBar: stripSymbol(latest.bar),
        dailyBar: null,
        previousDailyBar: null,
      });
    }
    return Promise.resolve(snapshots);
  }

  /** Ranks every symbol by the volume replayed so far, so the ranking is real but the kind is ignored. */
  getScreener(_kind: ScreenerKind, limit: number): Promise<readonly ScreenerRow[]> {
    const rows = [...this.#latest.entries()]
      .map(([symbol, latest]) => {
        const path = this.#paths.get(symbol) as SyntheticPath;
        const volume = path.bars
          .filter((bar) => bar.minuteOfSession <= latest.bar.minuteOfSession)
          .reduce((sum, bar) => sum + bar.volume, 0);
        return { symbol, volume, lastPrice: latest.bar.close };
      })
      .sort((a, b) => b.volume - a.volume || a.symbol.localeCompare(b.symbol))
      .slice(0, limit)
      .map((row, i): ScreenerRow => ({ ...row, rank: i + 1, changeBps: null }));
    return Promise.resolve(rows);
  }

  getNews(_request: NewsRequest): Promise<readonly NewsItem[]> {
    return Promise.resolve([]);
  }

  /** Records a replayed bar and raises its events when the symbol is subscribed. */
  deliver(bar: SymbolBar, quote: Quote): void {
    this.#latest.set(bar.symbol, { bar, quote });
    if (!this.#subscribed.has(bar.symbol)) {
      return;
    }
    this.emit("bar", bar);
    this.emit("quote", { symbol: bar.symbol, quote, at: this.#clock(bar.session, bar.minuteOfSession) });
  }
}

function stripSymbol(bar: SymbolBar): Bar {
  const { symbol: _symbol, ...rest } = bar;
  return rest;
}

export class SyntheticAdapter implements Adapter {
  readonly mode: RunMode = "backtest";
  readonly data: SyntheticDataAdapter;
  readonly execution: SimulatedExecution;
  readonly #timeline: readonly Replayed[];
  #cursor = 0;

  constructor(config: SyntheticAdapterConfig) {
    const clock = config.clock ?? labelClock;
    const paths = new Map<string, SyntheticPath>();
    const timeline: Replayed[] = [];
    for (const { symbol, path } of config.symbols) {
      if (paths.has(symbol)) {
        throw new AdapterError("UNSUPPORTED", `symbol ${symbol} is listed twice`, false);
      }
      const generated = generatePath({ ...path, session: config.session });
      paths.set(symbol, generated);
      generated.bars.forEach((bar, i) => {
        timeline.push({ bar: { symbol, ...bar }, quote: generated.quotes[i] as Quote });
      });
    }
    // Time order, then symbol order for the same minute, so a replay is deterministic.
    timeline.sort(
      (a, b) => a.bar.minuteOfSession - b.bar.minuteOfSession || a.bar.symbol.localeCompare(b.bar.symbol),
    );
    this.#timeline = timeline;
    this.data = new SyntheticDataAdapter(paths, clock);
    this.execution = new SimulatedExecution({
      costModel: config.costModel,
      startingCash: config.startingCash,
      clock,
      start: { session: config.session, minuteOfSession: 0 },
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

  /** Bars left to replay. */
  get remaining(): number {
    return this.#timeline.length - this.#cursor;
  }

  /** Replays one bar: the broker sees it, then the engine. False once the session is over. */
  step(): boolean {
    const next = this.#timeline[this.#cursor];
    if (next === undefined) {
      return false;
    }
    this.#cursor += 1;
    this.execution.onBar(next.bar);
    this.data.deliver(next.bar, next.quote);
    return true;
  }

  /**
   * Replays every remaining bar. After each one the event loop drains, so an async handler's work
   * lands before the next bar as long as it waits on nothing but promises. The engine acts between bars.
   */
  async replay(): Promise<void> {
    while (this.step()) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** The instant of the last replayed bar's close. */
  get now(): IsoTimestamp {
    return this.execution.now;
  }
}
