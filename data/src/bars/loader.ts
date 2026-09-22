/**
 * Loads bars for a set of symbol-months, resumably.
 *
 * The unit of work is a symbol-month, and a checkpoint marks each one done. A run looks up the complete
 * checkpoints, fetches only what is missing, and writes every job's bars together with its checkpoints,
 * so stopping at any point loses at most the jobs in flight. A month that has not ended yet is written
 * as partial and fetched again next time.
 *
 * Daily bars go in jobs of many symbols over their whole span, since a symbol's decade of daily bars is
 * one page. Each daily job reads the span twice, as traded and split-adjusted, and keeps the raw bars
 * with the ratio of the two volumes as the split factor. Minute bars go one month at a time for a
 * handful of symbols, since a liquid name's month is already about a page. Either way Alpaca pages at 10,000 bars, and the client's rate limiter paces the
 * requests, so the job size mostly decides how much is lost to a crash.
 *
 * A job that fails is reported and left pending; the rest carry on. Five failures in a row stop the
 * run, since that is an outage or a bad key rather than a bad month.
 */

import type { AlpacaBar } from "@trader/adapters/alpaca";
import { type DailyRow, type Dropped, type MinuteRow, toDailyRow, toMinuteRow } from "./convert.js";
import { type BarSource, InvalidSymbolError, type Timeframe } from "./source.js";
import type { BarStore, Checkpoint } from "./store.js";
import { type SessionTimes, monthOf, newYorkDate, nextMonth } from "./time.js";

export interface Unit {
  readonly symbol: string;
  /** First day of the month. */
  readonly month: string;
}

export interface Job {
  readonly symbols: readonly string[];
  /** The months each symbol still needs, keyed "SYMBOL|YYYY-MM-01". Bars outside them are skipped. */
  readonly units: ReadonlySet<string>;
  /** First month of the span, and the month after the last. */
  readonly fromMonth: string;
  readonly untilMonth: string;
}

/** Every month for every symbol, without listing each pair: a daily load of the whole ticker list. */
export interface UnitGrid {
  readonly symbols: readonly string[];
  readonly months: readonly string[];
}

export interface LoadOptions {
  readonly timeframe: Timeframe;
  /** What to load: explicit symbol-months, or every month of every symbol. */
  readonly units: readonly Unit[] | UnitGrid;
  /** Jobs in flight at once. The rate limiter caps the request rate whatever this is. */
  readonly concurrency?: number;
  /** Symbols per job. */
  readonly batchSize?: number;
  /**
   * Symbols planned at a time. A pass holds only its own symbols' months and checkpoints, so 40,000
   * tickers times ten years of months never sit in memory at once.
   */
  readonly symbolsPerPass?: number;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export interface LoadResult {
  /** Symbol-months already complete before the run. */
  readonly skipped: number;
  readonly jobs: number;
  readonly failedJobs: number;
  readonly rows: number;
  readonly dropped: Readonly<Record<Dropped, number>>;
  /** True when the run stopped early on repeated failures. */
  readonly aborted: boolean;
}

const key = (symbol: string, month: string): string => `${symbol}|${month}`;

/** Groups pending units into jobs. Pure, so the plan can be tested and printed before anything runs. */
export function planJobs(timeframe: Timeframe, pending: readonly Unit[], batchSize: number): Job[] {
  const jobs: Job[] = [];
  const push = (group: Array<{ symbol: string; months: string[] }>, fromMonth: string, lastMonth: string) => {
    for (let i = 0; i < group.length; i += batchSize) {
      const slice = group.slice(i, i + batchSize);
      jobs.push({
        symbols: slice.map((entry) => entry.symbol),
        units: new Set(slice.flatMap((entry) => entry.months.map((month) => key(entry.symbol, month)))),
        fromMonth,
        untilMonth: nextMonth(lastMonth),
      });
    }
  };

  if (timeframe === "1Day") {
    const bySymbol = new Map<string, string[]>();
    for (const unit of pending) {
      (bySymbol.get(unit.symbol) ?? bySymbol.set(unit.symbol, []).get(unit.symbol))?.push(unit.month);
    }
    const bySpan = new Map<string, Array<{ symbol: string; months: string[] }>>();
    for (const [symbol, months] of [...bySymbol].sort(([a], [b]) => a.localeCompare(b))) {
      months.sort();
      const span = `${months[0] ?? ""}|${months.at(-1) ?? ""}`;
      (bySpan.get(span) ?? bySpan.set(span, []).get(span))?.push({ symbol, months });
    }
    for (const [span, group] of bySpan) {
      const [first = "", last = ""] = span.split("|");
      push(group, first, last);
    }
  } else {
    const byMonth = new Map<string, string[]>();
    for (const unit of pending) {
      (byMonth.get(unit.month) ?? byMonth.set(unit.month, []).get(unit.month))?.push(unit.symbol);
    }
    for (const [month, symbols] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
      push(
        symbols.sort().map((symbol) => ({ symbol, months: [month] })),
        month,
        month,
      );
    }
  }
  return jobs;
}

export class BarLoader {
  readonly #source: BarSource;
  readonly #store: BarStore;

