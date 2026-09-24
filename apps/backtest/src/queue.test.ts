import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Job, type Queue, QueueEvents, type Worker } from "bullmq";
import type { Scenario } from "@trader/core";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunConfig } from "./config.js";
import {
  type BacktestJob,
  type BacktestJobResult,
  backtestQueue,
  processRun,
  redisConnection,
  startWorker,
  submitRun,
} from "./queue.js";
import { type RunProgress, runBacktest } from "./run.js";
import { RunNotQueued, RunStore } from "./store.js";
import {
  CLEAN,
  dependencies,
  halfDay,
  registrationFor,
  syntheticMarket,
  testConfig,
  weekdays,
} from "./testing.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../../.env") });

const engineUrl = process.env["DATABASE_URL"] ?? "";
const redisUrl = process.env["REDIS_URL"] ?? "";

// Synthetic sessions only, even against the real database: a test must never replay real in-sample bars.
const WARMUP = weekdays("2026-01-05", 20);
const SESSIONS = weekdays("2026-02-02", 5).map((hours, i) => (i === 4 ? halfDay(hours) : hours));
const SYMBOLS = ["QA", "QB", "QC", "QD", "QE", "QF"];
const SCENARIOS: readonly Scenario[] = ["driftlessWalk", "gapThroughStop", "stopRunWick"];
const MARKET = syntheticMarket({
  symbols: SYMBOLS,
  warmup: WARMUP,
  sessions: SESSIONS,
  scenario: (symbol, session) =>
    SCENARIOS[(SYMBOLS.indexOf(symbol) + SESSIONS.findIndex((h) => h.session === session)) % 3] as Scenario,
});
const REGISTRATION = registrationFor({ holdoutFrom: "2027-01-04" });
const deps = () => Promise.resolve(dependencies(MARKET, REGISTRATION));

