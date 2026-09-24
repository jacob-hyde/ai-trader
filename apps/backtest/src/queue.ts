/**
 * The backtest queue: BullMQ on Redis (L.1).
 *
 * A job carries only a run id. The configuration lives in the run's row, written when the run is
 * submitted, so what the worker executes is exactly what was stored, and a web app can enqueue the same
 * way the CLI does (K.x). Progress goes out on the job, for anyone tailing it, and into the row.
 *
 * One attempt per job. A replay is deterministic, so retrying a failure fails the same way; the error
 * goes into the row and the queue moves on to the next job. A job whose worker dies is not handed to
 * another worker either (maxStalledCount 0): it fails, and the run is marked failed, rather than a
 * second copy running beside a first that might still be writing.
 *
 * Runs are isolated by construction: each job builds its own adapter, universe, and engine, and writes
 * only rows under its own run id. Concurrency is the worker's setting and defaults to one.
 */

import { type ConnectionOptions, type Job, Queue, Worker } from "bullmq";
import type { RunConfig } from "./config.js";
import { type RunDependencies, runBacktest } from "./run.js";
import { RunNotQueued, type RunStore } from "./store.js";

export const QUEUE_NAME = "backtest";

export interface BacktestJob {
  readonly runId: string;
}

export interface BacktestJobResult {
  readonly runId: string;
  readonly blind: boolean;
}

/** BullMQ's workers block on Redis, so their connection must never give up on a request. */
export function redisConnection(url: string): ConnectionOptions {
  return { url, maxRetriesPerRequest: null };
}

/** The queue. A test passes its own name, so a worker left running on the real queue never takes its jobs. */
export function backtestQueue(
  connection: ConnectionOptions,
  name = QUEUE_NAME,
): Queue<BacktestJob, BacktestJobResult> {
  return new Queue<BacktestJob, BacktestJobResult>(name, { connection });
}

/**
 * Records the run and queues it. The row exists before the job, so a worker never takes a job without
 * one. If queueing fails, the row is marked failed, never left queued with nothing coming for it.
 */
export async function submitRun(
  queue: Queue<BacktestJob, BacktestJobResult>,
  store: RunStore,
  config: RunConfig,
): Promise<Job<BacktestJob, BacktestJobResult>> {
  const runId = await store.create(config);
  try {
    return await queue.add(
      "run",
      { runId },
      {
        jobId: runId,
        attempts: 1,
        removeOnComplete: { age: 7 * 86_400 },
        removeOnFail: { age: 30 * 86_400 },
      },
    );
  } catch (error) {
    await store.fail(runId, error);
    throw error;
  }
}

export interface WorkerOptions {
  readonly connection: ConnectionOptions;
  readonly store: RunStore;
  /**
   * What a run reads. Called once per job, so each run takes the registration and the git state as
   * they are when it starts.
   */
  readonly dependencies: () => Promise<RunDependencies>;
  readonly concurrency?: number;
  readonly queueName?: string;
}

/** Runs one job to the end. Exported so a test, or an inline run, can drive it without a worker. */
export async function processRun(
  runId: string,
  options: Pick<WorkerOptions, "store" | "dependencies">,
  onProgress: (progress: unknown) => Promise<void> = () => Promise.resolve(),
): Promise<BacktestJobResult> {
  const { store } = options;
  try {
    const deps = await options.dependencies();
    const config = await store.claim(runId, deps.git, deps.registration);
    const summary = await runBacktest(config, deps, {
      onProgress: async (progress) => {
        await onProgress(progress);
        await store.progress(runId, progress);
      },
      onSession: (result) => store.saveSession(runId, result),
    });
    await store.complete(runId, summary);
    return { runId, blind: summary.blind };
  } catch (error) {
    // A run someone else holds is theirs to finish or fail.
    if (!(error instanceof RunNotQueued)) {
      await store.fail(runId, error);
    }
    throw error;
  }
}

export function startWorker(options: WorkerOptions): Worker<BacktestJob, BacktestJobResult> {
  const worker = new Worker<BacktestJob, BacktestJobResult>(
    options.queueName ?? QUEUE_NAME,
    (job) => processRun(job.data.runId, options, (progress) => job.updateProgress(progress as object)),
    {
      connection: options.connection,
      concurrency: options.concurrency ?? 1,
      // A run renews its lock between minutes, so a long run never looks stalled while it is alive.
      lockDuration: 120_000,
      maxStalledCount: 0,
    },
  );
  // A job that stalled never reached processRun's own error handling.
  worker.on("failed", (job, error) => {
    if (job !== undefined) {
      void options.store.fail(job.data.runId, error).catch(() => undefined);
    }
  });
  return worker;
}
