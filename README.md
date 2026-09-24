# ai-trader

AI-assisted intraday equities trading system on Alpaca. An LLM ranks and vetoes; deterministic code sizes,
executes, and can always override it. Long-only v1, whole-share bracket orders, flat by end of day.

The plan lives in `Docs/`:

- `Docs/Plan-Detailed.md` is the source of truth.
- `Docs/Tasks.md` is the epic and task breakdown (mirrored in Linear).
- `Docs/SOW.docx` and `Docs/Plan-Overview.docx` are the summary documents.

## Layout

```
apps/engine         Node/TS real-time trading engine
apps/backtest       Backtest runner: BullMQ queue, worker, CLI (L.1)
apps/web            Laravel + Vue GUI (scaffolded when EPIC-K starts)
packages/core       Pure decision core: sizing, risk, indicators, setups. No I/O.
packages/adapters   Data + execution adapters: backtest | paper | live
packages/contracts  Shared types and JSON schemas
infra               Docker, deploy, runbooks
data                Bar storage and migration scripts
```

## Quick start

```bash
cp .env.example .env        # then fill in Alpaca paper keys
pnpm install
docker compose up -d db redis
pnpm migrate:up             # schema owner: Timescale extension, data-only engine role, tables
pnpm typecheck && pnpm lint && pnpm test
pnpm engine                 # boots the engine, prints the mode banner, pings Alpaca
pnpm alpaca:smoke           # read-only check of every Alpaca endpoint and both websockets (paper only)
```

`.env` is gitignored. Keys never go in the database or the UI. The engine connects with a data-only
database role; only the migration runner (`data/`) can change the schema.

## Backtests

A run is a JSON configuration (`apps/backtest/src/config.ts`). Runs, their sessions, trades, and fills go
into Postgres under a run id; the queue is BullMQ on the compose Redis (host port 6380).

```bash
pnpm backtest config preregistered > run.json   # the pre-registered in-sample run, from section 11
pnpm backtest worker                            # takes queued runs until stopped
pnpm backtest submit run.json                   # queues a run and follows its progress to the end
pnpm backtest run run.json                      # the same run here, without Redis
pnpm backtest status [<run id>]
pnpm backtest report <run id>                   # a run's metrics (L.4), kept with it; run and submit keep them too
pnpm backtest diff <run id> <run id>            # what differs: commit, data snapshot, configuration, results
pnpm backtest null-model                        # the null-model tripwire on this checkout, kept against the commit
```

A run is refused from a checkout with uncommitted changes, so every number names the commit that made it
(L.5). `--allow-dirty` lets a development run through, and its stored configuration says so. Each run
records its commit, the registration's sha256, and a snapshot id of the bar store it read.

Every run takes the pre-registration's excluded sessions out of its calendar, and refuses holdout sessions
until a frozen configuration is committed to `Docs/Pre-Registration.md`. The bad-tick filter (H.8) judges
every minute bar before the simulated broker sees it; `badTicks: null` in a configuration turns it off. `--blind` runs everything and keeps
nothing after 09:35: timing and signal-time counts only, no trade, fill, or R.

### Before reading any backtest number

A number is read only when the pre-registration's preconditions (section 3) hold for the commit that
produced it. On a clean checkout of that commit:

1. `pnpm bars verify` shows no unexplained holes in the months the run uses.
2. `pnpm bars suspects` has scanned every month since it was loaded. A run refuses a month loaded after
   its scan.
3. `Docs/ETF-ETN-Exclusions.txt` is committed. `pnpm backtest config preregistered` refuses to build
   without it.
4. `pnpm backtest null-model` passes. It runs the D.4 tripwire over 100,000 driftless sessions for each
   confirmatory exit, about three minutes, and keeps the verdict against the commit. Run from a dirty
   checkout it is kept and counts for nothing.

`pnpm backtest status` shows the null model's verdict on each run's commit. FAIL voids every number from
that commit (pre-registration section 10). NOT RUN means run it before looking.

## Modes

`TRADING_MODE` is `backtest`, `paper`, or `live`. Live refuses to start without `LIVE_TRADING_ACK=I_UNDERSTAND`
until 2FA gating exists. The engine prints its mode on every boot.
