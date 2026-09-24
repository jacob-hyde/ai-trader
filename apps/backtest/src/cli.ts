/**
 * The backtest CLI. Needs no web app: queue a run and follow it, run one here, or look at past runs.
 *
 *   pnpm backtest worker [--concurrency n]           takes queued runs until stopped
 *   pnpm backtest submit <config.json> [--blind] [--allow-dirty] [--detach]
 *                                                    queues a run and follows it to the end
 *   pnpm backtest run <config.json> [--blind] [--allow-dirty]
 *                                                    runs it here, without Redis, recorded the same way
 *   pnpm backtest status [<run id>]                  recent runs, or one of them
 *   pnpm backtest diff <run id> <run id>             what differs: code, data, configuration, results
 *   pnpm backtest report <run id>                    computes the run's metrics (L.4), keeps them, prints them
 *   pnpm backtest config preregistered [--blind]
 *                                                    prints the pre-registered in-sample configuration
 *   pnpm backtest null-model                         runs the null-model tripwire on this checkout and
 *                                                    records it against the commit (nullModel.ts)
 *   pnpm backtest l2 in-sample                       the pre-registered in-sample run, its verdict, section 7
 *   pnpm backtest l2 verdict <run id>                that verdict again for a run, from what it kept
 *   pnpm backtest l2 holdout                         the frozen configuration on the holdout, once
 *   pnpm backtest costs <run id> [--per-year n] [--seed s]
 *                                                    prices a sample of a finished run's trades from
 *                                                    the market's trades and quotes (costCheck.ts)
 *
 * L.2 runs only from a clean checkout whose commit the null model has passed on and that holds the ETF
 * list, and every report says whether its run met section 3's preconditions (l2.ts). The in-sample
 * command is the first look at the result: nothing before it shows a trade, an R, or a verdict.
 *
 * A path is taken relative to where pnpm was run. DATABASE_URL (the engine role) is always needed,
 * REDIS_URL for worker and submit.
 *
 * A run is refused from a checkout with uncommitted changes (L.5). --allow-dirty lets a development run
 * through, and its stored configuration says so.
 *
 * Every run shown with a commit also shows the null model's verdict on that commit. No number from a run
 * is read until it says pass.
 *
 * A blind run prints what was known by 09:35 and its timing, and nothing else: no trade, fill, trigger
 * count, or R reaches the terminal or the database (run.ts).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { NULL_MODEL_EXITS, NULL_MODEL_GATE_PATHS, formatNullModelReport } from "@trader/core";
import { AlpacaClient } from "@trader/adapters/alpaca";
import { TimescaleReplaySource } from "@trader/data/replay";
import { QueueEvents } from "bullmq";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { AlpacaTape } from "./alpacaTape.js";
import { type RunConfig, canonical, costModelFor, parseRunConfig } from "./config.js";
import {
  type MeasuredTrade,
  type Signal,
  measureSignal,
  renderCostReport,
  sampleSignals,
  summarize,
} from "./costCheck.js";
import { LATENCY_MS } from "./fills.js";
import { diffRuns } from "./diff.js";
import { fileInCommit, readGit } from "./git.js";
import type { GitState } from "./guard.js";
import {
  HOLDOUT_REPORT,
  type InSampleReport,
  type RunFacts,
  VERDICT_REPORT,
  asDeployedConfig,
  asDeployedResult,
  holdoutReport,
  inSampleReport,
} from "./l2.js";
import { renderHoldoutReport, renderInSampleReport } from "./l2Text.js";
import {
  NULL_MODEL_EXIT_IDS,
  NullModelStore,
  type NullModelStanding,
  nullModelStanding,
  runNullModelGate,
} from "./nullModel.js";
import { preregisteredConfig } from "./preregistered.js";
import type { TradeRecord } from "./records.js";
import { METRICS_REPORT, metricsReport, renderMetricsReport } from "./report.js";
import {
  type BacktestJobResult,
  QUEUE_NAME,
  backtestQueue,
  processRun,
  redisConnection,
  startWorker,
  submitRun,
} from "./queue.js";
import { EXCLUSIONS_PATH, REPO_ROOT, type Registration, loadRegistration } from "./registration.js";
import type { RunDependencies, RunProgress, RunSummary } from "./run.js";
import { type RunRow, RunStore } from "./store.js";
import { TimescaleStudySource } from "./timescale.js";

loadDotenv({ path: path.join(REPO_ROOT, ".env") });

const [command = "", ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
const positional = rest.filter(
  (arg, i) => !arg.startsWith("--") && !rest[i - 1]?.match(/^--(concurrency|per-year|seed)$/),
);

function option(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set (see .env.example)`);
  }
  return value;
}

/** Relative to where pnpm was run, not to this package. */
function fromCaller(file: string): string {
  return path.resolve(process.env["INIT_CWD"] ?? process.cwd(), file);
}

