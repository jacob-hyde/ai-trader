import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { runner } from "node-pg-migrate";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../.env") });

const migrationsDir = path.join(here, "migrations");
const migrationsTable = "pgmigrations";

/**
 * Migration CLI: `up`, `down [count]`, `status`, `create <name>`.
 *
 * A thin wrapper over node-pg-migrate that exists only until the Laravel app owns the schema (K.1); the
 * SQL files port into Laravel migrations verbatim and this runner retires. Connects as the schema owner
 * (MIGRATION_DATABASE_URL), never as the engine role, so even the tooling respects "the engine is
 * data-only".
 */
function ownerUrl(): string {
  const url = process.env["MIGRATION_DATABASE_URL"];
  if (!url) {
    throw new Error("MIGRATION_DATABASE_URL is not set (see .env.example)");
  }
  return url;
}

function migrationFiles(): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

async function migrate(direction: "up" | "down", count: number): Promise<void> {
  await runner({
    databaseUrl: ownerUrl(),
    dir: migrationsDir,
    direction,
    count,
    migrationsTable,
    verbose: true,
  });
}

async function status(): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl() });
  await client.connect();
  try {
    const applied = new Set<string>();
    const ledger = await client.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [
      migrationsTable,
    ]);
    if (ledger.rows[0]?.present) {
      const rows = await client.query<{ name: string }>(`SELECT name FROM ${migrationsTable}`);
      for (const row of rows.rows) {
        applied.add(row.name);
      }
    }
    for (const file of migrationFiles()) {
      const name = file.replace(/\.sql$/, "");
      console.log(`${applied.has(name) ? "applied" : "pending"}  ${name}`);
    }
  } finally {
    await client.end();
  }
}

// Sequence-numbered rather than timestamped so the order reads at a glance and ports to Laravel cleanly.
function create(name: string | undefined): void {
  if (!name || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error("usage: migrate create <snake_case_name>");
  }
  const last = migrationFiles().at(-1);
  const next = last ? Number.parseInt(last.slice(0, 4), 10) + 1 : 1;
  const file = path.join(migrationsDir, `${String(next).padStart(4, "0")}_${name}.sql`);
  fs.writeFileSync(file, "-- Up Migration\n\n\n-- Down Migration\n\n", { flag: "wx" });
  console.log(`created ${path.relative(process.cwd(), file)}`);
}

const [command = "status", argument] = process.argv.slice(2);
switch (command) {
  case "up":
    await migrate("up", Number.POSITIVE_INFINITY);
    break;
  case "down":
    await migrate("down", argument === undefined ? 1 : Number.parseInt(argument, 10));
    break;
  case "status":
    await status();
    break;
  case "create":
    create(argument);
    break;
  default:
    throw new Error(`unknown command: ${command} (expected up | down | status | create)`);
}
