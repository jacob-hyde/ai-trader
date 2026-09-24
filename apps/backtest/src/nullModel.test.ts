import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_TRADES,
  NULL_MODEL_EXITS,
  NULL_MODEL_GATE_PATHS,
  type NullModelReport,
  combinedVerdict,
  orbParamsSchema,
  ratio,
  runNullModel,
  standingNullModel,
} from "@trader/core";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NULL_MODEL_EXIT_IDS,
  type NullModelGateResult,
  type NullModelRow,
  NullModelStore,
  nullModelStanding,
  runNullModelGate,
} from "./nullModel.js";
import { loadRegistration } from "./registration.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../../.env") });

const engineUrl = process.env["DATABASE_URL"] ?? "";

describe("the null-model gate", () => {
  it("runs the standing tripwire for every confirmatory exit, in order, on the same paths", async () => {
    const heard: string[] = [];
    const result = await runNullModelGate(300, {
      onStart: (exit) => heard.push(`start ${exit}`),
      onReport: (exit, report) => heard.push(`report ${exit} ${report.verdict}`),
    });
    expect(NULL_MODEL_EXIT_IDS).toEqual(["A", "B"]);
    expect(result.paths).toBe(300);
    for (const exit of NULL_MODEL_EXIT_IDS) {
      expect(result.reports[exit]).toEqual(runNullModel(standingNullModel(exit, 300)));
    }
    expect(result.verdict).toBe(combinedVerdict(Object.values(result.reports)));
    expect(heard).toEqual([
      "start A",
      `report A ${result.reports.A.verdict}`,
      "start B",
      `report B ${result.reports.B.verdict}`,
    ]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("runs without hooks", async () => {
    expect((await runNullModelGate(40)).verdict).toBe("insufficient");
  });
});

describe("the gate against the registration (Amendment 5)", () => {
  it("runs what section 11 registers: paths, first seed, exits, trade minimum, and tolerance", async () => {
    const registered = (await loadRegistration()).thresholds.nullModel;
    expect(NULL_MODEL_GATE_PATHS).toBe(registered.paths);
    expect(MIN_TRADES).toBe(registered.minTrades);
    expect(NULL_MODEL_EXIT_IDS).toEqual(registered.exits);
    for (const exit of NULL_MODEL_EXIT_IDS) {
      const config = standingNullModel(exit);
      expect(config.firstSeed).toBe(registered.firstSeed);
      expect(config.grossToleranceR).toBe(registered.grossToleranceR);
    }
  });

  it("tests the registered strategy: long only, its stop and exits, its cost gate, and its session cutoffs", async () => {
    const { strategy } = (await loadRegistration()).thresholds;
    expect(strategy.exits.map((exit) => exit.id)).toEqual(Object.keys(NULL_MODEL_EXITS));
    for (const { id, ...exit } of strategy.exits) {
      const config = standingNullModel(id as keyof typeof NULL_MODEL_EXITS);
      expect(config.setupParams).toEqual({ stop: strategy.stop, exit });
      const params = orbParamsSchema.parse(config.setupParams);
      expect(params.allowShort).toBe(false);
      expect(params.openingRangeMinutes).toBe(strategy.openingRangeMinutes);
      expect(params.lastEntryMinute).toBe(390 - strategy.lastEntryMinutesBeforeClose);
      expect(config.flattenMinute).toBe(390 - strategy.flattenMinutesBeforeClose);
      expect(config.decision.costToRisk.maxCostToRisk).toBe(
        ratio(Math.round(strategy.maxCostToRisk * 10_000)),
      );
    }
  });
});

const row = (verdict: NullModelRow["verdict"]): NullModelRow => ({
  id: "4f0c0f0e-0000-4000-8000-000000000001",
  gitCommit: "0123456789abcdef",
  gitDirty: false,
  verdict,
  paths: 100_000,
  reports: {},
  elapsedMs: 150_000,
  createdAt: new Date("2026-09-24T15:00:00Z"),
});

describe("the null model's standing next to a backtest run", () => {
  const run = { gitCommit: "0123456789abcdef", gitDirty: false };

  it("says nothing while the run has no commit", () => {
    expect(nullModelStanding({ gitCommit: null, gitDirty: null }, row("pass"))).toBeNull();
  });

  it("does not apply to a run from a dirty checkout, whatever ran on its commit", () => {
    const standing = nullModelStanding({ ...run, gitDirty: true }, row("pass"));
    expect(standing?.short).toBe("null model n/a");
    expect(standing?.line).toContain("uncommitted changes");
  });

  it("says when it was never run on the commit, and how to run it", () => {
    const standing = nullModelStanding(run, undefined);
    expect(standing?.short).toBe("null model not run");
    expect(standing?.line).toBe(
      "null model: NOT RUN on 01234567. Run pnpm backtest null-model on it before reading any number here.",
    );
  });

  it("gives the verdict, when, and which run", () => {
    expect(nullModelStanding(run, row("pass"))).toEqual({
      short: "null model pass",
      line: "null model: PASS on 01234567 (2026-09-24T15:00:00.000Z, 4f0c0f0e-0000-4000-8000-000000000001)",
    });
    const failed = nullModelStanding(run, row("fail"));
    expect(failed?.short).toBe("null model FAIL");
    expect(failed?.line).toContain("No number from this commit counts");
    const insufficient = nullModelStanding(run, row("insufficient"));
    expect(insufficient?.short).toBe("null model insufficient");
    expect(insufficient?.line).toContain("not a pass");
  });
});

describe.skipIf(engineUrl === "")("null-model runs in the database", () => {
  // Commits no checkout has, so the test shares a database with real runs safely.
  const stamp = `${String(process.pid)}${String(Date.now())}`;
  const COMMIT = `test-l3-a-${stamp}`;
  const OTHER = `test-l3-b-${stamp}`;
  const ids: string[] = [];
  let pool: pg.Pool;
  let store: NullModelStore;

  const result = (verdict: NullModelRow["verdict"]): NullModelGateResult => ({
    verdict,
    paths: 40,
    reports: {
      A: { verdict } as NullModelReport,
      B: { verdict } as NullModelReport,
    },
    elapsedMs: 12,
  });

  async function record(commit: string, dirty: boolean, verdict: NullModelRow["verdict"]) {
    const kept = await store.record({ commit, dirty }, result(verdict));
    ids.push(kept.id);
    return kept;
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: engineUrl, max: 2 });
    store = new NullModelStore(pool);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM null_model_runs WHERE id = ANY($1)", [ids]);
    await pool.end();
  });

  it("keeps a run with its commit, verdict, and reports", async () => {
    await store.ready();
    const kept = await record(COMMIT, false, "pass");
    expect(kept).toMatchObject({
      gitCommit: COMMIT,
      gitDirty: false,
      verdict: "pass",
      paths: 40,
      elapsedMs: 12,
    });
    expect(kept.reports).toEqual({ A: { verdict: "pass" }, B: { verdict: "pass" } });
    expect(kept.createdAt).toBeInstanceOf(Date);
  });

  it("gives each commit's latest clean run, and never a dirty one", async () => {
    await record(COMMIT, true, "fail");
    await record(OTHER, true, "pass");
    expect((await store.latestFor([COMMIT, OTHER, COMMIT])).get(COMMIT)?.verdict).toBe("pass");
    expect((await store.latestFor([OTHER])).has(OTHER)).toBe(false);

    const later = await record(COMMIT, false, "fail");
    const latest = await store.latestFor([COMMIT, OTHER]);
    expect([...latest.keys()]).toEqual([COMMIT]);
    expect(latest.get(COMMIT)?.id).toBe(later.id);
    expect((await store.latestFor([])).size).toBe(0);
  });
});