function readConfig(file: string | undefined): RunConfig {
  if (file === undefined) {
    throw new Error(`${command} needs a configuration file`);
  }
  const raw = JSON.parse(readFileSync(fromCaller(file), "utf8")) as Record<string, unknown>;
  return parseRunConfig({
    ...raw,
    ...(flags.has("--blind") ? { blind: true } : {}),
    ...(flags.has("--allow-dirty") ? { allowDirty: true } : {}),
  });
}

const seconds = (ms: number) => `${(ms / 1_000).toFixed(1)} s`;
const r = (bps: number | null) => (bps === null ? "n/a" : `${(bps / 10_000).toFixed(4)}R`);

function describeProgress(progress: RunProgress): string {
  return progress.phase === "warmup"
    ? `warming up the screen: ${progress.month} (${seconds(progress.elapsedMs)})`
    : `${progress.session}: ${String(progress.sessionsDone)} of ${String(progress.sessionsTotal)} sessions (${seconds(progress.elapsedMs)})`;
}

/** Prints progress at most once a month of replay, so a decade is a page and not two thousand lines. */
function progressPrinter(): (progress: RunProgress) => void {
  let last = "";
  return (progress) => {
    const key = progress.phase === "warmup" ? `w${progress.month}` : progress.session.slice(0, 7);
    const done = progress.phase === "replay" && progress.sessionsDone === progress.sessionsTotal;
    if (key !== last || done) {
      last = key;
      console.log(describeProgress(progress));
    }
  };
}

function printSummary(summary: RunSummary): void {
  const perSession = (n: number) => (summary.sessions === 0 ? "0" : (n / summary.sessions).toFixed(1));
  console.log(
    [
      `${summary.blind ? "blind run" : "run"}: ${String(summary.sessions)} sessions, ${summary.bars.toLocaleString()} bars, ${seconds(summary.elapsedMs)}`,
      `excluded sessions: ${summary.excludedSessions.join(", ") || "none"}; excluded symbols: ${String(summary.excludedSymbols)}; bad-tick filter: ${summary.badTickFilter}, corrupted symbol-sessions left out: ${String(summary.corruptSessions)}`,
      `eligible ${perSession(summary.eligible)} a session, in play ${perSession(summary.inPlay)}, unrankable ${String(summary.unrankable)} in all`,
      `signals ${String(summary.signals)}; passed the cost gate: ${Object.entries(summary.gatePassed)
        .map(([variant, n]) => `${variant} ${String(n)}`)
        .join(", ")}`,
    ].join("\n"),
  );
  if (summary.outcomes === null) {
    return;
  }
  const { outcomes } = summary;
  console.log(
    `bad ticks cut ${String(outcomes.badTicks)}, closed at the bell ${String(outcomes.closedAtSessionEnd)}, expired ${String(outcomes.expiredEntries)}, unloaded ${String(outcomes.unloaded)}`,
  );
  for (const v of outcomes.byVariant) {
    console.log(
      `  ${v.variant} ${v.direction}: ${String(v.signals)} signals, ${String(v.gatePassed)} passed, ${String(v.filled)} filled, ` +
        `mean net ${r(v.meanNetR)}, gross ${r(v.meanGrossR)}`,
    );
  }
  console.log("year by year, mean net R over trades:");
  for (const v of outcomes.byVariant) {
    const years = v.byYear.map((y) => `${String(y.year)} ${r(y.meanNetR)}/${String(y.trades)}`);
    console.log(`  ${v.variant} ${v.direction}: ${years.join("  ") || "no trades"}`);
  }
}

