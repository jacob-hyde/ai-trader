# data

Schema migrations and historical bar storage.

## Ownership rule

The schema has exactly one owner. Until the Laravel app exists (K.1) that owner is the SQL migration
runner in this folder. After K.1 these files are ported verbatim into Laravel migrations and this runner
retires.

The engine never runs DDL. It connects as `trader_engine`, a role with SELECT, INSERT, UPDATE, and DELETE
on tables and nothing else: no CREATE on the schema, no access to the migration ledger. Two connection
strings enforce the split:

- `MIGRATION_DATABASE_URL` is the schema owner. Only the migration runner uses it.
- `DATABASE_URL` is the engine role. The engine and the web app's runtime use it.

The dev password for `trader_engine` is the role name. Production rotates it with
`ALTER ROLE trader_engine PASSWORD '...'` from a Docker secret at provisioning.

## Usage

```bash
pnpm migrate:up              # apply everything pending
pnpm migrate:down            # revert the latest one (pass a count for more)
pnpm migrate:status          # applied vs pending
pnpm migrate:create add_bars # scaffold data/migrations/000N_add_bars.sql
```

Migrations are plain SQL in `migrations/`, sequence-numbered, split by `-- Up Migration` and
`-- Down Migration` markers (node-pg-migrate's SQL format). Every migration must have a real down.

## Timescale helper

`trader_make_hypertable(table, time_col = 'ts', segment_col = 'symbol', chunk_interval = '7 days', compress_after = '30 days')`
turns an existing table into a hypertable with the project defaults for 1-minute bars: 7-day chunks,
compression after 30 days segmented by symbol and ordered by time descending. Idempotent until a chunk
has been compressed. The table's primary key must include the time column.

```sql
CREATE TABLE bars_1m (symbol text NOT NULL, ts timestamptz NOT NULL, ..., PRIMARY KEY (symbol, ts));
SELECT trader_make_hypertable('bars_1m');
```

## Bars

Bulk-loaded minute bars (H.7) live in TimescaleDB, not in the repo. Local dumps go under `data/dumps/`
and `data/bars/`, both gitignored.
