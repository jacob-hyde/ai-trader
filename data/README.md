# data

Schema migrations and historical bar storage.

## Ownership rule

The schema has exactly one owner. Until the Laravel app exists (K.1) that owner is the SQL migration
runner in this folder. After K.1 these files are ported verbatim into Laravel migrations and this runner
retires.

The engine never runs DDL. It connects as `trader_engine`, a role with SELECT, INSERT, UPDATE, and DELETE
on tables and nothing else: no CREATE on the schema, no access to the migration ledger. Two connection
strings enforce the split:

- `MIGRATION_DATABASE_URL` is the schema owner. The migration runner uses it, and so does the bar load
  when it compresses, since compressing a chunk needs the table's owner.
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

The historical bar store (H.7) lives in TimescaleDB, not in the repo. `pnpm bars` loads it from Alpaca:

```bash
pnpm bars calendar                 # sessions 2016 through next year, half days included
pnpm bars symbols                  # the ticker list: asset list, corporate actions, --file extra.txt
pnpm bars daily                    # daily bars for every ticker on the list
pnpm bars universe                 # which symbol-months pass the liquidity screen (loads nothing)
pnpm bars minute --universe        # minute bars for those symbol-months
pnpm bars verify                   # coverage against the calendar, gaps listed as runs
pnpm bars compress                 # compress now instead of waiting for the policy (table owner)
pnpm bars status                   # sizes, checkpoints, and timed backtest reads
pnpm bars all                      # all of the above, in order
```

`--from` and `--to` take a month or a date (default 2016-01 through today). Every load resumes: a
checkpoint marks each symbol-month done, a job writes its bars and its checkpoints in one transaction,
and a rerun fetches only what has no complete checkpoint. The month still in progress is fetched again
each run.

What is stored, and why:

- **Ticker-at-time.** Bars are pulled with Alpaca's symbol mapping off, so FB in 2021 is Facebook and
  META in 2021 is the ETF that held the ticker then. A backtest sees the tickers of the day it is on.
- **As traded.** Prices are never adjusted for later splits (NVDA was $516.71 on 2021-01-27, not
  $12.85). Each daily bar carries `split_factor`, shares today per share that day, so a lookback across
  a split can be restated as of any date. Dividends are not adjusted.
- **Regular hours.** Minute bars keep 09:30 to the close only, with the session and minute from the
  open assigned at load time.
- **Survivorship.** The ticker list is the union of Alpaca's asset list (active, inactive, and OTC),
  every merger's acquiree, both sides of every name change, and every worthless removal. Alpaca's asset
  list alone drops many delisted names (TWTR, SIVB). Its corporate actions only go back to about 2019,
  so a name that left earlier and is missing from the asset list needs `--file`.
- **Minute bars only where they matter.** A symbol-month gets minute bars when the symbol passes the
  published screen ($5 to $100, over 1M shares a day, ATR(14) over $0.50) on at least one session, judged
  on the bars before it, plus the month before for the RVOL lookback. Everything gets daily bars.

Loads connect as the engine role. Compressing needs the table owner: `compress`, and the minute load,
which compresses each month as it finishes so ten years never sit uncompressed on disk at once.
Local dumps go under `data/dumps/` and `data/bars/`, both gitignored.
