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

## Modes

`TRADING_MODE` is `backtest`, `paper`, or `live`. Live refuses to start without `LIVE_TRADING_ACK=I_UNDERSTAND`
until 2FA gating exists. The engine prints its mode on every boot.