  constructor(source: BarSource, store: BarStore) {
    this.#source = source;
    this.#store = store;
  }

  async load(options: LoadOptions): Promise<LoadResult> {
    const { timeframe } = options;
    const now = options.now ?? (() => new Date());
    const log = options.log ?? (() => undefined);
    const concurrency = options.concurrency ?? 4;
    const batchSize = options.batchSize ?? (timeframe === "1Day" ? 50 : 8);
    const perPass = options.symbolsPerPass ?? 2_000;
    const dropped: Record<Dropped, number> = { outsideSession: 0, invalid: 0 };
    const result = { skipped: 0, jobs: 0, failedJobs: 0, rows: 0, dropped, aborted: false };

    // Each symbol's months, either from the grid or grouped from the list.
    const grid = "symbols" in options.units ? options.units : null;
    const bySymbol = new Map<string, Set<string>>();
    if (grid === null) {
      for (const unit of options.units as readonly Unit[]) {
        (bySymbol.get(unit.symbol) ?? bySymbol.set(unit.symbol, new Set()).get(unit.symbol))?.add(unit.month);
      }
    }
    const symbols = grid === null ? [...bySymbol.keys()].sort() : [...new Set(grid.symbols)].sort();
    const allMonths =
      grid === null ? [...new Set([...bySymbol.values()].flatMap((m) => [...m]))] : [...grid.months];
    allMonths.sort();
    const firstMonth = allMonths[0];
    const lastMonth = allMonths.at(-1);
    if (firstMonth === undefined || lastMonth === undefined || symbols.length === 0) {
      return result;
    }
    const lastDay = new Date(Date.parse(`${nextMonth(lastMonth)}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const sessions = await this.#store.sessions(firstMonth, lastDay);
    if (sessions.size === 0) {
      throw new Error(`no market sessions stored for ${firstMonth}..${lastDay}: run "bars calendar" first`);
    }

    const passes = Math.ceil(symbols.length / perPass);
    const started = Date.now();
    let consecutiveFailures = 0;
    for (let pass = 0; pass < passes && !result.aborted; pass += 1) {
      const passSymbols = symbols.slice(pass * perPass, (pass + 1) * perPass);
      const complete = await this.#store.completed(timeframe, firstMonth, lastMonth, passSymbols);
      const units: Unit[] = passSymbols.flatMap((symbol) =>
        [...(grid === null ? (bySymbol.get(symbol) ?? []) : grid.months)].map((month) => ({ symbol, month })),
      );
      const pending = units.filter((unit) => !complete.has(key(unit.symbol, unit.month)));
      const jobs = planJobs(timeframe, pending, batchSize);
      result.skipped += units.length - pending.length;
      result.jobs += jobs.length;
      log(
        `${timeframe} pass ${String(pass + 1)}/${String(passes)}: ${String(units.length)} symbol-months, ` +
          `${String(units.length - pending.length)} already complete, ${String(jobs.length)} jobs`,
      );

      let next = 0;
      let finished = 0;
      const worker = async (): Promise<void> => {
        while (!result.aborted && next < jobs.length) {
          const job = jobs[next] as Job;
          next += 1;
          try {
            const { rows, rejected } = await this.#run(timeframe, job, sessions, now(), dropped);
            result.rows += rows;
            if (rejected.length > 0) {
              log(
                `${timeframe} ${job.fromMonth.slice(0, 7)}: Alpaca does not know ${rejected.join(", ")}, marked empty`,
              );
            }
            finished += 1;
            const done = (pass + finished / jobs.length) / passes;
            const eta = Math.round(((Date.now() - started) * (1 - done)) / done / 60_000);
            const who =
              job.symbols.length === 1 ? (job.symbols[0] ?? "") : `${String(job.symbols.length)} symbols`;
            log(
              `${timeframe} ${job.fromMonth.slice(0, 7)} ${who}: ${String(rows)} rows ` +
                `(pass ${String(pass + 1)}/${String(passes)}, job ${String(finished)}/${String(jobs.length)}, ~${String(eta)} min left)`,
            );
            consecutiveFailures = 0;
          } catch (error) {
            result.failedJobs += 1;
            consecutiveFailures += 1;
            log(
              `FAILED ${timeframe} ${job.fromMonth.slice(0, 7)} ${job.symbols.join(",")}: ${error instanceof Error ? error.message : String(error)}`,
            );
            if (consecutiveFailures >= 5) {
              result.aborted = true;
              log("stopping: five jobs failed in a row. Rerun to resume from the last checkpoint.");
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
    }
    return result;
  }

  async #run(
    timeframe: Timeframe,
    job: Job,
    sessions: ReadonlyMap<string, SessionTimes>,
    now: Date,
    dropped: Record<Dropped, number>,
  ): Promise<{ rows: number; rejected: string[] }> {
    // The free data plan refuses SIP bars under 15 minutes old, and nothing that recent is final anyway.
    const latest = new Date(now.getTime() - 16 * 60_000);
    const until = new Date(`${job.untilMonth}T00:00:00Z`);
    const counts = new Map<string, { rows: number; sessions: Set<string> }>();
    for (const unit of job.units) {
      counts.set(unit, { rows: 0, sessions: new Set() });
    }
    const rows: Array<DailyRow | MinuteRow> = [];
    const window = {
      timeframe,
      start: `${job.fromMonth}T00:00:00Z`,
      end: (until < latest ? until : latest).toISOString(),
    };
    // A daily job reads its span twice, as traded and split-adjusted, side by side.
    const collect = async (symbols: readonly string[], adjustment: "raw" | "split") => {
      const pages: Array<Readonly<Record<string, readonly AlpacaBar[]>>> = [];
      if (symbols.length > 0 && (adjustment === "raw" || timeframe === "1Day")) {
        for await (const page of this.#source.bars({ ...window, symbols, adjustment })) {
          pages.push(page);
        }
      }
      return pages;
    };
    // One unknown symbol fails the whole request. Drop it and read the rest again; its months are left
    // with no bars and a complete checkpoint, so it is never asked for again.
    let symbols = [...job.symbols];
    const rejected: string[] = [];
    let rawPages: Array<Readonly<Record<string, readonly AlpacaBar[]>>> = [];
    let splitPages: typeof rawPages = [];
    for (;;) {
      try {
        [rawPages, splitPages] = await Promise.all([collect(symbols, "raw"), collect(symbols, "split")]);
        break;
      } catch (error) {
        if (!(error instanceof InvalidSymbolError) || !symbols.includes(error.symbol)) {
          throw error;
        }
        rejected.push(error.symbol);
        symbols = symbols.filter((symbol) => symbol !== error.symbol);
      }
    }
    const adjustedVolume = new Map<string, number>();
    for (const page of splitPages) {
      for (const [symbol, bars] of Object.entries(page)) {
        for (const bar of bars) {
          adjustedVolume.set(`${symbol}|${bar.t}`, bar.v);
        }
      }
    }
    for (const page of rawPages) {
      for (const [symbol, bars] of Object.entries(page)) {
        for (const bar of bars) {
          const row =
            timeframe === "1Day"
              ? toDailyRow(symbol, bar, adjustedVolume.get(`${symbol}|${bar.t}`), sessions)
              : toMinuteRow(symbol, bar, sessions);
          if (typeof row === "string") {
            dropped[row] += 1;
            continue;
          }
          const count = counts.get(key(symbol, monthOf(row.session)));
          if (count === undefined) {
            continue;
          }
          rows.push(row);
          count.rows += 1;
          count.sessions.add(row.session);
        }
      }
    }
    const today = newYorkDate(now);
    const checkpoints: Checkpoint[] = [...counts].map(([unit, count]) => {
      const [symbol = "", month = ""] = unit.split("|");
      return {
        symbol,
        month,
        status: nextMonth(month) <= today ? "complete" : "partial",
        rows: count.rows,
        sessions: count.sessions.size,
      };
    });
    await this.#store.writeJob(timeframe, rows, checkpoints);
    return { rows: rows.length, rejected };
  }
}
