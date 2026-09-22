/**
 * The null-model tripwire: the whole decision core run over driftless random walks, with costs on.
 *
 * A driftless walk is a martingale, so no rule for when to buy and when to sell can have a positive
 * expected gross result on it. The simulator's intrabar rules only make that worse. So a correct system
 * must land at about zero gross and clearly negative net, the cost drag. Profit on random data is a
 * defect: a look-ahead leak, an accounting error, or a fit to noise. Is a standing check, run on every
 * push at a modest size and nightly at full size, and the report L.3 surfaces.
 *
 * Each path is one session for one symbol. The ORB signals on its range, the entry goes through the
 * cost gate, sizing, the risk rules, and the bracket builder, and the approved trade is simulated to
 * its exit. Each session is decided alone against a fresh account, so the paths are independent and a
 * confidence interval on the per-trade mean is honest. Nothing about the account or the breaker is
 * being tested here. The invariant suite does that.
 *
 * The verdict has two parts. Gross expectancy must not be an established edge: the lower bound of its
 * confidence interval must sit at or below a small tolerance, so the interval contains zero or lies
 * below it. And costs must have been charged: the mean of gross minus net, the drag, must be positive.
 * Both are in R against the plan's stop, so the check is independent of price and size. A leak shows
 * up as a gross interval that sits entirely above the tolerance.
 *
 * The walk must be fine-grained. With few moves per bar a jump through a level overshoots it, the
 * simulator fills at the level, and the overshoot alone reads as an edge. Run it with stepsPerBar at
 * or near 60, one move a second, where the overshoot is tick-sized as it is in real minute bars.
 *
 * `leak` exists only to prove the tripwire works. It lets a test hand the decision the whole session,
 * bars it could not have seen, and the tripwire must then fail. No real run passes one.
 *
 * Not the full Stage 3. The price band, average-volume floor, and top-N ranking are universe filters
 * that do not exist yet and would not change a martingale's expectancy anyway. The cost-to-risk gate,
 * which does shape which trades happen, is in.
 */

import type { Bar } from "./bars.js";
import { type DecisionConfig, decideEntry } from "./decision.js";
import { type Fixed, type Ratio, fixed } from "./money.js";
import { orbSetupDefinition } from "./orb.js";
import { type PathConfig, generatePath } from "./paths.js";
import { BREAKER_ARMED } from "./riskRules.js";
import { type SetupSignal, type SymbolState, type TradePlan, loadSetup, planTrade } from "./setup.js";
import { type FilledTrade, simulateTrade } from "./tradeSim.js";

export interface NullModelConfig {
  /** Sessions to generate. Each is one independent symbol-day. */
  readonly paths: number;
  /** Seeds run from this value upward, one per path, so a report names the path behind any trade. */
  readonly firstSeed: number;
  readonly path: Omit<PathConfig, "seed" | "scenario">;
  /** Raw ORB parameters, validated at load. */
  readonly setupParams: unknown;
  readonly decision: DecisionConfig;
  /** Every session starts from this equity. */
  readonly equity: Fixed;
  /** Daily ATR as a fraction of the start price, e.g. 300 is 3%. Sets the published stop's width. */
  readonly dailyAtrOfPrice: Ratio;
  /** Opening relative volume handed to every session. The gate needs it above the setup's minimum. */
  readonly openingRvol: Ratio;
  readonly flattenMinute: number;
  /** Highest gross expectancy lower bound that still passes, in R. */
  readonly grossToleranceR: number;
  /**
   * Test hook. Receives the plan and the whole session and says whether to take the trade. A real run
   * leaves it undefined. The report records whether one was present.
   */
  readonly leak?: (plan: TradePlan, session: readonly Bar[]) => boolean;
}

/** Mean, standard deviation, and a 95% confidence interval on the mean, all in R. */
export interface RStatistics {
  readonly count: number;
  readonly meanR: number;
  readonly sdR: number;
  readonly lowerR: number;
  readonly upperR: number;
}