function printRow(row: RunRow, standing: NullModelStanding | null): void {
  console.log(
    `${row.id}  ${row.status.padEnd(9)} ${row.blind ? "blind " : ""}${row.name}` +
      `  (created ${row.createdAt.toISOString()}${row.gitCommit === null ? "" : `, commit ${row.gitCommit.slice(0, 8)}${row.gitDirty ? "+dirty" : ""}`}` +
      `${row.dataSnapshot === null ? "" : `, data ${row.dataSnapshot.id}`}` +
      `${standing === null ? "" : `, ${standing.short}`})`,
  );
  if (row.progress !== null && row.status === "running") {
    console.log(`  ${describeProgress(row.progress)}`);
  }
  if (row.error !== null) {
    console.log(`  ${row.error.split("\n")[0] ?? ""}`);
  }
}

/** The null model's standing for each run, from one query. */
async function standings(
  pool: pg.Pool,
  rows: readonly RunRow[],
): Promise<ReadonlyMap<string, NullModelStanding | null>> {
  const latest = await new NullModelStore(pool).latestFor(
    rows.flatMap((row) => (row.gitCommit === null ? [] : [row.gitCommit])),
  );
  return new Map(rows.map((row) => [row.id, nullModelStanding(row, latest.get(row.gitCommit ?? ""))]));
}

/** Computes a finished run's metrics from what it kept, and keeps them with it. Null for a blind run. */
async function saveMetrics(pool: pg.Pool, row: RunRow): Promise<string | null> {
  if (row.blind || row.status !== "completed") {
    return null;
  }
  const store = new RunStore(pool);
  const report = metricsReport(row, await store.trades(row.id), await store.sessions(row.id));
  const text = renderMetricsReport(report);
  await store.saveReport(row.id, METRICS_REPORT, report, text, await readGit());
  return text;
}

/** A run's summary if it has one, then the null model on its commit, which says whether any of it can be read. */
async function printResult(pool: pg.Pool, row: RunRow | null, keepMetrics = false): Promise<void> {
  if (row === null) {
    return;
  }
  if (row.summary !== null) {
    printSummary(row.summary);
  }
  if (keepMetrics && (await saveMetrics(pool, row)) !== null) {
    console.log(`metrics kept: pnpm backtest report ${row.id}`);
  }
  const standing = (await standings(pool, [row])).get(row.id);
  if (standing != null) {
    console.log(standing.line);
  }
}

async function withPool<T>(work: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: env("DATABASE_URL"), max: 8 });
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}

function dependencies(pool: pg.Pool): () => Promise<RunDependencies> {
  return async () => ({
    replay: new TimescaleReplaySource(pool),
    study: new TimescaleStudySource(pool),
    registration: await loadRegistration(),
    git: await readGit(),
  });
}

