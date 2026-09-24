/**
 * The null-model gate (L.3): the tripwire (D.4) run on this checkout for each confirmatory exit, kept
 * against the commit (migration 0007), and shown next to any backtest run from the same commit.
 *
 * No L.2 number is read until the null model passes on the commit that produced it (pre-registration
 * section 3). The configuration is core's standing one and takes no settings, and the tripwire is seeded,
 * so every run on a commit is the same run and its verdict is a fact about that commit. A run from a
 * checkout with uncommitted changes is kept and counts for nothing.
 *
 * It runs the decision core (the ORB, the cost gate, sizing, the risk rules, the bracket builder, and the
 * trade simulator), not the L.1 runner. The runner is held to that simulator trade for trade by the parity
 * test in run.test.ts, so a leak in the runner's own replay would have to get past that test first.
 */

import {
  NULL_MODEL_EXITS,
  NULL_MODEL_GATE_PATHS,
  type NullModelExit,
  type NullModelReport,
  combinedVerdict,
  runNullModel,
  standingNullModel,
} from "@trader/core";
import type pg from "pg";
import type { GitState } from "./guard.js";

export type NullModelVerdict = NullModelReport["verdict"];

export interface NullModelGateResult {
  readonly verdict: NullModelVerdict;
  /** Per exit, the same paths for each. */
  readonly paths: number;
  readonly reports: Readonly<Record<NullModelExit, NullModelReport>>;
  readonly elapsedMs: number;
}

export interface NullModelGateHooks {
  /** Before each exit. At gate scale its run then holds the thread for about a minute and a half. */
  readonly onStart?: (exit: NullModelExit) => void;
  readonly onReport?: (exit: NullModelExit, report: NullModelReport) => void;
}

export const NULL_MODEL_EXIT_IDS = Object.keys(NULL_MODEL_EXITS) as readonly NullModelExit[];

/**
 * Runs the standing tripwire once for each confirmatory exit, in order.
 *
 * Yields to the event loop before each exit, so a line printed in onStart reaches a pipe before the long
 * synchronous run starts. On macOS a write to a pipe is asynchronous.
 */
export async function runNullModelGate(
  paths = NULL_MODEL_GATE_PATHS,
  hooks: NullModelGateHooks = {},
): Promise<NullModelGateResult> {
  const started = Date.now();
  const reports: Partial<Record<NullModelExit, NullModelReport>> = {};
  for (const exit of NULL_MODEL_EXIT_IDS) {
    hooks.onStart?.(exit);
    await new Promise((resolve) => setImmediate(resolve));
    const report = runNullModel(standingNullModel(exit, paths));
    reports[exit] = report;
    hooks.onReport?.(exit, report);
  }
  const complete = reports as Record<NullModelExit, NullModelReport>;
  return {
    verdict: combinedVerdict(Object.values(complete)),
    paths,
    reports: complete,
    elapsedMs: Date.now() - started,
  };
}

export interface NullModelRow {
  readonly id: string;
  readonly gitCommit: string | null;
  readonly gitDirty: boolean;
  readonly verdict: NullModelVerdict;
  readonly paths: number;
  readonly reports: Readonly<Record<string, NullModelReport>>;
  readonly elapsedMs: number;
  readonly createdAt: Date;
}

interface NullModelDbRow {
  id: string;
  git_commit: string | null;
  git_dirty: boolean;
  verdict: NullModelVerdict;
  paths: number;
  reports: Record<string, NullModelReport>;
  elapsed_ms: number;
  created_at: Date;
}

const fromDb = (row: NullModelDbRow): NullModelRow => ({
  id: row.id,
  gitCommit: row.git_commit,
  gitDirty: row.git_dirty,
  verdict: row.verdict,
  paths: row.paths,
  reports: row.reports,
  elapsedMs: row.elapsed_ms,
  createdAt: row.created_at,
});

const COLUMNS = "id, git_commit, git_dirty, verdict, paths, reports, elapsed_ms, created_at";

export class NullModelStore {
  readonly #pool: pg.Pool;

  /** The engine role is enough. */
  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  /** Throws when the database or the table is not there, so a run finds out before it spends minutes. */
  async ready(): Promise<void> {
    await this.#pool.query("SELECT 1 FROM null_model_runs LIMIT 0");
  }

  async record(git: GitState, result: NullModelGateResult): Promise<NullModelRow> {
    const inserted = await this.#pool.query<NullModelDbRow>(
      `INSERT INTO null_model_runs (id, git_commit, git_dirty, verdict, paths, reports, elapsed_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COLUMNS}`,
      [
        crypto.randomUUID(),
        git.commit,
        git.dirty,
        result.verdict,
        result.paths,
        JSON.stringify(result.reports),
        result.elapsedMs,
      ],
    );
    return fromDb(inserted.rows[0] as NullModelDbRow);
  }

  /** For each commit that has one, its latest run from a clean checkout. Dirty runs never count. */
  async latestFor(commits: readonly string[]): Promise<ReadonlyMap<string, NullModelRow>> {
    const result = await this.#pool.query<NullModelDbRow>(
      `SELECT DISTINCT ON (git_commit) ${COLUMNS}
       FROM null_model_runs
       WHERE git_commit = ANY($1) AND NOT git_dirty
       ORDER BY git_commit, created_at DESC`,
      [[...new Set(commits)]],
    );
    return new Map(result.rows.map((row) => [row.git_commit as string, fromDb(row)]));
  }
}

/** The null model's standing for a backtest run, once for a list and once as a line of its own. */
export interface NullModelStanding {
  readonly short: string;
  readonly line: string;
}

/**
 * What a reader of a backtest run needs to know about the null model on the run's commit. Null while the
 * run has no commit, e.g. still queued, since the commit is the one the worker ran.
 *
 * A dirty run's commit does not name its code, so no null model speaks for it. A failed null model voids
 * every number from its commit, and one that was never run leaves them unread.
 */
export function nullModelStanding(
  run: { readonly gitCommit: string | null; readonly gitDirty: boolean | null },
  latest: NullModelRow | undefined,
): NullModelStanding | null {
  if (run.gitCommit === null) {
    return null;
  }
  const commit = run.gitCommit.slice(0, 8);
  if (run.gitDirty === true) {
    return {
      short: "null model n/a",
      line: "null model: does not apply, the run's checkout had uncommitted changes, so no commit names its code",
    };
  }
  if (latest === undefined) {
    return {
      short: "null model not run",
      line: `null model: NOT RUN on ${commit}. Run pnpm backtest null-model on it before reading any number here.`,
    };
  }
  const when = `${latest.createdAt.toISOString()}, ${latest.id}`;
  switch (latest.verdict) {
    case "pass":
      return { short: "null model pass", line: `null model: PASS on ${commit} (${when})` };
    case "fail":
      return {
        short: "null model FAIL",
        line: `null model: FAIL on ${commit} (${when}). No number from this commit counts (pre-registration sections 3 and 10).`,
      };
    case "insufficient":
      return {
        short: "null model insufficient",
        line: `null model: INSUFFICIENT on ${commit} (${when}), which is not a pass.`,
      };
  }
}