describe.skipIf(engineUrl === "" || redisUrl === "")("the backtest queue", () => {
  const connection = redisConnection(redisUrl);
  const queueName = `backtest-test-${String(process.pid)}-${String(Date.now())}`;
  const runs: string[] = [];
  let pool: pg.Pool;
  let store: RunStore;
  let queue: Queue<BacktestJob, BacktestJobResult>;
  let events: QueueEvents;
  let worker: Worker<BacktestJob, BacktestJobResult>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: engineUrl, max: 4 });
    store = new RunStore(pool);
    queue = backtestQueue(connection, queueName);
    events = new QueueEvents(queueName, { connection });
    await events.waitUntilReady();
    worker = startWorker({ connection, store, dependencies: deps, queueName, concurrency: 2 });
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    await events.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await pool.query("DELETE FROM backtest_runs WHERE id = ANY($1)", [runs]);
    await pool.end();
  });

  async function submit(config: RunConfig): Promise<Job<BacktestJob, BacktestJobResult>> {
    const job = await submitRun(queue, store, config);
    runs.push(String(job.id));
    return job;
  }

  async function counts(runId: string): Promise<{ sessions: number; trades: number; fills: number }> {
    const result = await pool.query<{ sessions: number; trades: number; fills: number }>(
      `SELECT (SELECT count(*)::int FROM backtest_sessions WHERE run_id = $1) AS sessions,
         (SELECT count(*)::int FROM backtest_trades WHERE run_id = $1) AS trades,
         (SELECT count(*)::int FROM backtest_fills WHERE run_id = $1) AS fills`,
      [runId],
    );
    return result.rows[0] as { sessions: number; trades: number; fills: number };
  }

  it("runs a submitted configuration to the end, with progress, and keeps what it made under its id", async () => {
    const config = testConfig({ name: "queue test" });
    const progress: RunProgress[] = [];
    const job = await submit(config);
    events.on("progress", ({ jobId, data }) => {
      if (jobId === job.id) {
        progress.push(data as RunProgress);
      }
    });
    expect(await job.waitUntilFinished(events, 60_000)).toEqual({ runId: job.id, blind: false });

    const row = await store.get(String(job.id));
    expect(row).toMatchObject({
      status: "completed",
      blind: false,
      name: "queue test",
      gitCommit: CLEAN.commit,
      gitDirty: false,
      registrationVersion: 2,
      error: null,
      progress: { phase: "replay", sessionsDone: 5, sessionsTotal: 5 },
    });
    expect(progress.at(-1)).toMatchObject({ phase: "replay", sessionsDone: 5, sessionsTotal: 5 });

    // What the queue kept is what the same run makes here, trade for trade.
    const records: Array<{ variant: string; symbol: string; session: string; netR: number | null }> = [];
    const inline = await runBacktest(config, await deps(), {
      onSession: (result) => void records.push(...result.records),
    });
    expect(row?.summary).toMatchObject({ ...inline, elapsedMs: expect.any(Number) });
    const kept = await pool.query<{ variant: string; symbol: string; session: string; net_r: number | null }>(
      `SELECT variant, symbol, to_char(session, 'YYYY-MM-DD') AS session, net_r FROM backtest_trades
       WHERE run_id = $1 ORDER BY session, symbol, variant`,
      [job.id],
    );
    const key = (r: { session: string; symbol: string; variant: string }) =>
      `${r.session} ${r.symbol} ${r.variant}`;
    expect(kept.rows.map((r) => [key(r), r.net_r])).toEqual(
      records.sort((a, b) => (key(a) < key(b) ? -1 : 1)).map((r) => [key(r), r.netR]),
    );
    const { sessions, fills } = await counts(String(job.id));
    expect(sessions).toBe(5);
    const filled = records.filter((r) => r.netR !== null).length;
    expect(fills).toBe(2 * filled);
  });

  it("keeps runs at the same time apart, and a failed run fails alone without stopping the queue", async () => {
    const both = await submit(testConfig({ name: "both sides" }));
    const broken = await submit(testConfig({ name: "no sessions", from: "2025-06-02", to: "2025-06-30" }));
    const longs = await submit(testConfig({ name: "longs only", shorts: false }));
    const [a, b, c] = await Promise.allSettled([
      both.waitUntilFinished(events, 60_000),
      broken.waitUntilFinished(events, 60_000),
      longs.waitUntilFinished(events, 60_000),
    ]);
    expect([a.status, b.status, c.status]).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect((b as PromiseRejectedResult).reason).toMatchObject({
      message: expect.stringMatching(/no sessions/),
    });
    expect(await store.get(String(broken.id))).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/no sessions from 2025-06-02 to 2025-06-30/),
    });

    const shorts = await pool.query<{ run_id: string; n: number }>(
      `SELECT run_id, count(*)::int AS n FROM backtest_trades WHERE run_id = ANY($1) AND direction = 'short'
       GROUP BY run_id`,
      [[both.id, longs.id]],
    );
    expect(shorts.rows.map((r) => r.run_id)).toEqual([both.id]);
    for (const job of [both, longs]) {
      const row = await store.get(String(job.id));
      const signals = row?.summary?.signals ?? 0;
      expect((await counts(String(job.id))).trades).toBe(signals * 3);
    }
  });

  it("keeps nothing after the range close for a blind run", async () => {
    const job = await submit(testConfig({ name: "blind", blind: true }));
    expect(await job.waitUntilFinished(events, 60_000)).toEqual({ runId: job.id, blind: true });
    expect(await counts(String(job.id))).toEqual({ sessions: 5, trades: 0, fills: 0 });
    expect((await store.get(String(job.id)))?.summary?.outcomes).toBeNull();
  });

  it("never runs a job twice, and never fails a run another worker holds", async () => {
    const job = await submit(testConfig({ name: "once" }));
    await job.waitUntilFinished(events, 60_000);
    await expect(processRun(String(job.id), { store, dependencies: deps })).rejects.toThrow(RunNotQueued);
    expect((await store.get(String(job.id)))?.status).toBe("completed");
  });
});
