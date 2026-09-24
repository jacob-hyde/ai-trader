/**
 * Where runs are kept (migration 0005): one row per run, and under it its sessions, trades, and fills.
 *
 * A run is created "queued" with its parsed configuration, claimed "running" by exactly one worker,
 * and ends "completed" with its summary or "failed" with the error. The worker records the commit, the
 * registration, and the data snapshot it ran under at the claim, since that is the code and the data
 * that ran (L.5).
 *
 * Each session goes in as one transaction, so a run that dies midway leaves whole sessions behind and
 * never half of one.
 */

import type pg from "pg";
import { type RunConfig, parseRunConfig } from "./config.js";
import type { GitState } from "./guard.js";
import type { Registration } from "./registration.js";
import type { RunProgress, RunSummary, SessionResult } from "./run.js";
import type { DataSnapshot } from "./universe.js";

export type RunStatus = "queued" | "running" | "completed" | "failed";

/** The run is missing or not queued: another worker has it, or it already ran. Not this worker's to fail. */
export class RunNotQueued extends Error {
  constructor(id: string) {
    super(`run ${id} is not queued`);
    this.name = "RunNotQueued";
  }
}

export interface RunRow {
  readonly id: string;
  readonly name: string;
  readonly status: RunStatus;
  readonly blind: boolean;
  readonly config: unknown;
  readonly gitCommit: string | null;
  readonly gitDirty: boolean | null;
  readonly registrationVersion: number | null;
  readonly registrationSha256: string | null;
  readonly dataSnapshot: DataSnapshot | null;
  readonly progress: RunProgress | null;
  readonly summary: RunSummary | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

/** Postgres takes at most 65,535 parameters in one statement. */
const MAX_PARAMETERS = 60_000;

async function insertRows(
  client: pg.PoolClient,
  table: string,
  columns: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
): Promise<void> {
  const perRow = columns.length;
  const chunk = Math.floor(MAX_PARAMETERS / perRow);
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const values = slice
      .map((_, r) => `(${columns.map((_, c) => `$${String(r * perRow + c + 1)}`).join(", ")})`)
      .join(", ");
    await client.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values}`, slice.flat());
  }
}

function message(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export class RunStore {
  readonly #pool: pg.Pool;

  /** The engine role is enough: runs are rows, never schema. */
  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async create(config: RunConfig): Promise<string> {
    const id = crypto.randomUUID();
    await this.#pool.query(
      `INSERT INTO backtest_runs (id, name, status, blind, config) VALUES ($1, $2, 'queued', $3, $4)`,
      [id, config.name, config.blind, JSON.stringify(config)],
    );
    return id;
  }

  /**
   * Takes a queued run for this worker and returns its configuration. Throws RunNotQueued when the run
   * does not exist or is not queued, so a job delivered twice never runs twice.
   */
  async claim(
    id: string,
    git: GitState,
    registration: Registration,
    snapshot: DataSnapshot,
  ): Promise<RunConfig> {
    const result = await this.#pool.query<{ config: unknown }>(
      `UPDATE backtest_runs
       SET status = 'running', started_at = now(), git_commit = $2, git_dirty = $3,
         registration_version = $4, registration_sha256 = $5, data_snapshot = $6
       WHERE id = $1 AND status = 'queued'
       RETURNING config`,
      [
        id,
        git.commit,
        git.dirty,
        registration.thresholds.version,
        registration.sha256,
        JSON.stringify(snapshot),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new RunNotQueued(id);
    }
    return parseRunConfig(row.config);
  }

  async progress(id: string, progress: RunProgress): Promise<void> {
    await this.#pool.query(`UPDATE backtest_runs SET progress = $2 WHERE id = $1`, [
      id,
      JSON.stringify(progress),
    ]);
  }

  async saveSession(id: string, result: SessionResult): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const { stats } = result;
      await client.query(
        `INSERT INTO backtest_sessions
           (run_id, session, eligible, qualified, in_play, unrankable, unrankable_symbols, signals, by_variant,
            bad_ticks, corrupt_symbols)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          stats.session,
          stats.eligible,
          stats.qualified,
          stats.inPlay,
          stats.unrankable,
          JSON.stringify(stats.unrankableSymbols),
          stats.signals,
          JSON.stringify(stats.byVariant),
          result.badTicks === null ? null : JSON.stringify(result.badTicks),
          JSON.stringify(stats.corruptSymbols),
        ],
      );
      // prettier-ignore
      await insertRows(
        client,
        "backtest_trades",
        [
          "run_id", "variant", "symbol", "session", "direction", "rank", "opening_rvol", "daily_atr",
          "prior_close", "signal_minute", "entry", "stop", "target", "cost_per_share", "cost_to_risk",
          "gate_passed", "refusal", "shares", "entry_outcome", "entry_minute", "entry_reference",
          "entry_fill", "exit_minute", "exit_reason", "exit_reference", "exit_fill", "gross_pnl",
          "net_pnl", "gross_r", "net_r",
        ],
        result.records.map((r) => [
          id, r.variant, r.symbol, r.session, r.direction, r.rank, r.openingRvol, r.dailyAtr,
          r.priorClose, r.signalMinute, r.entry, r.stop, r.target, r.costPerShare, r.costToRisk,
          r.gatePassed, r.refusal, r.shares, r.entryOutcome, r.entryMinute, r.entryReference,
          r.entryFill, r.exitMinute, r.exitReason, r.exitReference, r.exitFill, r.grossPnl,
          r.netPnl, r.grossR, r.netR,
        ]),
      );
      // prettier-ignore
      await insertRows(
        client,
        "backtest_fills",
        [
          "run_id", "fill_id", "order_id", "client_order_id", "leg", "symbol", "side", "quantity",
          "price", "reference", "kind", "fees", "at",
        ],
        result.fills.map((f) => [
          id, f.fillId, f.orderId, f.clientOrderId, f.leg, f.symbol, f.side, f.quantity, f.price,
          f.reference, f.kind, f.fees, f.at,
        ]),
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(id: string, summary: RunSummary): Promise<void> {
    await this.#pool.query(
      `UPDATE backtest_runs SET status = 'completed', summary = $2, finished_at = now() WHERE id = $1`,
      [id, JSON.stringify(summary)],
    );
  }

  /** Marks a run failed unless it already finished. Safe to call twice. */
  async fail(id: string, error: unknown): Promise<void> {
    await this.#pool.query(
      `UPDATE backtest_runs SET status = 'failed', error = $2, finished_at = now()
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [id, message(error)],
    );
  }

  async get(id: string): Promise<RunRow | null> {
    return (await this.#select("WHERE id = $1", [id]))[0] ?? null;
  }

  /** Newest first. */
  async list(limit = 20): Promise<readonly RunRow[]> {
    return this.#select("ORDER BY created_at DESC LIMIT $1", [limit]);
  }

  async #select(where: string, values: unknown[]): Promise<RunRow[]> {
    const result = await this.#pool.query<{
      id: string;
      name: string;
      status: RunStatus;
      blind: boolean;
      config: unknown;
      git_commit: string | null;
      git_dirty: boolean | null;
      registration_version: number | null;
      registration_sha256: string | null;
      data_snapshot: DataSnapshot | null;
      progress: RunProgress | null;
      summary: RunSummary | null;
      error: string | null;
      created_at: Date;
      started_at: Date | null;
      finished_at: Date | null;
    }>(
      `SELECT id, name, status, blind, config, git_commit, git_dirty, registration_version,
         registration_sha256, data_snapshot, progress, summary, error, created_at, started_at, finished_at
       FROM backtest_runs ${where}`,
      values,
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      blind: row.blind,
      config: row.config,
      gitCommit: row.git_commit,
      gitDirty: row.git_dirty,
      registrationVersion: row.registration_version,
      registrationSha256: row.registration_sha256,
      dataSnapshot: row.data_snapshot,
      progress: row.progress,
      summary: row.summary,
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }));
  }
}