async function worker(): Promise<void> {
  const pool = new pg.Pool({ connectionString: env("DATABASE_URL"), max: 8 });
  const concurrency = Number(option("concurrency") ?? "1");
  const running = startWorker({
    connection: redisConnection(env("REDIS_URL")),
    store: new RunStore(pool),
    dependencies: dependencies(pool),
    concurrency,
  });
  running.on("active", (job) => console.log(`run ${job.data.runId} started`));
  running.on("completed", (job) => console.log(`run ${job.data.runId} completed`));
  running.on("failed", (job, error) => console.log(`run ${job?.data.runId ?? "?"} failed: ${error.message}`));
  console.log(`worker on queue "${QUEUE_NAME}", concurrency ${String(concurrency)}. Ctrl-C to stop.`);
  const stop = async () => {
    await running.close();
    await pool.end();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

async function submit(): Promise<void> {
  const config = readConfig(positional[0]);
  const connection = redisConnection(env("REDIS_URL"));
  await withPool(async (pool) => {
    const store = new RunStore(pool);
    const queue = backtestQueue(connection);
    const events = new QueueEvents(QUEUE_NAME, { connection });
    try {
      await events.waitUntilReady();
      const job = await submitRun(queue, store, config);
      console.log(`run ${String(job.id)} queued${config.blind ? " (blind)" : ""}`);
      if (flags.has("--detach")) {
        return;
      }
      const print = progressPrinter();
      events.on("progress", ({ jobId, data }) => {
        if (jobId === job.id) {
          print(data as RunProgress);
        }
      });
      try {
        await job.waitUntilFinished(events);
      } catch (error) {
        console.log(`run ${String(job.id)} failed: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }
      await printResult(pool, await store.get(String(job.id)), true);
    } finally {
      await events.close();
      await queue.close();
    }
  });
}

async function runHere(): Promise<void> {
  const config = readConfig(positional[0]);
  await withPool(async (pool) => {
    const store = new RunStore(pool);
    const runId = await store.create(config);
    console.log(`run ${runId}${config.blind ? " (blind)" : ""}, here`);
    const print = progressPrinter();
    let result: BacktestJobResult;
    try {
      result = await processRun(runId, { store, dependencies: dependencies(pool) }, (progress) => {
        print(progress as RunProgress);
        return Promise.resolve();
      });
    } catch (error) {
      console.log(`run ${runId} failed: ${(error as Error).message}`);
      process.exitCode = 1;
      return;
    }
    await printResult(pool, await store.get(result.runId), true);
  });
}

async function status(): Promise<void> {
  await withPool(async (pool) => {
    const store = new RunStore(pool);
    const id = positional[0];
    if (id === undefined) {
      const rows = await store.list();
      const standing = await standings(pool, rows);
      for (const row of rows) {
        printRow(row, standing.get(row.id) ?? null);
      }
      return;
    }
    const row = await store.get(id);
    if (row === null) {
      throw new Error(`no run ${id}`);
    }
    printRow(row, null);
    await printResult(pool, row);
  });
}

async function diff(): Promise<void> {
  const [a, b] = positional;
  if (a === undefined || b === undefined) {
    throw new Error("diff takes two run ids");
  }
  await withPool(async (pool) => {
    const store = new RunStore(pool);
    const [left, right] = await Promise.all([store.get(a), store.get(b)]);
    if (left === null || right === null) {
      throw new Error(`no run ${left === null ? a : b}`);
    }
    console.log(diffRuns(left, right).join("\n"));
  });
}

async function report(): Promise<void> {
  const [id] = positional;
  if (id === undefined) {
    throw new Error("report takes a run id");
  }
  await withPool(async (pool) => {
    const row = await new RunStore(pool).get(id);
    if (row === null) {
      throw new Error(`no run ${id}`);
    }
    const text = await saveMetrics(pool, row);
    if (text === null) {
      throw new Error(`run ${id} is ${row.blind ? "blind" : row.status}: no trades to measure`);
    }
    console.log(text);
  });
}

async function config(): Promise<void> {
  if (positional[0] !== "preregistered") {
    throw new Error("config takes: preregistered");
  }
  const registration = await loadRegistration();
  console.log(JSON.stringify(preregisteredConfig(registration, { blind: flags.has("--blind") }), null, 2));
}

function describeExit(exit: (typeof NULL_MODEL_EXITS)[keyof typeof NULL_MODEL_EXITS]): string {
  return exit.kind === "eod"
    ? "flatten at the end of the day"
    : `${String(exit.targetR)}R target, breakeven at ${String(exit.breakevenAtR)}R`;
}

async function nullModel(): Promise<void> {
  const git = await readGit();
  await withPool(async (pool) => {
    const store = new NullModelStore(pool);
    await store.ready();
    const on =
      git.commit === null ? "no commit" : `commit ${git.commit.slice(0, 8)}${git.dirty ? "+dirty" : ""}`;
    console.log(
      `null model on ${on}: ${NULL_MODEL_GATE_PATHS.toLocaleString()} driftless sessions for each of exits ${NULL_MODEL_EXIT_IDS.join(" and ")}`,
    );
    if (git.commit === null || git.dirty) {
      console.log(
        git.commit === null
          ? "not a git checkout: this run is recorded and counts for nothing"
          : "the checkout has uncommitted changes: this run is recorded and counts for no commit",
      );
    }
    const result = await runNullModelGate(NULL_MODEL_GATE_PATHS, {
      onStart: (exit) => console.log(`\nexit ${exit}, ${describeExit(NULL_MODEL_EXITS[exit])}:`),
      onReport: (_, report) => console.log(formatNullModelReport(report)),
    });
    const row = await store.record(git, result);
    console.log(
      `\nnull model: ${result.verdict.toUpperCase()} over every exit, ${seconds(result.elapsedMs)}, recorded as ${row.id}`,
    );
    if (result.verdict !== "pass") {
      process.exitCode = 1;
    }
  });
}

const ETF_LIST = path.relative(REPO_ROOT, EXCLUSIONS_PATH);

/** Runs a configuration here, recorded like any run, keeps its metrics, and hands back its row. */
async function runInline(pool: pg.Pool, config: RunConfig): Promise<RunRow> {
  const store = new RunStore(pool);
  const runId = await store.create(config);
  console.log(`run ${runId}: ${config.name}`);
  const print = progressPrinter();
  await processRun(runId, { store, dependencies: dependencies(pool) }, (progress) => {
    print(progress as RunProgress);
    return Promise.resolve();
  });
  const row = (await store.get(runId)) as RunRow;
  await saveMetrics(pool, row);
  return row;
}

/** What L.2's preconditions need to know about a run beyond its row. */
async function l2Facts(
  pool: pg.Pool,
  run: RunRow,
  expected: RunConfig,
  registration: Registration,
): Promise<RunFacts> {
  const commit = run.gitCommit;
  return {
    run,
    expected,
    registration,
    nullModel: commit === null ? undefined : (await new NullModelStore(pool).latestFor([commit])).get(commit),
    etfListInCommit: commit !== null && (await fileInCommit(commit, ETF_LIST)),
    unrankable: await new RunStore(pool).unrankable(run.id),
  };
}

/** Refuses before a replay is spent on a run that could never count. The report checks all of it again. */
async function l2Preflight(pool: pg.Pool, git: GitState): Promise<string> {
  if (git.commit === null || git.dirty) {
    throw new Error("L.2 runs only from a clean checkout: commit first, so the result names its code");
  }
  const commit = git.commit;
  const nullModel = (await new NullModelStore(pool).latestFor([commit])).get(commit);
  if (nullModel?.verdict !== "pass") {
    throw new Error(
      `the null model has ${nullModel === undefined ? "not run" : `not passed (${nullModel.verdict})`} on ${commit.slice(0, 8)}: pnpm backtest null-model first`,
    );
  }
  if (!(await fileInCommit(commit, ETF_LIST))) {
    throw new Error(`${ETF_LIST} is not in ${commit.slice(0, 8)}`);
  }
  return commit;
}

/**
 * The in-sample report for a run: the verdict, section 7, and, with a frozen configuration, the
 * as-deployed run on it. An as-deployed run already made for this report is used again when it ran the
 * same configuration on the same commit.
 */
async function l2Verdict(pool: pg.Pool, run: RunRow, registration: Registration): Promise<void> {
  const store = new RunStore(pool);
  const expected = preregisteredConfig(registration, { blind: false });
  const facts = await l2Facts(pool, run, expected, registration);
  const records = await store.trades(run.id);
  const costModel = costModelFor(expected);
  let report = inSampleReport({ ...facts, records, costModel, asDeployed: null });
  const frozen = report.result?.frozen ?? null;
  if (frozen !== null) {
    const config = asDeployedConfig(expected, registration.thresholds, frozen);
    const earlier = (await store.report<InSampleReport>(run.id, VERDICT_REPORT))?.content.result?.asDeployed
      ?.runId;
    let deployed = earlier === undefined ? null : await store.get(earlier);
    if (
      deployed === null ||
      deployed.status !== "completed" ||
      deployed.gitCommit !== run.gitCommit ||
      canonical(deployed.config) !== canonical(config)
    ) {
      console.log("an exit passed: the as-deployed run on the frozen configuration (section 7)");
      deployed = await runInline(pool, config);
    }
    const result = asDeployedResult(
      deployed,
      await store.trades(deployed.id),
      await store.sessions(deployed.id),
    );
    report = inSampleReport({ ...facts, records, costModel, asDeployed: result });
  }
  const text = renderInSampleReport(report);
  await store.saveReport(run.id, VERDICT_REPORT, report, text, await readGit());
  console.log(text);
}

async function l2(): Promise<void> {
  const [step, id] = positional;
  const git = await readGit();
  const registration = await loadRegistration();
  await withPool(async (pool) => {
    if (step === "in-sample") {
      await l2Preflight(pool, git);
      console.log(
        "L.2 in-sample: the pre-registered run with outcomes kept. This is the first look at the result.",
      );
      const run = await runInline(pool, preregisteredConfig(registration, { blind: false }));
      await l2Verdict(pool, run, registration);
    } else if (step === "verdict") {
      if (id === undefined) {
        throw new Error("l2 verdict takes a run id");
      }
      const run = await new RunStore(pool).get(id);
      if (run === null) {
        throw new Error(`no run ${id}`);
      }
      if (git.commit !== run.gitCommit || git.dirty) {
        throw new Error(
          `the verdict is computed by the code that ran: check out ${run.gitCommit?.slice(0, 8) ?? "its commit"} clean first`,
        );
      }
      await l2Verdict(pool, run, registration);
    } else if (step === "holdout") {
      if (registration.frozen === null) {
        throw new Error(
          "the holdout runs on a frozen configuration committed to Docs/Pre-Registration.md, and there is none",
        );
      }
      await l2Preflight(pool, git);
      console.log("L.2 holdout: the frozen configuration on the holdout, once.");
      const run = await runInline(pool, registration.frozen);
      const store = new RunStore(pool);
      const report = holdoutReport({
        ...(await l2Facts(pool, run, registration.frozen, registration)),
        records: await store.trades(run.id),
      });
      const text = renderHoldoutReport(report);
      await store.saveReport(run.id, HOLDOUT_REPORT, report, text, await readGit());
      console.log(text);
    } else {
      throw new Error("l2 takes: in-sample | verdict <run id> | holdout");
    }
  });
}

function dataClient(): AlpacaClient {
  return new AlpacaClient({
    keyId: env("ALPACA_KEY_ID"),
    secretKey: env("ALPACA_SECRET_KEY"),
    tradingUrl: env("ALPACA_BASE_URL"),
    dataUrl: process.env["ALPACA_DATA_URL"] ?? "https://data.alpaca.markets",
    dataRequestsPerMinute: Number(process.env["ALPACA_DATA_RATE_LIMIT"] ?? 200),
    feed: "sip",
    timeoutMs: 60_000,
  });
}

const COST_REPORT = "costs";

async function costs(): Promise<void> {
  const [id] = positional;
  if (id === undefined) {
    throw new Error("costs takes a run id");
  }
  const perYear = Number(option("per-year") ?? "50");
  const seed = Number(option("seed") ?? "20260924");
  const registration = await loadRegistration();
  const exits = registration.thresholds.strategy.exits.map((exit) => exit.id);
  const alpaca = dataClient();
  try {
    await withPool(async (pool) => {
      const store = new RunStore(pool);
      const run = await store.get(id);
      if (run === null || run.blind || run.status !== "completed") {
        throw new Error(`run ${id} is not a finished run with trades`);
      }
      // The confirmatory trades, grouped by signal: every exit on one entry.
      const bySignal = new Map<string, Record<string, TradeRecord>>();
      for (const t of await store.trades(id)) {
        if (
          exits.includes(t.variant) &&
          t.direction === "long" &&
          t.gatePassed &&
          t.entryOutcome === "filled"
        ) {
          const key = `${t.session} ${t.symbol}`;
          (bySignal.get(key) ?? bySignal.set(key, {}).get(key) ?? {})[t.variant] = t;
        }
      }
      const opens = new Map(
        (
          await pool.query<{ session: string; open_ms: string }>(
            "SELECT session::text AS session, (extract(epoch FROM open_at) * 1000)::bigint AS open_ms FROM market_sessions",
          )
        ).rows.map((row) => [row.session, Number(row.open_ms)]),
      );
      const signals: Signal[] = [...bySignal].map(([key, trades]) => {
        const [session = "", symbol = ""] = key.split(" ");
        return { session, symbol, openAt: opens.get(session) ?? Number.NaN, trades };
      });
      const sample = sampleSignals(signals, perYear, seed);
      console.log(`pricing ${String(sample.length)} of ${String(signals.length)} signals from the market`);
      const tape = new AlpacaTape(alpaca);
      const measured: MeasuredTrade[] = [];
      for (const signal of sample) {
        measured.push(await measureSignal(tape, signal));
        if (measured.length % 25 === 0) {
          console.log(`  ${String(measured.length)} of ${String(sample.length)}`);
        }
      }
      const settings = { runId: id, perYear, seed, latencyMs: LATENCY_MS };
      const summary = summarize(measured);
      const text = renderCostReport(settings, summary);
      await store.saveReport(id, COST_REPORT, { settings, summary, measured }, text, await readGit());
      console.log(text);
    });
  } finally {
    await alpaca.close();
  }
}

const commands: Record<string, () => Promise<void>> = {
  worker,
  submit,
  run: runHere,
  status,
  diff,
  report,
  config,
  "null-model": nullModel,
  l2,
  costs,
};
const chosen = commands[command];
if (chosen === undefined) {
  console.log(
    "usage: pnpm backtest worker | submit <config.json> | run <config.json> | status [<run id>] | diff <a> <b> | report <run id> | config preregistered | null-model | l2 in-sample | l2 verdict <run id> | l2 holdout | costs <run id>",
  );
  process.exitCode = 1;
} else {
  await chosen();
}