export interface NullModelReport {
  readonly paths: number;
  readonly firstSeed: number;
  /** Sessions whose range gave a signal. */
  readonly signals: number;
  /** Refusals by stage. */
  readonly refused: {
    readonly costToRisk: number;
    readonly sizing: number;
    readonly risk: number;
    readonly bracket: number;
  };
  /** Approved entries that never triggered, or that the leak declined. */
  readonly unfilled: number;
  readonly trades: number;
  readonly exits: {
    readonly stop: number;
    readonly breakevenStop: number;
    readonly target: number;
    readonly eod: number;
  };
  readonly gross: RStatistics;
  readonly net: RStatistics;
  /** Mean of gross minus net per trade: what costs took, in R. */
  readonly dragR: number;
  readonly grossToleranceR: number;
  readonly leakInjected: boolean;
  readonly verdict: "pass" | "fail" | "insufficient";
  readonly reasons: readonly string[];
}

export class NullModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NullModelError";
  }
}

/** Fewer trades than this and the interval means nothing, so the verdict is "insufficient", not "pass". */
export const MIN_TRADES = 200;

const Z_95 = 1.96;

/** Sample statistics with a normal-approximation interval. Under two values there is no spread to measure. */
export function statistics(values: readonly number[]): RStatistics {
  const count = values.length;
  if (count < 2) {
    const meanR = count === 0 ? 0 : (values[0] as number);
    return { count, meanR, sdR: 0, lowerR: meanR, upperR: meanR };
  }
  const meanR = values.reduce((sum, v) => sum + v, 0) / count;
  const sdR = Math.sqrt(values.reduce((sum, v) => sum + (v - meanR) ** 2, 0) / (count - 1));
  const halfWidth = (Z_95 * sdR) / Math.sqrt(count);
  return { count, meanR, sdR, lowerR: meanR - halfWidth, upperR: meanR + halfWidth };
}

/**
 * Decides the verdict from the statistics alone.
 *
 * "insufficient" below MIN_TRADES, because an interval over a handful of trades says nothing. "fail"
 * when the gross interval sits entirely above the tolerance, which is an established edge on random
 * data, or when the drag is not positive, which means fills were not charged. Otherwise "pass".
 */
