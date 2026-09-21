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

  it("reverts and re-applies the latest migration", async () => {
    await runner({ ...base, direction: "down", count: 1 });
    const gone = await owner.query("SELECT 1 FROM pg_proc WHERE proname = 'trader_make_hypertable'");
    expect(gone.rowCount).toBe(0);

    await runner({ ...base, direction: "up", count: Number.POSITIVE_INFINITY });
    const back = await owner.query("SELECT 1 FROM pg_proc WHERE proname = 'trader_make_hypertable'");
    expect(back.rowCount).toBe(1);
  });
});
