/**
 * The pre-registered ORB test (L.2): what a run must be before its verdict is read, the verdict, the
 * diagnostics, and the configurations it hands on.
 *
 * Everything here is computed from a persisted run and the registration it ran under. The commands that
 * run things (cli.ts) only gather those facts; this decides nothing on its own authority. Every
 * threshold is section 11's, how each is applied is Amendment 6's.
 *
 * Preconditions first. A run that is not exactly the pre-registered one, not from a clean commit, not
 * under this registration's text, without a passing null model on its commit, without the ETF list in
 * its commit, without the bad-tick filter, or with a hole in its data, gets no verdict and no diagnostics.
 * Its numbers are in the store, as every run's are, and this reports none of them.
 *
 * In-sample. Section 6's gates on each confirmatory exit, Holm over them, again on the top 10 for
 * section 4's rule, and the frozen configuration that rule picks. Then section 7: the diagnostics and,
 * when there is a frozen configuration, the as-deployed account run on it. With no exit passing, the
 * outcome is NO EDGE and the project stops (section 10); there is nothing to freeze or deploy.
 *
 * Holdout. The frozen configuration on the holdout, once, against the in-sample mean the addendum
 * committed. EDGE only if it passes both gates.
 */

import type { Fixed } from "@trader/contracts";
import { type CostModelConfig, fromNumber } from "@trader/core";
import { type RunConfig, canonical } from "./config.js";
import { type Diagnostics, type DiagnosticsSettings, diagnostics, select } from "./diagnostics.js";
import { type Metrics, computeMetrics } from "./metrics.js";
import type { NullModelRow } from "./nullModel.js";
import type { TradeRecord } from "./records.js";
import type { Registration, Thresholds } from "./registration.js";
import { countedTrades } from "./report.js";
import type { RunRow } from "./store.js";
import {
  type FrozenChoice,
  type HoldoutVerdict,
  type VariantVerdict,
  type VerdictThresholds,
  type VerdictTrade,
  chooseFrozen,
  holdoutVerdict,
  inSampleVerdict,
} from "./verdict.js";

export const VERDICT_REPORT = "verdict";
export const HOLDOUT_REPORT = "holdout";

/** Section 11's gates and statistics, as the verdict takes them. */
export function verdictThresholds(t: Thresholds): VerdictThresholds {
  return {
    inSample: t.samples.inSample,
    minTrades: t.inSampleGates.minTrades,
    minPositiveYears: t.inSampleGates.minPositiveYears,
    years: t.inSampleGates.years,
    leaveOneYearOutPositive: t.inSampleGates.leaveOneYearOutPositive,
    excludedRegimeYears: t.inSampleGates.excludedRegimeYears,
    excludedRegimeMeanPositive: t.inSampleGates.excludedRegimeMeanPositive,
    resamples: t.statistics.resamples,
    seed: t.statistics.seed,
    familyAlpha: t.statistics.familyAlpha,
    notWorseZ: t.holdoutGates.notWorseZ,
    topNChoices: t.strategy.topNChoices,
  };
}

export function diagnosticsSettings(t: Thresholds): DiagnosticsSettings {
  return {
    exits: t.strategy.exits.map((exit) => exit.id),
    costScales: t.diagnostics.costScales,
    rvolBuckets: t.diagnostics.rvolBuckets,
    breakEvenMaxBps: t.diagnostics.breakEvenMaxBps,
  };
}

/** The pre-registered run narrowed to the frozen choice: its exit, its top N, longs only. */
function narrowed(expected: RunConfig, choice: FrozenChoice): RunConfig {
  const variant = expected.variants.find((v) => v.id === choice.exit);
  if (variant === undefined) {
    throw new Error(`exit ${choice.exit} is not a variant of the pre-registered run`);
  }
  return {
    ...expected,
    variants: [variant],
    shorts: false,
    universe: { ...expected.universe, topN: choice.topN },
    blind: false,
    allowDirty: false,
  };
}

/** The holdout's run: the frozen configuration the addendum commits (section 4). */
export function holdoutConfig(expected: RunConfig, t: Thresholds, choice: FrozenChoice): RunConfig {
  return {
    ...narrowed(expected, choice),
    name: `L.2 holdout, exit ${choice.exit}, top ${String(choice.topN)}`,
    from: t.samples.holdout.from,
    to: t.samples.holdout.to,
  };
}

/** Section 7's as-deployed run: the frozen configuration in-sample, through one account. */
export function asDeployedConfig(expected: RunConfig, t: Thresholds, choice: FrozenChoice): RunConfig {
  const posture = t.live.aggressivePosture;
  return {
    ...narrowed(expected, choice),
    name: `L.2 as deployed, exit ${choice.exit}, top ${String(choice.topN)}`,
    account: {
      kind: "asDeployed",
      startingCash: t.asDeployed.startingCash,
      riskPerTrade: posture.riskPerTrade,
      maxPositionPct: posture.maxPositionPct,
      maxGrossExposure: t.asDeployed.maxGrossExposure,
      maxConcurrentPositions: posture.maxConcurrent,
      maxOpenRisk: t.asDeployed.maxOpenRisk,
      dailyLossLimit: posture.dailyLossLimit,
      flattenOnBreaker: t.asDeployed.flattenOnBreaker,
      micro: null,
    },
  };
}

