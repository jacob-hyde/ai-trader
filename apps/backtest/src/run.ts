/**
 * Runs one backtest: the registration's guard, the study universe, the backtest adapter, and the
 * engine, from the first session to the last.
 *
 * Every run replays the study's calendar, which is the store's calendar less the registration's
 * excluded sessions. That is not a setting: the amendment that took 2022-03-08 out applies to anything
 * measured on this store.
 *
 * Blind. A blind run does all of the work and keeps nothing that happened after 09:35: no trade, no
 * fill, no exit, no count of entries that triggered or expired, no R. What it hands back is timing and
 * what was known at the range close (the screen, the ranking, the signals, the cost gate), which is the
 * kind of information the pre-registration's feasibility check already used. It exists to prove the
 * runner on real in-sample data before L.2 without creating an outcome anyone could see. The outcomes
 * are computed in memory, since the mechanics have to run to be tested, and dropped with the process.
 */

import { BacktestAdapter, type ReplaySource, withoutSessions } from "@trader/adapters";
import type { Ratio } from "@trader/contracts";
import type { RunConfig } from "./config.js";
import { costModelFor, startingCashFor } from "./config.js";
import { BacktestEngine, type SessionOutput, type SessionStats } from "./engine.js";
import { type GitState, checkRunAllowed } from "./guard.js";
import type { Registration } from "./registration.js";
import type { TradeRecord } from "./records.js";
import { type StudySource, StudyUniverse, rulesFor } from "./universe.js";

/** The first date any calendar could hold. The study's history starts wherever the store's does. */
const DAWN = "1900-01-01";

export interface RunDependencies {
  readonly replay: ReplaySource;
  readonly study: StudySource;
  readonly registration: Registration;
  readonly git: GitState;
}

export type RunProgress =
  | { readonly phase: "warmup"; readonly month: string; readonly elapsedMs: number }
  | {
      readonly phase: "replay";
      readonly session: string;
      readonly sessionsDone: number;
      readonly sessionsTotal: number;
      readonly elapsedMs: number;
    };

/** What a session hands the store. A blind run's carries the stats and nothing else. */
export interface SessionResult {
  readonly stats: SessionStats;
  readonly records: readonly TradeRecord[];
  readonly fills: SessionOutput["fills"];
}

export interface RunHooks {
  readonly onProgress?: (progress: RunProgress) => void | Promise<void>;
  readonly onSession?: (result: SessionResult) => void | Promise<void>;
}

/** Per variant and direction, over filled trades whose gate passed. A sanity check, not the verdict (L.2). */
export interface VariantOutcome {
  readonly variant: string;
  readonly direction: string;
  readonly signals: number;
  readonly gatePassed: number;
  readonly filled: number;
  readonly meanNetR: Ratio | null;
  readonly meanGrossR: Ratio | null;
}

export interface RunSummary {
  readonly blind: boolean;
  readonly sessions: number;
  /** Minute bars replayed. */
  readonly bars: number;
  readonly elapsedMs: number;
  readonly excludedSessions: readonly string[];
  readonly excludedSymbols: number;
  /** H.8 is not built yet. Recorded so a run made before it says so. */
  readonly badTickFilter: "none";
  readonly eligible: number;
  readonly inPlay: number;
  readonly unrankable: number;
  readonly signals: number;
  readonly gatePassed: Readonly<Record<string, number>>;
  /** Null for a blind run. */
  readonly outcomes: {
    readonly closedAtSessionEnd: number;
    readonly expiredEntries: number;
    readonly unloaded: number;
    readonly byVariant: readonly VariantOutcome[];
  } | null;
}

function mean(values: readonly number[]): Ratio | null {
  return values.length === 0
    ? null
    : (Math.floor(values.reduce((a, b) => a + b, 0) / values.length) as Ratio);
}