export function verdictFor(
  gross: RStatistics,
  dragR: number,
  grossToleranceR: number,
): { readonly verdict: NullModelReport["verdict"]; readonly reasons: readonly string[] } {
  if (gross.count < MIN_TRADES) {
    return {
      verdict: "insufficient",
      reasons: [`${String(gross.count)} trades is below the ${String(MIN_TRADES)} the interval needs`],
    };
  }
  const reasons: string[] = [];
  if (gross.lowerR > grossToleranceR) {
    reasons.push(
      `gross expectancy lower bound ${gross.lowerR.toFixed(4)}R is above the tolerance of ${grossToleranceR.toFixed(4)}R: an edge on random data, so something is leaking or miscounting`,
    );
  }
  if (!(dragR > 0)) {
    reasons.push(`drag ${dragR.toFixed(4)}R per trade is not positive: fills are not being charged`);
  }
  return { verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}

/** Runs the tripwire. Throws NullModelError on a config that cannot run, not on a failing verdict. */
export function runNullModel(config: NullModelConfig): NullModelReport {
  if (!Number.isSafeInteger(config.paths) || config.paths < 1) {
    throw new NullModelError(`paths must be a whole number of at least 1, got ${String(config.paths)}`);
  }
  if (!Number.isSafeInteger(config.firstSeed)) {
    throw new NullModelError("firstSeed must be a whole number");
  }
  if (!(config.grossToleranceR >= 0)) {
    throw new NullModelError("grossToleranceR must be zero or positive");
  }
  const setup = loadSetup(orbSetupDefinition, config.setupParams);
  const rangeMinutes = setup.params.openingRangeMinutes;
  const dailyAtr = fixed(
    Math.max(100, Math.round((config.path.startPrice * config.dailyAtrOfPrice) / 10_000 / 100) * 100),
  );

  let signals = 0;
  const refused = { costToRisk: 0, sizing: 0, risk: 0, bracket: 0 };
  let unfilled = 0;
  const exits = { stop: 0, breakevenStop: 0, target: 0, eod: 0 };
  const grossR: number[] = [];
  const netR: number[] = [];

  for (let i = 0; i < config.paths; i += 1) {
    const generated = generatePath({ ...config.path, scenario: "driftlessWalk", seed: config.firstSeed + i });
    const range = generated.bars.filter((bar) => bar.minuteOfSession < rangeMinutes);
    const last = range.at(-1) as Bar;
    const symbol: SymbolState = {
      symbol: "NULL",
      session: generated.session,
      minuteOfSession: last.minuteOfSession,
      lastClose: last.close,
      dailyAtr,
      rsi: null,
      sessionVwap: null,
      openingRvol: config.openingRvol,
      runningRvol: null,
    };
    const signal: SetupSignal | null = setup.detectTrigger(symbol, range, null);
    if (signal === null) {
      continue;
    }
    signals += 1;
    const plan = planTrade(setup, signal, symbol);
    const decision = decideEntry(
      {
        plan,
        quote: generated.quotes[rangeMinutes - 1] as { bid: Fixed; ask: Fixed },
        portfolio: {
          account: { equity: config.equity, startOfDayEquity: config.equity, realizedPnlToday: fixed(0) },
          exposures: [],
          breaker: BREAKER_ARMED,
        },
        buyingPower: config.equity,
      },
      config.decision,
    );
    if (!decision.approved) {
      refused[decision.stage] += 1;
      continue;
    }
    if (config.leak !== undefined && !config.leak(plan, generated.bars)) {
      unfilled += 1;
      continue;
    }
    const outcome = simulateTrade(plan, generated.bars, {
      shares: decision.order.quantity,
      costModel: config.decision.costModel,
      lastEntryMinute: setup.params.lastEntryMinute,
      flattenMinute: config.flattenMinute,
    });
    if (!outcome.filled) {
      unfilled += 1;
      continue;
    }
    const trade: FilledTrade = outcome;
    exits[trade.exitReason] += 1;
    grossR.push(trade.grossR / 10_000);
    netR.push(trade.netR / 10_000);
  }

  const gross = statistics(grossR);
  const net = statistics(netR);
  const dragR = gross.count === 0 ? 0 : gross.meanR - net.meanR;
  const { verdict, reasons } = verdictFor(gross, dragR, config.grossToleranceR);
  return {
    paths: config.paths,
    firstSeed: config.firstSeed,
    signals,
    refused,
    unfilled,
    trades: gross.count,
    exits,
    gross,
    net,
    dragR,
    grossToleranceR: config.grossToleranceR,
    leakInjected: config.leak !== undefined,
    verdict,
    reasons,
  };
}

/** One line per fact, for a log or a report. */
export function formatNullModelReport(report: NullModelReport): string {
  const r = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(4)}R`;
  const interval = (s: RStatistics): string =>
    `${r(s.meanR)} [${r(s.lowerR)}, ${r(s.upperR)}] sd ${s.sdR.toFixed(3)}`;
  return [
    `null model: ${report.verdict.toUpperCase()}${report.leakInjected ? " (leak injected)" : ""}`,
    `paths ${String(report.paths)} from seed ${String(report.firstSeed)}, signals ${String(report.signals)}, trades ${String(report.trades)}, unfilled ${String(report.unfilled)}`,
    `refused: cost gate ${String(report.refused.costToRisk)}, sizing ${String(report.refused.sizing)}, risk ${String(report.refused.risk)}, bracket ${String(report.refused.bracket)}`,
    `exits: stop ${String(report.exits.stop)}, breakeven ${String(report.exits.breakevenStop)}, target ${String(report.exits.target)}, eod ${String(report.exits.eod)}`,
    `gross ${interval(report.gross)} (tolerance ${r(report.grossToleranceR)})`,
    `net   ${interval(report.net)}`,
    `drag  ${r(report.dragR)} per trade`,
    ...report.reasons.map((reason) => `  ${reason}`),
  ].join("\n");
}
