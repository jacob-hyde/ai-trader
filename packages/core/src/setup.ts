/**
 * The contract a trading setup implements, and the loader that turns a definition into a live setup.
 *
 * Built to host several setups. ORB is the only one allowed to trade until it validates. A setup is
 * pure decision logic: it reads the state it is handed and answers. It never sizes, never places an
 * order, and never reads a clock, the network, or a broker.
 *
 * Long and short are both part of the contract. Whether shorts may trade is an engine-level flag that
 * is off by default, not something a setup decides.
 *
 * loadSetup is where a bad setup fails. Parameters are parsed with zod in strict mode, so a wrong type,
 * an out-of-bounds value, or a misspelled key stops the engine at load and not at 09:35 ET. The loaded
 * setup also checks every answer against the contract (supported direction, stop on the risk side,
 * target on the profit side) and throws SetupError on a violation, because that is a bug in the setup
 * and not a market condition. Sizing and the risk rules reject the same mistakes again downstream.
 */

import type { z } from "zod";
import type { Bar } from "./bars.js";
import type { Quote } from "./costs.js";
import type { Fixed, Ratio } from "./money.js";
import type { Direction } from "./sizing.js";

/** History the engine must have replayed before a setup's answers can be trusted. */
export interface WarmupRequirements {
  /** Completed daily bars, e.g. 14 for the daily ATR. */
  readonly dailyBars: number;
  /** Prior sessions of one-minute bars, e.g. 14 for the relative-volume baseline. */
  readonly sessions: number;
  /** Closed bars of the current session before detectTrigger can fire, e.g. 5 for a 5-minute opening range. */
  readonly sessionBars: number;
}

/**
 * What is known about one symbol as of its latest closed bar.
 *
 * An indicator is null until its lookback is satisfied. A setup must read null as "does not apply" and
 * never substitute a default.
 */
export interface SymbolState {
  readonly symbol: string;
  readonly session: string;
  /** Minute of the latest closed bar. Doubles as "now" for this symbol. */
  readonly minuteOfSession: number;
  readonly lastClose: Fixed;
  /** ATR on daily bars. The ORB stop is a fraction of this. */
  readonly dailyAtr: Fixed | null;
  readonly rsi: number | null;
  readonly sessionVwap: Fixed | null;
  /** First-minutes relative volume in basis points. Null until the opening window has closed. */
  readonly openingRvol: Ratio | null;
  readonly runningRvol: Ratio | null;
}

/** Index-level intraday direction. A filter on everything, never a per-stock signal. */
export type MarketRegime = "up" | "down" | "flat";

export interface MarketState {
  readonly session: string;
  /** Minutes since the regular-session open, now. */
  readonly minuteOfSession: number;
  /** Length of this session in minutes: 390 on a full day, 210 on a half day. */
  readonly closeMinute: number;
  /** Null when the regime is unknown. A setup that filters on regime treats unknown as not applying. */
  readonly regime: MarketRegime | null;
}

/** Whether the setup applies to a symbol right now. The reasons are stable codes owned by the setup. */
export type ContextVerdict =
  { readonly applies: true } | { readonly applies: false; readonly reasons: readonly string[] };

/** How the entry order rests at the broker. The cost model prices a stop entry pessimistically. */
export type EntryType = "stop" | "limit" | "market";

/** An exact entry condition that has been met on closed bars. Carries no size, stop, or target. */
export interface SetupSignal {
  readonly setupId: string;
  readonly setupVersion: string;
  readonly symbol: string;
  readonly direction: Direction;
  readonly session: string;
  /** Minute of the closed bar that completed the condition. */
  readonly minuteOfSession: number;
  readonly entryType: EntryType;
  /** Trigger price for a stop entry, limit price for a limit entry, reference price for a market entry. */
  readonly entry: Fixed;
}

/** The decision logic of one setup, built from validated parameters. */
export interface SetupBehavior {
  /**
   * Says whether this symbol is in a state where the setup applies: volume gate, session window,
   * regime filter. Cheap and side-effect free. Called before detectTrigger, which is skipped on a no.
   */
  evaluateContext(symbol: SymbolState, market: MarketState): ContextVerdict;

  /**
   * Returns a signal when the exact entry condition is met, else null.
   *
   * `bars` holds the current session's closed bars, oldest first. The loader strips any bar still
   * forming, so an implementation never sees one. `quote` is null where none exists, as in a bar-only
   * backtest. Must depend only on its arguments, so the same inputs always give the same answer.
   */
  detectTrigger(symbol: SymbolState, bars: readonly Bar[], quote: Quote | null): SetupSignal | null;

  /** The protective stop price. Below entry for a long, above it for a short. Never at entry. */
  stop(signal: SetupSignal, symbol: SymbolState): Fixed;

  /** The profit target price, beyond entry in the trade's direction. Null means run to the EOD flatten. */
  target(signal: SetupSignal, symbol: SymbolState): Fixed | null;