export async function runBacktest(
  config: RunConfig,
  deps: RunDependencies,
  hooks: RunHooks = {},
): Promise<RunSummary> {
  const started = performance.now();
  const elapsedMs = () => Math.round(performance.now() - started);
  checkRunAllowed(config, deps.registration, deps.git);

  const excluded = deps.registration.thresholds.samples.excludedSessions;
  const source = withoutSessions(deps.replay, excluded);
  const calendar = (await source.sessions(DAWN, config.to)).map((hours) => hours.session);
  const sessionsTotal = calendar.filter((session) => session >= config.from).length;
  const progress = async (value: RunProgress) => {
    await hooks.onProgress?.(value);
  };

  // Every month before the first one replayed is the screen warming up: the ATR runs from the store's
  // first bar, so a holdout run reads eight years of daily bars before its first session.
  const universe = new StudyUniverse(deps.study, rulesFor(config), calendar, config.from, async (month) => {
    if (month < config.from.slice(0, 7)) {
      await progress({ phase: "warmup", month, elapsedMs: elapsedMs() });
    }
  });

  const totals = { eligible: 0, inPlay: 0, unrankable: 0, signals: 0, closed: 0, expired: 0 };
  const gatePassed = new Map(config.variants.map((variant) => [variant.id, 0]));
  const outcomes = new Map<string, { signals: number; gatePassed: number; net: number[]; gross: number[] }>();
  let sessionsDone = 0;

  let engine: BacktestEngine | null = null;
  const adapter = await BacktestAdapter.create({
    source,
    from: config.from,
    to: config.to,
    universe: (hours) => (engine as BacktestEngine).prepare(hours),
    costModel: costModelFor(config),
    startingCash: startingCashFor(config),
  });
  engine = new BacktestEngine({
    config,
    adapter,
    universe,
    onSession: async (output) => {
      const { stats } = output;
      sessionsDone += 1;
      totals.eligible += stats.eligible;
      totals.inPlay += stats.inPlay;
      totals.unrankable += stats.unrankable;
      totals.signals += stats.signals;
      totals.closed += output.closedAtSessionEnd;
      totals.expired += output.expiredEntries;
      for (const [variant, counts] of Object.entries(stats.byVariant)) {
        gatePassed.set(variant, (gatePassed.get(variant) ?? 0) + counts.gatePassed);
      }
      if (!config.blind) {
        for (const record of output.records) {
          const key = `${record.variant}|${record.direction}`;
          const tally = outcomes.get(key) ?? { signals: 0, gatePassed: 0, net: [], gross: [] };
          outcomes.set(key, tally);
          tally.signals += 1;
          tally.gatePassed += record.gatePassed ? 1 : 0;
          if (record.gatePassed && record.netR !== null && record.grossR !== null) {
            tally.net.push(record.netR);
            tally.gross.push(record.grossR);
          }
        }
      }
      await hooks.onSession?.(
        config.blind
          ? { stats, records: [], fills: [] }
          : { stats, records: output.records, fills: output.fills },
      );
      await progress({
        phase: "replay",
        session: stats.session,
        sessionsDone,
        sessionsTotal,
        elapsedMs: elapsedMs(),
      });
    },
  });

  await adapter.connect();
  try {
    const report = await adapter.replay();
    await engine.finish();
    return {
      blind: config.blind,
      sessions: report.sessions,
      bars: report.bars,
      elapsedMs: elapsedMs(),
      excludedSessions: excluded,
      excludedSymbols: config.universe.excludeSymbols.length,
      badTickFilter: "none",
      eligible: totals.eligible,
      inPlay: totals.inPlay,
      unrankable: totals.unrankable,
      signals: totals.signals,
      gatePassed: Object.fromEntries(gatePassed),
      outcomes: config.blind
        ? null
        : {
            closedAtSessionEnd: totals.closed,
            expiredEntries: totals.expired,
            unloaded: report.unloaded.length,
            byVariant: [...outcomes]
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([key, tally]) => {
                const [variant = "", direction = ""] = key.split("|");
                return {
                  variant,
                  direction,
                  signals: tally.signals,
                  gatePassed: tally.gatePassed,
                  filled: tally.net.length,
                  meanNetR: mean(tally.net),
                  meanGrossR: mean(tally.gross),
                };
              }),
          },
    };
  } finally {
    await adapter.close();
  }
}
