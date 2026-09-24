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
```

Every run takes the pre-registration's excluded sessions out of its calendar, and refuses holdout sessions
until a frozen configuration is committed to `Docs/Pre-Registration.md`. `--blind` runs everything and keeps
nothing after 09:35: timing and signal-time counts only, no trade, fill, or R.

## Modes

`TRADING_MODE` is `backtest`, `paper`, or `live`. Live refuses to start without `LIVE_TRADING_ACK=I_UNDERSTAND`
until 2FA gating exists. The engine prints its mode on every boot.
