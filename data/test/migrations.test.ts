import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../.env") });

const ownerUrl = process.env["MIGRATION_DATABASE_URL"] ?? "";
const engineUrl = process.env["DATABASE_URL"] ?? "";

const base = {
  databaseUrl: ownerUrl,
  dir: path.resolve(here, "../migrations"),
  migrationsTable: "pgmigrations",
  log: () => undefined,
};

// Integration test against the compose db locally and the service container in CI. Skipped when no
// connection is configured so a checkout without Docker still runs the unit suites.
describe.skipIf(!ownerUrl || !engineUrl)("A.4 migrations and TimescaleDB", () => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  const table = `_a4_smoke_${Date.now()}`;

  beforeAll(async () => {
    await runner({ ...base, direction: "up", count: Number.POSITIVE_INFINITY });
    await owner.connect();
  });

  afterAll(async () => {
    await owner.query(`DROP TABLE IF EXISTS ${table}`);
    await owner.end();
  });

  it("installs the timescaledb extension", async () => {
    const result = await owner.query("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'");
    expect(result.rowCount).toBe(1);
  });

  it("creates an engine role with usage but no create on the schema", async () => {
    const result = await owner.query(
      "SELECT has_schema_privilege('trader_engine', 'public', 'CREATE') AS can_create, has_schema_privilege('trader_engine', 'public', 'USAGE') AS can_use",
    );
    expect(result.rows[0]).toEqual({ can_create: false, can_use: true });
  });

  it("makes a hypertable with the helper and round-trips rows", async () => {
    await owner.query(
      `CREATE TABLE ${table} (symbol text NOT NULL, ts timestamptz NOT NULL, close numeric(12, 4) NOT NULL, PRIMARY KEY (symbol, ts))`,
    );
    await owner.query("SELECT trader_make_hypertable($1::regclass)", [table]);
    const hypertable = await owner.query(
      "SELECT compression_enabled FROM timescaledb_information.hypertables WHERE hypertable_name = $1",
      [table],
    );
    expect(hypertable.rows).toEqual([{ compression_enabled: true }]);

    await owner.query(
      `INSERT INTO ${table} VALUES ('AAPL', '2026-09-19T13:30:00Z', 100.1234), ('AAPL', '2026-09-19T13:31:00Z', 100.2), ('MSFT', '2026-09-19T13:30:00Z', 50)`,
    );
    const rows = await owner.query(`SELECT count(*)::int AS n, max(close)::text AS mx FROM ${table}`);
    expect(rows.rows[0]).toEqual({ n: 3, mx: "100.2000" });
  });

  it("lets the engine role read and write rows but not create tables", async () => {
    const engine = new pg.Client({ connectionString: engineUrl });
    await engine.connect();
    try {
      await engine.query(`INSERT INTO ${table} VALUES ('NVDA', '2026-09-19T13:30:00Z', 1)`);
      const rows = await engine.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows.rows[0]).toEqual({ n: 4 });
      await expect(engine.query("CREATE TABLE _a4_should_fail (x int)")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await engine.end();
    }
  });

  // In a throwaway database: reverting the bar store in the shared one would drop every loaded bar, and
  // race any test writing bars at the same moment. Stops short of the engine role, which is cluster-wide.
  it("reverts and re-applies the migrations above the engine role", { timeout: 60_000 }, async () => {
    const scratch = `trader_a4_${Date.now()}`;
    await owner.query(`CREATE DATABASE ${scratch}`);
    const url = new URL(ownerUrl);
    url.pathname = `/${scratch}`;
    const scratchBase = { ...base, databaseUrl: url.toString() };
    const client = new pg.Client({ connectionString: url.toString() });
    try {
      await runner({ ...scratchBase, direction: "up", count: Number.POSITIVE_INFINITY });
      await client.connect();
      const present = async (): Promise<boolean[]> => {
        const result = await client.query<{ fn: boolean; bars: boolean; runs: boolean; nulls: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'trader_make_hypertable') AS fn,
             to_regclass('bars_1m') IS NOT NULL AS bars, to_regclass('backtest_runs') IS NOT NULL AS runs,
             to_regclass('null_model_runs') IS NOT NULL AS nulls`,
        );
        const row = result.rows[0];
        return [row?.fn ?? false, row?.bars ?? false, row?.runs ?? false, row?.nulls ?? false];
      };
      expect(await present()).toEqual([true, true, true, true]);

      // 0012 study runs, 0011 auction prints, 0010 round 2 signal data, 0009 reports, 0008 run snapshots,
      // 0007 null-model runs, 0006 bad ticks, 0005 backtest runs, 0004 bar store, 0003 hypertable helper.
      await runner({ ...scratchBase, direction: "down", count: 10 });
      expect(await present()).toEqual([false, false, false, false]);

      await runner({ ...scratchBase, direction: "up", count: Number.POSITIVE_INFINITY });
      expect(await present()).toEqual([true, true, true, true]);
    } finally {
      await client.end();
      await owner.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }
  });
});
