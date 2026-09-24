/**
 * A study source over bars held in memory, the counterpart of MemoryReplaySource. For tests, and for
 * running the whole runner on hand-made or synthetic sessions.
 */

import type { StoredBar } from "@trader/adapters";
import type { Bar, SymbolBar } from "@trader/contracts";
import type { OpeningVolume, StudySource, WideWickSession } from "./universe.js";

export interface MemoryStudySourceData {
  readonly dailyBars: readonly StoredBar[];
  readonly minuteBars: readonly SymbolBar[];
  /** Symbol-months ("SYM|2026-01") with complete minute bars. Default: every one with a minute bar. */
  readonly loaded?: readonly string[];
}

export class MemoryStudySource implements StudySource {
  readonly #daily: readonly StoredBar[];
  readonly #minute: readonly SymbolBar[];
  readonly #loaded: readonly string[];
  /** Every call made, in order, as "method month". */
  readonly calls: string[] = [];

  constructor(data: MemoryStudySourceData) {
    this.#daily = [...data.dailyBars].sort((a, b) =>
      a.session === b.session ? (a.symbol < b.symbol ? -1 : 1) : a.session < b.session ? -1 : 1,
    );
    this.#minute = data.minuteBars;
    this.#loaded = data.loaded ?? [
      ...new Set(data.minuteBars.map((bar) => `${bar.symbol}|${bar.session.slice(0, 7)}`)),
    ];
  }

  dailyBars(month: string): Promise<readonly StoredBar[]> {
    this.calls.push(`dailyBars ${month}`);
    return Promise.resolve(this.#daily.filter((bar) => bar.session.startsWith(month)));
  }

  openingVolumes(month: string, minutes: number): Promise<readonly OpeningVolume[]> {
    this.calls.push(`openingVolumes ${month}`);
    const sums = new Map<string, OpeningVolume>();
    for (const bar of this.#minute) {
      if (!bar.session.startsWith(month) || bar.minuteOfSession >= minutes) {
        continue;
      }
      const key = `${bar.symbol}|${bar.session}`;
      const volume = (sums.get(key)?.volume ?? 0) + bar.volume;
      sums.set(key, { symbol: bar.symbol, session: bar.session, volume });
    }
    return Promise.resolve([...sums.values()]);
  }

  wideWickSessions(month: string): Promise<readonly WideWickSession[]> {
    this.calls.push(`wideWickSessions ${month}`);
    const counts = new Map<string, WideWickSession>();
    for (const bar of this.#minute) {
      const wide =
        bar.high > Math.max(bar.open, bar.close) * 1.09 || bar.low < Math.min(bar.open, bar.close) * 0.91;
      if (!bar.session.startsWith(month) || !wide) {
        continue;
      }
      const key = `${bar.symbol}|${bar.session}`;
      counts.set(key, {
        symbol: bar.symbol,
        session: bar.session,
        wideBars: (counts.get(key)?.wideBars ?? 0) + 1,
      });
    }
    return Promise.resolve([...counts.values()]);
  }

  sessionMinuteBars(symbol: string, session: string): Promise<readonly Bar[]> {
    return Promise.resolve(
      this.#minute
        .filter((bar) => bar.symbol === symbol && bar.session === session)
        .sort((a, b) => a.minuteOfSession - b.minuteOfSession),
    );
  }

  minuteMonths(): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    const months = new Map<string, Set<string>>();
    for (const key of this.#loaded) {
      const [symbol = "", month = ""] = key.split("|");
      (months.get(symbol) ?? months.set(symbol, new Set()).get(symbol))?.add(month);
    }
    return Promise.resolve(months);
  }
}
