/**
 * The backtest CLI. Needs no web app: queue a run and follow it, run one here, or look at past runs.
 *
 *   pnpm backtest worker [--concurrency n]           takes queued runs until stopped
 *   pnpm backtest submit <config.json> [--blind] [--detach]
 *                                                    queues a run and follows it to the end
 *   pnpm backtest run <config.json> [--blind]        runs it here, without Redis, recorded the same way
 *   pnpm backtest status [<run id>]                  recent runs, or one of them
 *   pnpm backtest config preregistered [--blind]
 *                                                    prints the pre-registered in-sample configuration
 *
 * A path is taken relative to where pnpm was run. DATABASE_URL (the engine role) is always needed,
 * REDIS_URL for worker and submit.
 *
 * A blind run prints what was known by 09:35 and its timing, and nothing else: no trade, fill, trigger
 * count, or R reaches the terminal or the database (run.ts).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { TimescaleReplaySource } from "@trader/data/replay";
import { QueueEvents } from "bullmq";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { type RunConfig, parseRunConfig } from "./config.js";
import { readGit } from "./git.js";
import { preregisteredConfig } from "./preregistered.js";
import {
  type BacktestJobResult,
  QUEUE_NAME,
  backtestQueue,
  processRun,
  redisConnection,
  startWorker,
  submitRun,
} from "./queue.js";
import { REPO_ROOT, loadRegistration } from "./registration.js";
import type { RunDependencies, RunProgress, RunSummary } from "./run.js";
import { type RunRow, RunStore } from "./store.js";
import { TimescaleStudySource } from "./timescale.js";

loadDotenv({ path: path.join(REPO_ROOT, ".env") });

const [command = "", ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
const positional = rest.filter((arg, i) => !arg.startsWith("--") && !rest[i - 1]?.match(/^--concurrency$/));

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
  return parseRunConfig(flags.has("--blind") ? { ...raw, blind: true } : raw);
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
}

function printRow(row: RunRow): void {
  console.log(
    `${row.id}  ${row.status.padEnd(9)} ${row.blind ? "blind " : ""}${row.name}` +
      `  (created ${row.createdAt.toISOString()}${row.gitCommit === null ? "" : `, commit ${row.gitCommit.slice(0, 8)}${row.gitDirty ? "+dirty" : ""}`})`,
  );
  if (row.progress !== null && row.status === "running") {
    console.log(`  ${describeProgress(row.progress)}`);
  }
  if (row.error !== null) {
    console.log(`  ${row.error.split("\n")[0] ?? ""}`);
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
      const row = await store.get(String(job.id));
      if (row?.summary != null) {
        printSummary(row.summary);
      }
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
    const row = await store.get(result.runId);
    if (row?.summary != null) {
      printSummary(row.summary);
    }
  });
}

async function status(): Promise<void> {
  await withPool(async (pool) => {
    const store = new RunStore(pool);
    const id = positional[0];
    if (id === undefined) {
      for (const row of await store.list()) {
        printRow(row);
      }
      return;
    }
    const row = await store.get(id);
    if (row === null) {
      throw new Error(`no run ${id}`);
    }
    printRow(row);
    if (row.summary !== null) {
      printSummary(row.summary);
    }
  });
}

async function config(): Promise<void> {
  if (positional[0] !== "preregistered") {
    throw new Error("config takes: preregistered");
  }
  const registration = await loadRegistration();
  console.log(JSON.stringify(preregisteredConfig(registration, { blind: flags.has("--blind") }), null, 2));
}

const commands: Record<string, () => Promise<void>> = { worker, submit, run: runHere, status, config };
const chosen = commands[command];
if (chosen === undefined) {
  console.log(
    "usage: pnpm backtest worker | submit <config.json> | run <config.json> | status [<run id>] | config preregistered",
  );
  process.exitCode = 1;
} else {
  await chosen();
}