  /**
   * True when a signal that has not filled yet should be cancelled: its window passed, or price went
   * through the stop first. Only ever consulted for pending entries. It never gates an exit.
   */
  invalidation(signal: SetupSignal, symbol: SymbolState): boolean;
}

/** A setup as registered with the framework: identity, requirements, parameter schema, and a factory. */
export interface SetupDefinition<Schema extends z.AnyZodObject> {
  /** Stable identifier, written into every signal and every decision-log row. */
  readonly id: string;
  /** Bumped whenever the logic changes, so results stay attributable to the code that produced them. */
  readonly version: string;
  /** Directions the logic can produce. A signal outside this list is a contract violation. */
  readonly directions: readonly Direction[];
  readonly warmup: WarmupRequirements;
  /** Every tunable parameter, with bounds. Parsed in strict mode, so unknown keys fail. */
  readonly paramsSchema: Schema;
  /** Builds the logic from parameters that already passed the schema. */
  create(params: z.infer<Schema>): SetupBehavior;
}

/** A loaded setup: the definition's metadata, the parsed parameters, and contract-checked behavior. */
export interface Setup<Params = unknown> extends SetupBehavior {
  readonly id: string;
  readonly version: string;
  readonly directions: readonly Direction[];
  readonly warmup: WarmupRequirements;
  readonly params: Params;
}

export type SetupErrorCode = "INVALID_DEFINITION" | "INVALID_PARAMS" | "CONTRACT_VIOLATION";

export class SetupError extends Error {
  readonly code: SetupErrorCode;

  constructor(code: SetupErrorCode, message: string) {
    super(message);
    this.name = "SetupError";
    this.code = code;
  }
}

function assertDefinition(definition: SetupDefinition<z.AnyZodObject>): void {
  const problems: string[] = [];
  if (definition.id.length === 0) {
    problems.push("id is empty");
  }
  if (definition.version.length === 0) {
    problems.push("version is empty");
  }
  const directions = new Set(definition.directions);
  if (directions.size === 0 || directions.size !== definition.directions.length) {
    problems.push("directions must list long, short, or both, once each");
  }
  for (const [name, value] of Object.entries(definition.warmup)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      problems.push(`warmup.${name} must be a non-negative whole number`);
    }
  }
  if (problems.length > 0) {
    throw new SetupError("INVALID_DEFINITION", `setup "${definition.id}": ${problems.join("; ")}`);
  }
}

/**
 * Validates a definition and its raw parameters, and returns the setup ready to run.
 *
 * Throws SetupError INVALID_DEFINITION for bad metadata and INVALID_PARAMS for parameters the schema
 * rejects. The message names every failing path. Call it at boot for every configured setup.
 */
export function loadSetup<Schema extends z.AnyZodObject>(
  definition: SetupDefinition<Schema>,
  rawParams: unknown,
): Setup<z.infer<Schema>> {
  assertDefinition(definition);
  const parsed = definition.paramsSchema.strict().safeParse(rawParams);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new SetupError("INVALID_PARAMS", `setup "${definition.id}": ${issues.join("; ")}`);
  }
  const params = parsed.data as z.infer<Schema>;
  const behavior = definition.create(params);
  const { id, version, directions, warmup } = definition;

  const violation = (what: string): SetupError =>
    new SetupError("CONTRACT_VIOLATION", `setup "${id}" ${version}: ${what}`);

  return {
    id,
    version,
    directions,
    warmup,
    params,
    evaluateContext: (symbol, market) => behavior.evaluateContext(symbol, market),
    detectTrigger(symbol, bars, quote) {
      const signal = behavior.detectTrigger(
        symbol,
        bars.filter((bar) => bar.closed),
        quote,
      );
      if (signal === null) {
        return null;
      }
      if (signal.setupId !== id || signal.setupVersion !== version) {
        throw violation("signal names a different setup or version");
      }
      if (!directions.includes(signal.direction)) {
        throw violation(`signal direction "${signal.direction}" is not one it declares`);
      }
      if (!Number.isSafeInteger(signal.entry) || signal.entry <= 0) {
        throw violation("signal entry is not a positive price");
      }
      return signal;
    },
    stop(signal, symbol) {
      const stop = behavior.stop(signal, symbol);
      const onRiskSide = signal.direction === "long" ? stop < signal.entry : stop > signal.entry;
      if (!Number.isSafeInteger(stop) || stop <= 0 || !onRiskSide) {
        throw violation("stop is not a positive price on the risk side of entry");
      }
      return stop;
    },
    target(signal, symbol) {
      const target = behavior.target(signal, symbol);
      if (target === null) {
        return null;
      }
      const onProfitSide = signal.direction === "long" ? target > signal.entry : target < signal.entry;
      if (!Number.isSafeInteger(target) || target <= 0 || !onProfitSide) {
        throw violation("target is not a positive price on the profit side of entry");
      }
      return target;
    },
    invalidation: (signal, symbol) => behavior.invalidation(signal, symbol),
  };
}