export interface Precondition {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface RunFacts {
  readonly run: RunRow;
  /** The configuration the run must be, name aside. */
  readonly expected: RunConfig;
  readonly registration: Registration;
  /** The latest null-model run from a clean checkout of the run's commit. */
  readonly nullModel: NullModelRow | undefined;
  /** Whether the ETF and ETN list is part of the run's commit. */
  readonly etfListInCommit: boolean;
  /** Eligible names the run could not rank, by reason. */
  readonly unrankable: Readonly<Record<string, number>>;
}

const sameRun = (a: unknown, b: RunConfig) => {
  const { name: _a, ...left } = a as RunConfig;
  const { name: _b, ...right } = b;
  return canonical(left) === canonical(right);
};

/** Section 3's preconditions as Amendment 6 checks them. */
export function preconditions(facts: RunFacts): Precondition[] {
  const { run, expected, registration, nullModel } = facts;
  const commit = run.gitCommit?.slice(0, 8) ?? "none";
  const holes = facts.unrankable["minutesNotLoaded"] ?? 0;
  const badTicks = registration.thresholds.samples.badTicks;
  return [
    {
      name: "the pre-registered run",
      passed: sameRun(run.config, expected),
      detail: sameRun(run.config, expected)
        ? "its configuration is the registered one"
        : "its configuration differs from the registered one (pnpm backtest diff shows how)",
    },
    {
      name: "completed with outcomes",
      passed: run.status === "completed" && !run.blind,
      detail: run.blind ? "a blind run keeps no outcomes" : `status ${run.status}`,
    },
    {
      name: "a clean commit",
      passed: run.gitCommit !== null && run.gitDirty === false,
      detail:
        run.gitCommit === null
          ? "no commit"
          : `${commit}${run.gitDirty === true ? " with uncommitted changes" : ""}`,
    },
    {
      name: "this registration",
      passed: run.registrationSha256 === registration.sha256,
      detail:
        run.registrationSha256 === registration.sha256
          ? `version ${String(registration.thresholds.version)}, the text it ran under`
          : "the registration changed since the run; run it again",
    },
    {
      name: "the null model on its commit",
      passed: nullModel?.verdict === "pass",
      detail:
        nullModel === undefined
          ? `not run on ${commit} (pnpm backtest null-model)`
          : `${nullModel.verdict.toUpperCase()} on ${commit} (${nullModel.id})`,
    },
    {
      name: "the ETF and ETN list in its commit",
      passed: facts.etfListInCommit && registration.etfExclusions !== null,
      detail: facts.etfListInCommit
        ? `${String(registration.etfExclusions?.length ?? 0)} entries`
        : `not in ${commit}`,
    },
    {
      name: "the bad-tick filter",
      passed:
        run.summary?.badTickFilter === "on" &&
        canonical((run.config as RunConfig).badTicks) === canonical(badTicks),
      detail: run.summary?.badTickFilter === "on" ? "on, with section 11's settings" : "off",
    },
    {
      name: "no holes in the data",
      passed: holes === 0,
      detail: `${String(holes)} eligible names unranked for want of minute bars; ${String(facts.unrankable["baselineEmpty"] ?? 0)} with nothing in their opening baseline, which is not a hole`,
    },
  ];
}

export interface AsDeployed {
  readonly runId: string;
  readonly signals: number;
  /** Signals the account turned away: refused at sizing or by the risk rules. */
  readonly skipped: number;
  readonly metrics: Metrics;
}

export interface InSampleReport {
  readonly runId: string;
  readonly commit: string | null;
  readonly registration: { readonly version: number; readonly sha256: string };
  readonly dataSnapshot: string | null;
  readonly preconditions: readonly Precondition[];
  /** Null when a precondition failed. */
  readonly result: {
    readonly outcome: "EDGE CANDIDATE" | "NO EDGE";
    readonly exits: readonly VariantVerdict[];
    readonly topTen: readonly VariantVerdict[];
    readonly frozen: FrozenChoice | null;
    /** The frozen configuration's in-sample trades and net mean R, for the addendum. */
    readonly frozenInSample: { readonly trades: number; readonly netMeanR: number } | null;
    readonly frozenConfiguration: RunConfig | null;
    readonly diagnostics: Diagnostics;
    readonly asDeployed: AsDeployed | null;
  } | null;
}

/** The confirmatory exits' trades, as the verdict takes them. */
export function verdictTrades(
  records: readonly TradeRecord[],
  exits: readonly string[],
  maxRank = Number.POSITIVE_INFINITY,
): Map<string, VerdictTrade[]> {
  return new Map(
    exits.map((exit) => [
      exit,
      select(records, exit, "long")
        .filter((t) => t.rank <= maxRank)
        .map((t) => ({ session: t.session, netR: t.netR as number, rank: t.rank })),
    ]),
  );
}

/** What the as-deployed run made: its metrics on its starting cash, and what the account turned away. */
export function asDeployedResult(
  run: RunRow,
  records: readonly TradeRecord[],
  sessions: readonly string[],
): AsDeployed {
  const config = run.config as RunConfig;
  if (config.account.kind !== "asDeployed") {
    throw new Error(`run ${run.id} is not an as-deployed run`);
  }
  const cash: Fixed = fromNumber(config.account.startingCash);
  return {
    runId: run.id,
    signals: records.length,
    skipped: records.filter(
      (t) => t.refusal?.startsWith("sizing:") === true || t.refusal?.startsWith("risk:") === true,
    ).length,
    metrics: computeMetrics(countedTrades(records), sessions, cash),
  };
}

export interface InSampleInputs extends RunFacts {
  readonly records: readonly TradeRecord[];
  readonly costModel: CostModelConfig;
  /** The as-deployed run on the frozen configuration, once it exists. */
  readonly asDeployed: AsDeployed | null;
}

export function inSampleReport(inputs: InSampleInputs): InSampleReport {
  const { run, registration, records } = inputs;
  const t = registration.thresholds;
  const checks = preconditions(inputs);
  const base = {
    runId: run.id,
    commit: run.gitCommit,
    registration: { version: t.version, sha256: registration.sha256 },
    dataSnapshot: run.dataSnapshot?.id ?? null,
    preconditions: checks,
  };
  if (!checks.every((check) => check.passed)) {
    return { ...base, result: null };
  }
  const thresholds = verdictThresholds(t);
  const exits = t.strategy.exits.map((exit) => exit.id);
  const full = inSampleVerdict(verdictTrades(records, exits), thresholds);
  const small = Math.min(...thresholds.topNChoices);
  const topTen = inSampleVerdict(verdictTrades(records, exits, small), thresholds);
  const frozen = chooseFrozen(full, topTen, thresholds);
  const frozenVerdict =
    frozen === null ? undefined : (frozen.topN === small ? topTen : full).get(frozen.exit);
  return {
    ...base,
    result: {
      outcome: frozen === null ? "NO EDGE" : "EDGE CANDIDATE",
      exits: [...full.values()],
      topTen: [...topTen.values()],
      frozen,
      frozenInSample:
        frozenVerdict === undefined
          ? null
          : { trades: frozenVerdict.trades, netMeanR: frozenVerdict.meanR ?? 0 },
      frozenConfiguration: frozen === null ? null : holdoutConfig(inputs.expected, t, frozen),
      diagnostics: diagnostics(records, inputs.costModel, diagnosticsSettings(t)),
      asDeployed: frozen === null ? null : inputs.asDeployed,
    },
  };
}

/** The holdout addendum's JSON block (Amendment 6), for a report with a frozen configuration. */
export function addendumBlock(report: InSampleReport): string | null {
  const result = report.result;
  if (result?.frozen == null || result.frozenConfiguration === null || result.frozenInSample === null) {
    return null;
  }
  const block = {
    frozenConfiguration: result.frozenConfiguration,
    inSample: {
      runId: report.runId,
      commit: report.commit,
      exit: result.frozen.exit,
      topN: result.frozen.topN,
      trades: result.frozenInSample.trades,
      netMeanR: result.frozenInSample.netMeanR,
    },
  };
  return ["```json", JSON.stringify(block, null, 2), "```"].join("\n");
}

export interface HoldoutReport {
  readonly runId: string;
  readonly commit: string | null;
  readonly preconditions: readonly Precondition[];
  readonly result: { readonly outcome: "EDGE" | "NO EDGE"; readonly verdict: HoldoutVerdict } | null;
}

/** The holdout's preconditions are the in-sample ones, with the frozen configuration as the run. */
export function holdoutReport(facts: RunFacts & { readonly records: readonly TradeRecord[] }): HoldoutReport {
  const { run, registration } = facts;
  const inSample = registration.frozenInSample;
  const checks = [
    ...preconditions(facts),
    {
      name: "the in-sample numbers committed",
      passed: inSample !== null,
      detail:
        inSample === null
          ? "the addendum carries no in-sample numbers"
          : `net mean ${inSample.netMeanR.toFixed(4)}R over ${String(inSample.trades)} trades`,
    },
  ];
  const base = { runId: run.id, commit: run.gitCommit, preconditions: checks };
  if (!checks.every((check) => check.passed) || inSample === null) {
    return { ...base, result: null };
  }
  const [variant] = (run.config as RunConfig).variants;
  const trades = select(facts.records, variant?.id ?? "", "long").map((t) => ({
    session: t.session,
    netR: t.netR as number,
    rank: t.rank,
  }));
  const verdict = holdoutVerdict(trades, inSample.netMeanR, verdictThresholds(registration.thresholds));
  return { ...base, result: { outcome: verdict.outcome === "pass" ? "EDGE" : "NO EDGE", verdict } };
}
