# AI-Trader — Task Breakdown (Linear-ready)

> Extremely detailed, dependency-ordered work breakdown. Designed to import into Linear:
> **Epics → Linear Projects** (or parent issues), **Tasks → Issues**, the checklist under each task →
> **sub-issues / acceptance checklist**. Every task carries: description, acceptance criteria,
> dependencies, labels, estimate, priority.

> **Linear mirror (2026-09-19):** project [AI Trader](https://linear.app/pro-futures-strategies/project/ai-trader-03b54bade903).
> Epics are parent issues PRO-637 to PRO-651 (A to O in order); tasks are sub-issues PRO-652 to PRO-747.
> Linear is the tracking source of truth for status; this file is the spec source. Keep them in sync when
> scope changes.

## Conventions
- **IDs:** `EPIC-x` letters; tasks `x.n` (stable references for dependencies).
- **Estimate (points):** 1 ≈ <½ day · 2 ≈ ½–1 day · 3 ≈ 1–2 days · 5 ≈ 2–4 days · 8 ≈ ~1 week.
- **Priority:** P0 blocker / on critical path · P1 important · P2 normal · P3 nice-to-have.
- **Labels:** `infra` `core` `engine` `adapters` `contracts` `data` `safety` `llm` `web` `backtest`
  `validation` `devops` `docs`.
- **Golden rules baked into every task's DoD:** no look-ahead (closed bars only); every entry has a
  broker-side stop; deterministic code can always veto the LLM; cost model is always on; secrets never
  touch the DB or UI.

---

## EPIC-A — Project Setup & DevOps Foundation
**Goal:** a reproducible monorepo + container stack that runs identically on the M3 Mac and Linode.
**Exit criteria:** `docker compose up` brings up Postgres/Timescale + Redis + engine + web + Reverb;
CI runs lint/typecheck/test green on every push.

### A.1 — Monorepo scaffolding
- **Description:** Initialize pnpm-workspace monorepo with `/apps/{web,engine}`, `/packages/{core,adapters,contracts}`, `/infra`, `/data`, `/Docs`. Set up shared `tsconfig` base, package boundaries, and path aliases.
- **Acceptance:** `pnpm install` resolves all workspaces; a trivial cross-package import (`@trader/core`) builds; `git` initialized with sensible `.gitignore` (env, node_modules, data dumps).
- **Depends on:** —  **Labels:** infra, devops  **Estimate:** 3  **Priority:** P0

### A.2 — TypeScript strictness, lint, format
- **Description:** Enable `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; ESLint + Prettier; pre-commit hook (lint-staged). Engine/core treated as strict zones.
- **Acceptance:** `pnpm typecheck` and `pnpm lint` pass on the scaffold; a deliberate type error fails CI.
- **Depends on:** A.1  **Labels:** devops, core, engine  **Estimate:** 2  **Priority:** P0

### A.3 — Docker & docker-compose stack
- **Description:** Compose services: TimescaleDB, Redis, engine (Node), web (Laravel + Vite), Reverb. Healthchecks, named volumes, `.env`-driven. One compose file used both local and on Linode (parity).
- **Acceptance:** `docker compose up` yields all services healthy; engine and web can reach DB + Redis by service name.
- **Depends on:** A.1  **Labels:** infra, devops  **Estimate:** 5  **Priority:** P0

### A.4 — TimescaleDB + migration tooling
- **Description:** Provision Timescale extension; choose/setup migrations (Laravel migrations as the single migration owner, engine reads only). Hypertable helper for time-series tables.
- **Acceptance:** Migrate up/down works; a sample hypertable created and queried; documented "Laravel owns schema, engine is read/write-data-only" rule.
- **Depends on:** A.3  **Labels:** infra, data  **Estimate:** 3  **Priority:** P0

### A.5 — Secrets & config
- **Description:** `.env` locally, Docker secrets on server; a typed config loader in the engine that validates required env at boot and refuses to start if missing. Keys never logged.
- **Acceptance:** Engine boot fails fast with a clear message on missing key; no secret appears in logs; `.env.example` documents every var.
- **Depends on:** A.1  **Labels:** infra, safety, devops  **Estimate:** 2  **Priority:** P0

### A.6 — CI pipeline
- **Description:** CI (GitHub Actions or equivalent) running install → typecheck → lint → unit tests on push/PR.
- **Acceptance:** Pipeline green on scaffold; fails on a broken test; caches deps.
- **Depends on:** A.2  **Labels:** devops  **Estimate:** 2  **Priority:** P1

### A.7 — Linode provisioning runbook
- **Description:** Document (don't yet execute) the Linode setup: instance size, Docker install, firewall, NTP, deploy flow, backup target. Deferred until pre-live.
- **Acceptance:** `infra/linode-runbook.md` exists and is complete enough to follow cold.
- **Depends on:** A.3  **Labels:** infra, devops, docs  **Estimate:** 2  **Priority:** P2

---

## EPIC-B — Data Archiver + Backfill (cheap insurance, do early)
**Goal:** record exactly the feed the live system acts on, going forward, and backfill the history from
recoverable sources. Most of this data is reconstructable after the fact (bars → ADV/RVOL/screener;
Alpaca news REST → news history; FINRA/Polygon → short interest; SEC → shares outstanding). The only
source with no history endpoint is Finviz's computed float/short-float snapshot, for which current
values are a workable proxy. A gap is therefore recoverable: this epic is early-priority, not an emergency.
**Exit criteria:** nightly Finviz snapshot, the live news stream, and the daily screener output are all
landing in append-only, timestamped tables with failure alerts, and the historical gap is backfilled.

### B.1 — `fundamentals_snapshots` schema (append-only, effective-dated)
- **Description:** Table keyed by (symbol, snapshot_date) storing the full Finviz row set; never updated, only inserted. Designed for "as-of" queries (effective-dated) to prevent look-ahead in future replay.
- **Acceptance:** Migration creates the table; an as-of query ("fundamentals for X as of date D") returns the correct historical snapshot; duplicate-night insert is idempotent or versioned.
- **Depends on:** A.4  **Labels:** data  **Estimate:** 3  **Priority:** P0

### B.2 — `news_events` schema (append-only)
- **Description:** Store each news item with received-timestamp, symbols, headline, body/snippet, source, raw payload. Append-only.
- **Acceptance:** Table + indexes (by symbol, by received_at); insert path is idempotent on provider message id.
- **Depends on:** A.4  **Labels:** data  **Estimate:** 2  **Priority:** P0

### B.3 — `screener_snapshots` schema
- **Description:** Daily snapshot of screener output (most-actives/movers) + computed RVOL inputs, so the universe of a given day can be reconstructed.
- **Acceptance:** Table stores ranked symbols per day; reconstructable "what was in play on D".
- **Depends on:** A.4  **Labels:** data  **Estimate:** 2  **Priority:** P0

### B.4 — Finviz Elite nightly loader
- **Description:** Standalone script: authenticate, pull full-universe CSV export (~8k names, ~71 cols), normalize, insert into `fundamentals_snapshots`. Robust to schema drift.
- **Acceptance:** One run populates a night's snapshot; re-run same night doesn't duplicate; handles partial/failed download gracefully.
- **Depends on:** B.1  **Labels:** data  **Estimate:** 5  **Priority:** P0

### B.5 — Alpaca news stream writer
- **Description:** Subscribe to Alpaca news websocket; persist every event to `news_events`. Reconnect with backoff; no gaps on reconnect (catch-up via REST if available).
- **Acceptance:** Live events persist within seconds; reconnect after a forced drop loses no events; idempotent on message id.
- **Depends on:** B.2  **Labels:** data, engine  **Estimate:** 5  **Priority:** P0

### B.6 — Daily screener snapshot job
- **Description:** Once daily (and optionally at open), call SIP screener, compute RVOL inputs, persist to `screener_snapshots`.
- **Acceptance:** Daily row set present; values match a manual screener check.
- **Depends on:** B.3  **Labels:** data  **Estimate:** 3  **Priority:** P1

### B.7 — Archiver scheduler
- **Description:** Cron/scheduler (containerized) running B.4 nightly, B.6 daily; B.5 runs as a long-lived service.
- **Acceptance:** Jobs fire on schedule in the container; missed-run detection.
- **Depends on:** B.4, B.6  **Labels:** infra, data  **Estimate:** 2  **Priority:** P1

### B.8 — Archiver monitoring + ntfy alerts
- **Description:** Alert on job failure, zero-row loads, or news-stream disconnect beyond threshold.
- **Acceptance:** A simulated failure produces an ntfy push within the cycle.
- **Depends on:** B.7, K-prereq ntfy util (or inline)  **Labels:** data, safety  **Estimate:** 2  **Priority:** P1

### B.9 — Off-box backup of archive tables
- **Description:** Nightly `pg_dump` of archive + (later) trade-log tables to off-box storage; restore tested.
- **Acceptance:** Backup artifact created nightly; a test restore reproduces the data.
- **Depends on:** B.1–B.3  **Labels:** infra, data  **Estimate:** 3  **Priority:** P1

### B.10 — Historical backfill (recover the gap and prior years)
- **Description:** Reconstruct what the archiver would have captured, from recoverable sources: (1) download historical minute/daily bars for the universe (Alpaca, `adjustment=all`; free when older than 15 min) and compute ADV, first-5-min volume, RVOL, and the daily most-actives/movers/in-play rankings into `screener_snapshots`; (2) pull news history via Alpaca's news REST endpoint by date range into `news_events` (published timestamps); (3) pull short-interest history (FINRA bi-monthly / Polygon) and shares outstanding (SEC / reference data) into `fundamentals_snapshots`, noting that float is proxied (current value or SEC-derived) because Finviz has no history API.
- **Acceptance:** For a chosen date range, all three tables are populated; a spot-check day's RVOL ranking matches a manual computation from bars; backfilled rows are distinguishable from live-captured rows via a `source` flag.
- **Depends on:** B.1–B.3, H.7  **Labels:** data, backtest  **Estimate:** 5  **Priority:** P1

---

## EPIC-C — `packages/core`: Risk, Sizing, Indicators, Setup Framework
**Goal:** the dependency-free, 100%-tested decision core everything risky depends on.
**Exit criteria:** sizing, risk rules, indicators, the `Setup` interface, and the ORB setup all exist as
pure functions with full unit coverage.

### C.1 — Money & rounding primitives
- **Description:** Integer-cent / decimal money type; whole-share rounding; spread/tick helpers. No floats for money.
- **Acceptance:** Property tests show no float drift; whole-share floor behaves at boundaries.
- **Depends on:** A.2  **Labels:** core  **Estimate:** 2  **Priority:** P0

### C.2 — Position sizing (two regimes)
- **Description:** Implement the sizing formula: min(risk-based, notional-cap, buying-power) floored to whole shares; reject sub-minimum; **Regime-1 micro hard-cap override**.
- **Acceptance:** Matches worked example ($2,500/1%/20% → 25 shares); Regime-1 clamps to micro cap; rejects positions that can't clear the spread.
- **Depends on:** C.1  **Labels:** core, safety  **Estimate:** 3  **Priority:** P0

### C.3 — Risk-rule engine
- **Description:** Per-position cap (25%), concurrency (4–5), aggregate open-risk ceiling (2–3%), **daily-loss breaker (−5%)**, and the veto interface (LLM proposals pass through here).
- **Acceptance:** Unit tests prove each limit blocks the offending order; breaker halts new entries at threshold; veto reasons are explicit/enumerated.
- **Depends on:** C.2  **Labels:** core, safety  **Estimate:** 5  **Priority:** P0

### C.4 — Indicators (closed-bar, warmup-aware)
- **Description:** Integrate `trading-signals`; implement session-anchored VWAP and RVOL; ATR(14), RSI. Update **only on closed bars**; expose warmup state.
- **Acceptance:** Values match reference fixtures; no update on partial bars; signals flagged untrusted until warmup satisfied.
- **Depends on:** A.2  **Labels:** core  **Estimate:** 5  **Priority:** P0

### C.5 — `Setup` interface
- **Description:** Define the TS contract a setup implements: `evaluateContext`, `detectTrigger`, `stop`, `target`, `invalidation`, metadata. Built for multiple setups; ORB is impl #1.
- **Acceptance:** Interface documented; a no-op fake setup compiles against it; supports both long and short (short flagged off).
- **Depends on:** C.4  **Labels:** core, contracts  **Estimate:** 3  **Priority:** P0

### C.6 — ORB setup implementation
- **Description:** Implement §3 spec: 5-min opening range, RVOL>100% gate, bullish→long, entry stop @ 5-min high, stop = 10% ATR(14), exit variants (EOD vs 1.5–2R+BE@1R) behind a config flag. Short mirror implemented but flag-gated off.
- **Acceptance:** Given fixture bars, produces the exact entry/stop/target the spec dictates; doji → no trade; both exit variants selectable; no look-ahead.
- **Depends on:** C.5  **Labels:** core  **Estimate:** 5  **Priority:** P0

### C.7 — Bracket-order builder (pure)
- **Description:** Pure function producing an OCO bracket (entry + stop + target) from a sized signal, including client-order-id scheme inputs.
- **Acceptance:** Output validates against Alpaca bracket constraints (whole shares, valid prices); deterministic.
- **Depends on:** C.2, C.6  **Labels:** core  **Estimate:** 3  **Priority:** P0

### C.8 — Cost model (pure)
- **Description:** Fills at quote ± half-spread + slippage allowance (tunable bps/tick); commission hook. Used in backtest *and* paper accounting. **Stop-triggered entries get a separate, pessimistic slippage parameter** (they fill as market orders into momentum); that parameter is the number live-small calibrates.
- **Acceptance:** Given a quote + size, returns a realistic fill; parameters configurable; documented defaults.
- **Depends on:** C.1  **Labels:** core, backtest, validation  **Estimate:** 3  **Priority:** P0

### C.9 — Cost-to-risk ratio gate (pure)
- **Description:** Pure function: (round-trip spread + expected slippage per share) / stop distance per share. Reject any candidate above a threshold (default ~0.15R). Independent of account size; the dominant survival filter for a tight-stop strategy (a $1-ATR name with a $0.10 stop and a $0.08 round trip carries 0.8R of cost).
- **Acceptance:** Unit tests at the boundary; low-ATR/wide-spread names are rejected, high-ATR/tight-spread names pass; threshold configurable.
- **Depends on:** C.8  **Labels:** core, safety  **Estimate:** 2  **Priority:** P0

---

## EPIC-D — Test Harness (synthetic, property, null-model)
**Goal:** prove the machine is correct (separate from proving the edge).
**Exit criteria:** thousands of random/adversarial paths pass all invariants; null-model lands at ~break-even-minus-costs.

### D.1 — Core unit tests (100%)
- **Description:** Exhaustive unit tests for C.1–C.3, C.6–C.8.
- **Acceptance:** 100% line/branch on `packages/core`; mutation-test spot check.
- **Depends on:** C.8  **Labels:** core, validation  **Estimate:** 5  **Priority:** P0

### D.2 — Synthetic path generator
- **Description:** Generate scripted/random price paths: oscillate around stop, gap-through-stop, stop-run wick, halt/reopen, partial fill, ws disconnect mid-position, crash→reconcile. Seeded RNG.
- **Acceptance:** Each scenario reproducible by seed; spread/slippage modeled in paths.
- **Depends on:** C.8  **Labels:** validation, engine  **Estimate:** 5  **Priority:** P0

### D.3 — Property / invariant suite
- **Description:** Over thousands of generated paths assert: never risk > cap/trade, never exceed max concurrent, every entry has an attached stop, reconciliation always converges, breaker always fires at threshold.
- **Acceptance:** Suite runs in CI; a deliberately broken invariant is caught.
- **Depends on:** D.2  **Labels:** validation  **Estimate:** 5  **Priority:** P0

### D.4 — Null-model tripwire
- **Description:** Run the full mechanics over driftless GBM random walks with costs on; assert result ≈ break-even minus costs. Profit = fail (look-ahead/accounting/curve-fit alarm).
- **Acceptance:** Tripwire passes on correct code; injecting a look-ahead bug makes it "profit" and fail.
- **Depends on:** D.2, C.8  **Labels:** validation  **Estimate:** 3  **Priority:** P0

### D.5 — ORB golden cases
- **Description:** Versioned fixtures: clean breakout, doji skip, low-RVOL skip, gap-through, EOD-exit vs target-exit outcomes.
- **Acceptance:** Golden outputs locked; changes require explicit fixture updates.
- **Depends on:** C.6  **Labels:** core, validation  **Estimate:** 3  **Priority:** P1

---

## EPIC-E — Contracts (`packages/contracts`)
**Goal:** freeze the engine↔model and engine↔app interfaces before building either side.

### E.1 — LLM Stage-5 payload schema
- **Description:** Compact structured input: symbol, snapshot (price, VWAP, ATR, RSI, RVOL), key levels, summary stats, news headlines/snippets, portfolio context (holdings, remaining risk budget, day P&L).
- **Acceptance:** JSON Schema + TS types; example payloads validate; size-bounded for prompt caching.
- **Depends on:** A.2  **Labels:** contracts, llm  **Estimate:** 3  **Priority:** P0

### E.2 — LLM response schema + validator
- **Description:** Strict output `{action, direction, conviction, trigger_condition, rationale}`; runtime validator that rejects malformed output.
- **Acceptance:** Valid responses parse; malformed → typed error → skip path (see J.4).
- **Depends on:** E.1  **Labels:** contracts, llm  **Estimate:** 2  **Priority:** P0

### E.3 — Decision-log schema (shared)
- **Description:** One schema capturing each decision: inputs (payload), model+prompt version, response, deterministic disposition (sized order / veto reason). Powers inspector, approval card, and replay.
- **Acceptance:** Schema supports all three consumers; queryable by symbol/day; immutable rows.
- **Depends on:** E.2  **Labels:** contracts, data, llm  **Estimate:** 3  **Priority:** P0

### E.4 — Shared domain types
- **Description:** `Position`, `Order`, `Trade` (incl. tax-lot fields), `Candidate`, `SetupSignal`, run-mode enum.
- **Acceptance:** Used by engine + adapters; tax-lot fields present from the start.
- **Depends on:** A.2  **Labels:** contracts  **Estimate:** 3  **Priority:** P0

---

## EPIC-F — Adapters (`packages/adapters`)
**Goal:** one data+execution interface, three implementations (backtest | paper | live).

### F.1 — Adapter interface
- **Description:** Define data (bars/quotes/snapshots/news) + execution (submit/cancel/positions/account) interface the engine codes against.
- **Acceptance:** Engine compiles against the interface with a stub adapter.
- **Depends on:** E.4  **Labels:** adapters  **Estimate:** 3  **Priority:** P0

### F.2 — Backtest adapter (Timescale replay)
- **Description:** Replays historical bars from Timescale; simulates fills via the cost model; deterministic with seed.
- **Acceptance:** A scripted day replays identically twice; fills use C.8.
- **Depends on:** F.1, C.8, H.7  **Labels:** adapters, backtest  **Estimate:** 5  **Priority:** P1

### F.3 — Paper adapter (Alpaca paper)
- **Description:** Wraps Alpaca paper for orders/positions/account; data via live SIP.
- **Acceptance:** Places/cancels a bracket in paper; positions/account reflect reality.
- **Depends on:** F.1, G.1  **Labels:** adapters  **Estimate:** 5  **Priority:** P0

### F.4 — Live adapter (Alpaca live)
- **Description:** Same as paper against live endpoints; extra guardrails (mode banner gating, 2FA-gated enablement).
- **Acceptance:** Cannot be enabled without explicit live config + 2FA flow; otherwise identical to F.3.
- **Depends on:** F.3  **Labels:** adapters, safety  **Estimate:** 3  **Priority:** P1

### F.5 — Idempotency layer
- **Description:** Deterministic client-order-id generation + a submitted-order ledger so reconnects/retries never double-submit.
- **Acceptance:** Replaying the same intent twice submits once; survives process restart.
- **Depends on:** F.1, C.7  **Labels:** adapters, safety  **Estimate:** 3  **Priority:** P0

---

## EPIC-G — Safety Core + Alpaca Integration (pull early)
**Goal:** the kill switch and reconciliation exist before any strategy runs live.

### G.1 — Alpaca client wrapper
- **Description:** REST + WS client; auth from secrets; rate-limit-aware; typed responses.
- **Acceptance:** Fetches account/positions; opens the (single) market-data WS; respects rate limits.
- **Depends on:** A.5  **Labels:** engine, adapters  **Estimate:** 5  **Priority:** P0

### G.2 — Paper bracket smoke test
- **Description:** End-to-end: build (C.7) → submit via paper (F.3) → observe fill → cancel. Manual + scripted.
- **Acceptance:** A bracket places and the stop/target are server-side; cancel cleans up.
- **Depends on:** F.3, C.7  **Labels:** engine, safety  **Estimate:** 3  **Priority:** P0

### G.3 — Startup reconciliation
- **Description:** On boot, treat Alpaca as truth: load live positions/orders, reconcile DB, **alert on unexplained state**, never auto-submit to fix.
- **Acceptance:** Synthetic divergence (orphan position, unknown order, DB-open/Alpaca-flat) each produce the correct reconcile + alert; convergence proven in D.3.
- **Depends on:** G.1, F.5  **Labels:** engine, safety  **Estimate:** 5  **Priority:** P0

### G.4 — Panic endpoint (kill switch)
- **Description:** Authenticated REST endpoint (own token) that flattens all + halts new entries via Alpaca REST, independent of WS/broadcast. Reachable in degraded state.
- **Acceptance:** Hitting it flattens paper positions and sets a halt flag even with the WS down; logged in audit.
- **Depends on:** G.1  **Labels:** engine, safety  **Estimate:** 3  **Priority:** P0

### G.5 — Watchdog / heartbeat + ntfy
- **Description:** Heartbeat the engine; alert via ntfy on stall, breaker trip, fills, divergence-kill. Reusable ntfy util.
- **Acceptance:** Killing the engine triggers a stall alert; breaker trip pushes a notice.
- **Depends on:** G.1  **Labels:** engine, safety  **Estimate:** 3  **Priority:** P0

### G.6 — Order lifecycle manager
- **Description:** State machine for an order/position: submitted → partial → filled → bracket-active → exited; handles **partial fills** (resize stop/target legs), OCO leg management, cancel/replace.
- **Acceptance:** Partial fill resizes legs to exact filled qty; remainder below min aborts cleanly; covered by D.2/D.3 paths.
- **Depends on:** F.5, C.7  **Labels:** engine, safety  **Estimate:** 8  **Priority:** P0

---

## EPIC-H — Data Ingestion (live pipeline)
**Goal:** feed the loops with SIP screener, snapshots, streams, news, and a JOINed universe.

### H.1 — Screener integration (SIP)
- **Description:** most-actives/movers pulls; normalize; feed universe build + `screener_snapshots`.
- **Acceptance:** Returns ranked names; values match manual check.
- **Depends on:** G.1, B.6  **Labels:** data, engine  **Estimate:** 3  **Priority:** P1

### H.2 — Multi-symbol snapshot
- **Description:** Batched snapshot (latest trade/quote, minute bar, daily + prev-day) for a symbol list → buyable gate inputs.
- **Acceptance:** One call hydrates N symbols; no per-ticker fan-out.
- **Depends on:** G.1  **Labels:** data, engine  **Estimate:** 3  **Priority:** P1

### H.3 — Minute-bar + NBBO stream
- **Description:** Stream 1-min bars + quotes for watchlist + open positions only; closed-bar emission to indicators.
- **Acceptance:** Bars arrive on close; subscription set updates as watchlist changes; reconnect safe.
- **Depends on:** G.1  **Labels:** data, engine  **Estimate:** 5  **Priority:** P1

### H.4 — Live news handling
- **Description:** Consume Alpaca news live (beyond archiving): map to symbols, queue for relevance classification.
- **Acceptance:** Fresh news for a held/watched name triggers the re-score path (I.4/J.2).
- **Depends on:** B.5  **Labels:** data, engine, llm  **Estimate:** 3  **Priority:** P1

### H.5 — Universe builder
- **Description:** screener ∪ static liquid list ∪ news symbols, JOINed with `fundamentals`.
- **Acceptance:** Produces a deduped daily universe with fundamentals attached.
- **Depends on:** H.1, B.1  **Labels:** data  **Estimate:** 3  **Priority:** P1

### H.6 — Buyable hard gate (Stage 3)
- **Description:** Filters: tradable, $5–100, ADV floor (>1M), spread ceiling, not halted, **RVOL ranking** (top ~20, tightening toward 5–10), **cost-to-risk gate (C.9)**, float/short filters. Thousands → tens.
- **Acceptance:** Given a universe + snapshots, returns the ranked top-N "in play"; each filter unit-tested.
- **Depends on:** H.5, H.2, C.4  **Labels:** data, core  **Estimate:** 5  **Priority:** P0

### H.7 — Historical bar bulk-load
- **Description:** Paginated, rate-limited download of SIP minute bars (`adjustment=all`) for the chosen backtest universe → Timescale. **The universe must include names active in-period but delisted since** (pull inactive assets from Alpaca's assets endpoint) to avoid survivorship bias.
- **Acceptance:** A symbol-set/date-range loads completely; resumable; row counts verified.
- **Depends on:** A.4, G.1  **Labels:** data, backtest  **Estimate:** 5  **Priority:** P1

### H.8 — Bad-tick / quote sanity filter
- **Description:** Reject quotes or prints more than a configurable threshold away from the last closed bar (and from the NBBO) before any stage acts on them. An erroneous print must never trigger a stop, a breakout, or a watchlist trigger.
- **Acceptance:** Injected outlier prints are dropped and logged; legitimate fast moves pass; covered by a D.2 synthetic path.
- **Done (backtest side):** `packages/core/src/badTicks.ts` (2026-09-23), in every backtest replay, with thresholds and the corrupted-day rule registered in Pre-Registration Amendment 3. `isSanePrint` and `isSaneQuote` wait for H.3 to wire them into the live feed.
- **Depends on:** H.3  **Labels:** data, safety  **Estimate:** 2  **Priority:** P0

---

## EPIC-I — The Loops (orchestration)
**Goal:** wire the deterministic pipeline stages into the running engine.

### I.1 — Clock / session gate
- **Description:** RTH gate, pre/post detection, EOD windows; ET via NTP; emits session-state events.
- **Acceptance:** Correctly classifies session at boundaries incl. half-days; drives EOD flatten timing.
- **Depends on:** A.5  **Labels:** engine  **Estimate:** 3  **Priority:** P0

### I.2 — 30-min scan/news cycle
- **Description:** Periodic universe build → Stage-3 gate → hand survivors to setup detection. News-tagged symbols injected.
- **Acceptance:** Runs on cadence; respects rate limits; output feeds I.3.
- **Depends on:** H.6, I.1  **Labels:** engine  **Estimate:** 5  **Priority:** P1

### I.3 — Setup detection pass (Stage 4)
- **Description:** Run ORB (and future setups) over survivors; produce candidate signals for Stage 5.
- **Acceptance:** Emits well-formed `SetupSignal`s; no look-ahead; only on closed bars.
- **Depends on:** C.6, I.2  **Labels:** engine, core  **Estimate:** 3  **Priority:** P1

### I.4 — Watchlist trigger loop
- **Description:** 30–60s checks of price vs stored trigger; LLM re-score at most once/30-min or on fresh news; expiry on timer/invalidation/EOD.
- **Acceptance:** Triggers fire deterministically; no per-check LLM calls; items expire correctly.
- **Depends on:** I.3, J.3  **Labels:** engine  **Estimate:** 5  **Priority:** P1

### I.5 — 30s position monitor
- **Description:** Breakeven@1R, trail (native trail or replace-order), time-stop; LLM consulted only on exceptional events.
- **Acceptance:** Moves stop to BE at +1R; trailing behaves; never gates exits on the LLM.
- **Depends on:** G.6  **Labels:** engine, safety  **Estimate:** 5  **Priority:** P0

### I.6 — EOD hard-flatten
- **Description:** Flatten everything ~15:50 ET; cancel working orders; confirm flat.
- **Acceptance:** No position survives the close in paper; confirmation logged + alerted.
- **Depends on:** I.1, G.6  **Labels:** engine, safety  **Estimate:** 3  **Priority:** P0

### I.7 — Engine state + Redis publishing
- **Description:** Central engine state; publish positions/orders/P&L/health to Redis (throttled) for the app.
- **Acceptance:** App receives throttled (~1–2 Hz) updates; state survives reconnect.
- **Depends on:** I.5  **Labels:** engine  **Estimate:** 3  **Priority:** P1

---

## EPIC-J — LLM Integration (Stage 5)
**Goal:** Anthropic Haiku (classify) + Sonnet (judge) as a ranking/veto layer that never sizes or executes.

### J.1 — Anthropic client + prompt caching
- **Description:** Client wrapper; cache the static system prompt; structured (tool/JSON) output; cost/latency logging. Confirm current model IDs via the claude-api reference at build time.
- **Acceptance:** A cached call shows reduced input cost; outputs conform to E.2.
- **Depends on:** E.2, A.5  **Labels:** llm, engine  **Estimate:** 3  **Priority:** P1

### J.2 — Haiku relevance classifier
- **Description:** Cheap pass mapping news → symbol relevance before spending a judgment call.
- **Acceptance:** Filters obvious noise; low cost; logged.
- **Depends on:** J.1, H.4  **Labels:** llm  **Estimate:** 3  **Priority:** P2

### J.3 — Sonnet Stage-5 judgment
- **Description:** Consume E.1 payload for survivors only; return E.2 JSON. Deterministic risk core disposes/vetoes after. **Runs in SHADOW MODE by default in v1:** every decision is logged (J.6) but gates no trade; live gating requires J.8.
- **Acceptance:** Produces valid decisions on golden cases; output flows through risk veto (C.3).
- **Depends on:** J.1, I.3  **Labels:** llm, engine  **Estimate:** 5  **Priority:** P1

### J.4 — LLM failure policy
- **Description:** Malformed JSON / timeout / provider-down → skip candidate, log, trade nothing. Retry/backoff bounded.
- **Acceptance:** Each failure mode results in a safe skip, never an unguarded trade.
- **Depends on:** J.3  **Labels:** llm, safety  **Estimate:** 2  **Priority:** P0

### J.5 — Golden-case eval suite (versioned)
- **Description:** `{synthetic snapshot + news} → expected action` across clean catalyst, noise, conflicting signal, already-priced-in, ambiguous stall. Run on prompt edits/model bumps.
- **Acceptance:** Suite runs in CI-ish fashion; validates behavior + JSON contract + guardrails (not alpha).
- **Depends on:** J.3  **Labels:** llm, validation  **Estimate:** 5  **Priority:** P1

### J.6 — Decision logging
- **Description:** Persist every decision per E.3 (payload, model+prompt version, response, disposition).
- **Acceptance:** Every Stage-5 invocation produces an immutable decision-log row.
- **Depends on:** E.3, J.3  **Labels:** llm, data  **Estimate:** 3  **Priority:** P1

### J.7 — LLM cost tracking + alert
- **Description:** Track token spend; alert if monthly projection exceeds a configured ceiling.
- **Acceptance:** Spend dashboarded/logged; threshold breach pushes ntfy.
- **Depends on:** J.1  **Labels:** llm  **Estimate:** 2  **Priority:** P2

### J.8 — Promote LLM from shadow to live gating (gated)
- **Description:** Using the shadow decision log (J.6), measure whether the LLM's vetoes/rankings would have improved realized results over a defined sample. Only if the data says yes, flip the flag that lets Stage-5 output gate entries. Exits are never gated regardless.
- **Acceptance:** A written analysis of shadow vs realized outcomes; promotion is a logged, 2FA-gated config change; rollback to shadow is one flag.
- **Depends on:** J.6, N.3  **Labels:** llm, validation  **Estimate:** 3  **Priority:** P2

---

## EPIC-K — GUI (lean ops; Laravel + Vue)
**Goal:** monitor, panic, and read results — optimized for mostly-unattended operation.

### K.1 — Auth + 2FA
- **Description:** Laravel Fortify login; 2FA gating the **go-live** and **flip-to-autonomous** actions specifically.
- **Acceptance:** Login works; enabling live / autonomous requires 2FA; sessions time out.
- **Depends on:** A.3  **Labels:** web, safety  **Estimate:** 3  **Priority:** P1

### K.2 — Reverb broadcast wiring
- **Description:** Redis → Reverb → browser; subscribe Vue to engine state channels.
- **Acceptance:** Browser receives throttled live updates; reconnect handled.
- **Depends on:** I.7  **Labels:** web, engine  **Estimate:** 5  **Priority:** P1

### K.3 — Mode banner
- **Description:** Persistent, unmissable backtest/paper/**LIVE** indicator coloring the chrome.
- **Acceptance:** Cannot mistake mode; LIVE is visually distinct (e.g., red).
- **Depends on:** A.3  **Labels:** web, safety  **Estimate:** 2  **Priority:** P0

### K.4 — Panic button (UI)
- **Description:** Always-visible control hitting G.4; confirm-but-fast; works when sockets are down (direct POST).
- **Acceptance:** Flattens in paper from the UI even with broadcast offline; audit-logged.
- **Depends on:** G.4  **Labels:** web, safety  **Estimate:** 3  **Priority:** P0

### K.5 — Live dashboard
- **Description:** Account/equity/buying-power/day-P&L, open positions w/ live P&L + distance-to-stop, working orders, watchlist w/ distance-to-trigger; all with "as-of" + STALE state.
- **Acceptance:** Values update live (throttled); stale/disconnected clearly shown.
- **Depends on:** K.2  **Labels:** web  **Estimate:** 5  **Priority:** P1

### K.6 — Trade log view
- **Description:** Filterable trade/fill log incl. tax-lot fields and per-trade R.
- **Acceptance:** Lists fills with lots/timestamps/proceeds/cost-basis; exportable later.
- **Depends on:** E.4, I.5  **Labels:** web, data  **Estimate:** 3  **Priority:** P1

### K.7 — Engine health/status panel
- **Description:** Heartbeat, WS connected?, data staleness, rate-limit headroom, breaker state.
- **Acceptance:** Reflects real engine health; turns red on stall.
- **Depends on:** G.5, K.2  **Labels:** web, safety  **Estimate:** 3  **Priority:** P1

### K.8 — Approval queue UI (secondary)
- **Description:** Cards = LLM rationale + snapshot + computed order + **countdown/expiry**; approve/veto. Used early, optional later.
- **Acceptance:** Approving within window submits; expiry lapses safely; never gates exits.
- **Depends on:** J.6, K.2  **Labels:** web, llm  **Estimate:** 5  **Priority:** P2

### K.9 — Config UI
- **Description:** Edit risk params + mode toggle; every change audit-logged; bounds enforced (risk-config schema).
- **Acceptance:** Out-of-bounds rejected; changes logged with who/when.
- **Depends on:** K.1  **Labels:** web  **Estimate:** 3  **Priority:** P2

---

## EPIC-L — Backtest + Validation tooling
**Goal:** lite in infrastructure, **thorough in coverage**. The backtest is where the sample size exists to
establish the gross edge (thousands of trades over the full history, all regimes); live-small then verifies
the cost model. Neither alone is the proof.

### L.0 — Pre-registration (before any results)
- **Description:** A dated document stating the hypotheses, the scorecard thresholds (O.1), and a **project-level stopping rule** including the negative outcome (e.g. edge not stable year-over-year, or live slippage > X → stop). Must be committed before L.2 produces a number.
- **Acceptance:** Document exists in Docs/ with a date preceding the first backtest run; thresholds are numeric and computable.
- **Done:** `Docs/Pre-Registration.md` (2026-09-22). It supersedes the L.2 and O.1 wording that came before it.
- **Depends on:** —  **Labels:** validation, docs  **Estimate:** 2  **Priority:** P0

### L.1 — Backtest job runner
- **Description:** BullMQ job: Laravel enqueues config → Node worker runs backtest adapter → results to DB; progress events.
- **Acceptance:** A submitted config runs to completion with progress; results persisted.
- **Done:** `apps/backtest` (2026-09-23). Per-signal and as-deployed runs, several variants on one replay, blind mode, the pre-registration's excluded sessions and holdout guard. The Laravel enqueue endpoint waits for EPIC-K.
- **Depends on:** F.2  **Labels:** backtest, engine  **Estimate:** 5  **Priority:** P2

### L.2 — ORB backtest (pre-registered)
- **Description:** Run the test exactly as `Docs/Pre-Registration.md` fixes it. Confirmatory: the **range-low stop** with two exits, EOD flatten and a 2R target with breakeven at 1R, top-20 opening RVOL, ETFs/ETNs excluded, long only, cost model and cost-to-risk gate on. In-sample 2016 to 2023 decides the verdict; the 2024-01 to 2026-08 holdout runs once on the frozen configuration. The published 10% ATR stop is **not** a confirmatory arm (on real 2017 data it passed the 0.15R gate on 1 signal in 873); it runs gate-off as a diagnostic next to the 50% ATR stop.
- **Acceptance:** Both exits on identical data/seed; verdict per gate computed from the pre-registration's thresholds; year-by-year table, RVOL-bucket table, and every section 7 diagnostic persisted with the run; preconditions checked (complete data, H.8 filter, ETF list committed, null model passing on the same commit); holdout sessions refused until the frozen configuration is committed.
- **Depends on:** L.0, L.1, C.6, C.8, L.6, H.8  **Labels:** backtest, validation  **Estimate:** 3  **Priority:** P2

### L.3 — Null-model run + report
- **Description:** Surface D.4 as a first-class, repeatable report.
- **Acceptance:** One command/report shows the tripwire result on the latest code.
- **Done:** `pnpm backtest null-model` (2026-09-24). Runs D.4's standing tripwire for both confirmatory exits (EOD, and 2R with breakeven at 1R) at 100,000 paths and keeps the verdict against the commit; `pnpm backtest status` shows it next to every run from that commit. The required step is in the README's backtest section.
- **Depends on:** D.4  **Labels:** validation  **Estimate:** 2  **Priority:** P1

### L.4 — Results metrics
- **Description:** Equity/drawdown curves, per-trade R, win rate, profit factor, expectancy, Sharpe/Sortino, exposure, R distribution.
- **Acceptance:** Metrics computed from a run; sanity-checked against a hand calc.
- **Done:** `apps/backtest/src/metrics.ts`, `report.ts` (2026-09-24). Per variant and direction from a persisted run's trades, a day-clustered interval on expectancy, closed-trade equity in R (and dollars as deployed), matched to a hand-worked 10-trade fixture. Kept with the run as JSON and markdown (`pnpm backtest report`).
- **Depends on:** L.1  **Labels:** backtest, validation  **Estimate:** 3  **Priority:** P2

### L.5 — Reproducibility
- **Description:** Persist config + code/git hash + RNG seed per run; enable diff of two runs.
- **Acceptance:** Same config+seed reproduces identical results; runs are comparable.
- **Done:** (2026-09-24). Dirty-tree guard on by default (`--allow-dirty` recorded in the config), a data snapshot id per run beside its commit and registration sha256, byte-for-byte reproduction tested, `pnpm backtest diff`.
- **Depends on:** L.1  **Labels:** backtest, validation  **Estimate:** 2  **Priority:** P2

### L.6 — ORB backtest realism rules
- **Description:** (1) Intrabar ordering: a 1-min bar touching both trigger and stop is treated as a stop-out, always. (2) Stop-order entries fill as market orders into momentum; use the separate pessimistic slippage parameter from C.8. (3) Regime stability as a hard gate: year-by-year breakdown of expectancy; an edge concentrated in 2020–21 fails. (4) Survivorship: universe built from bars that include in-period names delisted since (H.7).
- **Acceptance:** Each rule has a test that flips the result when violated; the year-by-year table is a required output of every ORB run.
- **Done:** (2026-09-24). Rules 1 to 4 broken one at a time in both the simulated broker and the trade simulator: every break fails a test. Survivorship has its own test (inactive assets are listed). Every run's summary carries the year-by-year table.
- **Depends on:** L.2, C.8, H.7  **Labels:** backtest, validation  **Estimate:** 3  **Priority:** P0

---

## EPIC-M — Paper Trading
**Goal:** full forward run on real-time data + news, simulated fills (discount optimism).

### M.1 — Paper run configuration
- **Description:** Wire the full loop to F.3 with cost-aware accounting; one-command start.
- **Acceptance:** A full session runs unattended in paper; EOD flat.
- **Depends on:** I.6, F.3, J.3  **Labels:** engine  **Estimate:** 5  **Priority:** P1

### M.2 — Paper accounting w/ cost model
- **Description:** Apply C.8 to paper fills so paper P&L isn't frictionless-optimistic.
- **Acceptance:** Paper trades reflect modeled spread/slippage.
- **Depends on:** M.1, C.8  **Labels:** engine, validation  **Estimate:** 3  **Priority:** P1

### M.3 — Daily digest
- **Description:** EOD summary (trades, P&L, R, alerts) via ntfy/email.
- **Acceptance:** A digest arrives after the close.
- **Depends on:** M.1  **Labels:** engine  **Estimate:** 2  **Priority:** P2

---

## EPIC-N — Live-Small + Measurement (the real proof engine)
**Goal:** tiny real money to answer the #1 unknown — does +0.08R survive real cost at our size?

### N.1 — Regime-1 micro-size enforcement
- **Description:** Hard cap (~1–2 shares / ~$50) overriding the risk formula while in validation mode; impossible to exceed.
- **Acceptance:** No live order exceeds the micro cap regardless of risk inputs.
- **Depends on:** C.2, F.4  **Labels:** safety, engine  **Estimate:** 3  **Priority:** P0

### N.2 — Live-vs-modeled slippage instrumentation
- **Description:** For each live fill, record modeled vs realized price; aggregate the gap.
- **Acceptance:** A report shows realized slippage distribution vs the cost model's assumption.
- **Depends on:** N.1, C.8  **Labels:** validation, data  **Estimate:** 5  **Priority:** P0

### N.3 — Per-trade R + live expectancy
- **Description:** Log realized R per trade; running expectancy with confidence interval.
- **Acceptance:** Live expectancy + CI visible; feeds the scorecard.
- **Depends on:** N.1  **Labels:** validation  **Estimate:** 3  **Priority:** P0

### N.4 — Tax-lot capture verification
- **Description:** Confirm every live fill records lots/timestamps/proceeds/cost-basis correctly.
- **Acceptance:** Sample fills reconcile to broker; export-ready fields populated.
- **Depends on:** E.4, K.6  **Labels:** data  **Estimate:** 2  **Priority:** P1

---

## EPIC-O — Validation Scorecard + Scaling
**Goal:** define "proven" with statistical power, then scale fast with an auto-kill safety net.

### O.1 — Validation scorecard
- **Description:** Concrete acceptance metrics under the decomposed proof: (a) backtest edge established with large n (thousands of trades) and **year-over-year stability**; (b) live slippage ≈ modeled over a minimum fill count; (c) live results not inconsistent with the backtest distribution; plus max-DD limit and null-model pass. Explicitly NOT "live expectancy statistically > 0" (unreachable for a thin edge: ~3,500 trades). Every threshold is read from `Docs/Pre-Registration.md` section 11; RVOL-bucket ordering is reported there, not gated.
- **Acceptance:** A documented, computable scorecard whose thresholds a test holds to the pre-registration; current status renders from live data; a threshold changes only through a dated amendment.
- **Depends on:** N.2, N.3  **Labels:** validation  **Estimate:** 5  **Priority:** P0

### O.2 — Promotion ladder
- **Description:** Tranche rules to step size up Regime-1 → aggressive posture only as each tranche sustains the edge over N trades.
- **Acceptance:** Size increases only when scorecard gates are met; each step logged + alerted.
- **Depends on:** O.1  **Labels:** validation, safety  **Estimate:** 5  **Priority:** P0

### O.3 — Auto-demotion / kill rule
- **Description:** Continuous check: if live expectancy/slippage breaches a band, automatically cut size or halt and alert.
- **Acceptance:** Injected divergence triggers automatic de-risk within one cycle.
- **Depends on:** O.1  **Labels:** validation, safety  **Estimate:** 5  **Priority:** P0

### O.4 — Scale-up automation
- **Description:** Glue O.2/O.3 to the live sizing config so scaling is rule-driven, not ad-hoc.
- **Acceptance:** End-to-end: cleared gate → larger tranche; breached band → auto cut — both without manual edits.
- **Depends on:** O.2, O.3  **Labels:** validation, engine  **Estimate:** 3  **Priority:** P1

---

## Suggested execution order (critical path)
**Now:** EPIC-B (archiver) ∥ EPIC-A (setup).
**Foundation:** C → D → E → F.1/F.5 → G (safety core).
**Live pipeline:** H → I → J.
**Surface + validate:** K (lean) → L (lite) → M (paper) → N (live-small) → O (scorecard/scale).

> Parallelizable: EPIC-A and EPIC-B from day one; EPIC-K can begin once I.7 publishes state; EPIC-L is
> independent of the live loops once F.2 + H.7 exist.

**Minimum critical path to live-small** (~60% of points; the only way "a few months" holds): A, B, C, D, E,
F (all; F.2 feeds the edge-establishing backtest), G, H.2/H.3/H.6/H.7/H.8, I, L.0/L.1(minimal)/L.2/L.3/L.6,
K.3/K.4/K.6/K.7 (+ minimal K.5), M.1/M.2, N. **Deferred past live-small:** K.8/K.9, LLM live gating (J stays in
shadow; J.8 later), L.4, M.3.

**Path to the first real answer (the backtest result, before any capital is committed):** A → C → D → E.4 →
F.1/F.2 → H.7 → L.0 → L.1 + H.8 → L.2 + L.6 → L.3. Everything else only matters if that number is positive and stable.
