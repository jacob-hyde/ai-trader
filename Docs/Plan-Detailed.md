# AI-Assisted Equities Day-Trading System — Detailed Plan

> **Canonical detailed planning document.** Consolidates the original engineering spec + all planning
> decisions (2026-06-23, 4 interview rounds) + the setup research findings. Supersedes the previous
> root `PLAN.md`. Companion docs in this folder: `SOW.docx`, `Plan-Overview.docx`, `Tasks.md`.

---

## 0. Framing — what this system actually is

**A measurement instrument first, a money-maker second.** The $2,500 is a deliberate proving-ground
tranche. The win condition is a *trustworthy, net-of-cost yes/no on whether a real edge exists* —
judged primarily on **live-small real money** — before scaling capital behind it.

Everything flows from that: **validation rigor, the autonomous safety stack, and honest accounting are
the core.** Squeezing returns out of the $2,500 is explicitly *not* the goal. The research base rates
make the stance mandatory: in full-population studies (Taiwan 1992–2006; Brazil 2013–2015), **80–97%
of retail day traders lose net of costs and <1% are persistently profitable**, with transaction costs
alone *tripling* gross losses. Every setup is guilty until proven net-profitable on our universe at our size.

---

## 1. Goal & economics

| | Decision |
|---|---|
| **Objective** | Proving ground to scale — fund larger only if it shows a real net-of-cost edge in live-small |
| **Pace** | Measured — no deadline; correctness over speed; live-small in a few months |
| **Capital** | $2,500 (margin account, self-imposed 1×; $2,000 margin minimum applies) |
| **Run mode** | Mostly unattended (autonomous primary); approval queue built but secondary/early-trust |
| **Data spend** | Pay from day one — SIP + Finviz Elite on now |

**Capital reality (added 2026-09-19).** $2,500 is enough to *validate* (clears the $2,000 margin
minimum; supports 4–5 whole-share positions in the $5–100 universe) but the notional cap binds against
the ORB's tight stop, so effective risk per trade is ~$1–6 (0.1–0.25% of equity). At self-imposed 1×
leverage the strategy's return on capital is structurally low — on the order of **~5%/yr even if the
edge is real** (≈ E_net 0.05R × ~750 trades × R$ ≈ 0.1% of equity). Infra is ~$2,000/yr, so break-even
on infra needs roughly **$40k at 1×** (~$20k at 2×); the paper's 36%/yr was a 4×-leverage artifact.
"Scale" therefore means tens of thousands, and **leverage becomes a strategic decision after
validation** rather than a safety default — flagged, not recommended: leverage on a thin edge is how
accounts blow up. Independent of account size, the dominant survival variable is the cost-to-risk
ratio (§3 caveat 4).

---

## 2. Consolidated decision ledger

| Area | Decision |
|---|---|
| App stack | Laravel + Vue + PostgreSQL/TimescaleDB |
| Engine | Node + TypeScript (real-time trading engine) |
| Cache/pubsub | Redis (required — the engine↔app bridge) |
| Broker | Alpaca (`@alpacahq/alpaca-trade-api`) — single source of truth |
| Account | $2,500, margin 1×, **whole-share native bracket OCO**, universe $5–100 |
| Direction | **Long-only v1**; architecture supports both (shorts behind off-by-default flag) |
| Trade style | Fewer, higher-conviction; cost-aware selection |
| Control model | Both modes toggleable (approval queue + autonomous); **exits never gated** |
| Deployment | Local dev → Linode VPS for live; Docker parity both ends |
| Database | Self-hosted **TimescaleDB in Docker** (hypertables for bar archive) |
| Backtest scope | Honest mechanics **+** clearly-labeled research replay (replay = exploration, not proof) |
| Proof philosophy | **Live-data-weighted** — backtest is a sanity check; live-small is the arbiter |
| Scaling | Scale fast once proven — but "proven" defined with real statistical power (§6) |
| LLM split | **Anthropic** Haiku 4.5 (classify) + Sonnet 4.6 (Stage-5 judgment); cache system prompt |
| Risk posture (target) | Aggressive: 1.5%/trade, 25% max position, 4–5 concurrent, −5% daily breaker, 1.5–2R |
| Setup arch | Multi-setup **framework now**, ORB the sole live setup until proven |
| v1 setup | **High-RVOL Opening Range Breakout** (§3) |
| ORB exit | A/B test EOD-flatten vs fixed 1.5–2R + breakeven-at-1R |
| GUI scope v1 | Lean ops first (panic, status, positions, trade log, basic P&L) |
| Alerts | ntfy (push) for high-urgency events |
| Secrets | Docker secrets + .env; never in DB or UI |
| Tax records | Capture tax-lot data (lots/timestamps/proceeds/cost-basis) from day one |
| Users | Single user |

---

## 3. Strategy — v1 setup

### High-RVOL Opening Range Breakout (the only evidence-anchored, codeable edge)

Peer-reviewed anchor: Holmberg/Lönnbark/Lundström 2013 (futures). Replicated codeable spec:
Zarattini/Barbon/Aziz, SSRN 4729284 (2024) + independent QuantConnect replication.

```
Stage 3 gate:    price $5–100, 14-day avg vol > 1M shares, ATR(14) > $0.50
                 rank by RVOL = today's first-5min volume / 14-day avg first-5min volume
                 trade ONLY the top ~20 "in play" names (tighten toward top 5–10: edge rises steeply
                 with RVOL, and higher per-trade R cuts the proof sample quadratically), only when RVOL > 100%
                 cost-to-risk gate: (round-trip spread + expected slippage) / stop distance ≤ ~0.15R
Stage 4 trigger: opening range = first 5-min candle (09:30–09:35 ET)
                 bullish candle → long (v1); bearish → short (flagged off); doji → skip
                 entry = stop order at the 5-min high
Stop:            A/B — 10% of 14-day ATR (published) vs wider (e.g. 5-min low / ~50% ATR). At 1× with a
                 binding notional cap a wider stop raises R$ and improves cost/R; test if the edge survives it
Target:          A/B — (a) flatten at EOD (published edge) vs (b) fixed 1.5–2R + breakeven@1R
Hold:            intraday, up to the close (NOT a scalp)
```

**The edge lives in the RVOL gate, not the breakout** (+0.08R/trade when RVOL>100% vs −0.02R below).
That gate goes into Stage 3 as a filter on *every* setup — "fewer, higher-conviction" made mechanical.

### Three honest caveats
1. **Low-win-rate, fat-tailed** (~17% win rate, rare large winners at the close). The published edge is
   the EOD-run version; the 1.5–2R target is a *different* strategy — hence the A/B.
2. **Headline numbers are not net-realistic for us.** The 1,600%/Sharpe-2.81 result models
   commission-only (zero spread/slippage) on $25k + 4× leverage. The real edge is **+0.08R/trade**.
3. **The #1 decision-critical unknown:** does +0.08R survive real spread/slippage at our size? No source
   answered it. **This is exactly what live-small exists to measure** → the honest cost model comes first.
4. **Cost-to-risk (added 2026-09-19):** the 10%-of-ATR stop is tiny in dollars, so per-share round-trip
   cost is a large fraction of R and independent of account size. A $1-ATR name has a $0.10 stop; a
   $0.06–0.10 round trip is 0.6–1.0R, which no +0.08R edge survives. A $5-ATR name (stop $0.50) makes the
   same cost 0.12–0.20R. Survival requires high-ATR names where cost ≪ stop, hence the cost-to-risk gate
   in Stage 3 and the stop-width A/B.

### Other research results
- **Intraday-momentum / time-of-day anomaly** (JF 2010, JFE 2018): real but **index/ETF-level only**.
  Use as a *market-regime filter*, not a per-stock signal. (The standalone "first-30m sign → go long
  last-30m" rule was **refuted** — loses after the spread.)
- **LLM news-drift layer**: GPT-4 headline scores predict post-news drift, but concentrated in **small
  caps / negative news / the short side** — where v1 can't or shouldn't trade. **Lower priority for v1.**
- **Folklore flag** — VWAP reclaim, prior-day H/L breaks, gap-and-go, pullback-to-MA surfaced **no**
  surviving net-of-cost evidence. Only ever deploy nested inside the validated RVOL gate, never standalone.

---

## 4. Architecture

### Repo layout (monorepo)
```
/apps/web           # Laravel + Vue (GUI, auth, config, reporting, panic)   [strong area]
/apps/engine        # Node/TS real-time engine                              [weak area → heavy tests]
/packages/core      # Pure: sizing, risk, indicators, Setup interface + ORB
/packages/adapters  # Data + execution: backtest | paper | live (one interface)
/packages/contracts # Shared types: LLM payload/response schema, decision-log schema
/infra              # Docker, compose, Linode deploy
/data               # Bar storage / migrations (Timescale-backed replay)
```
`packages/core` is the crown jewel: pure functions, 100% unit-tested. **Because the engine/TS is the
weakest area *and* most safety-critical, lean hard on the property/invariant test harness, strong
typing, and a thin engine.** Keep Laravel/Vue light (home turf).

### Live data path (fixed by Alpaca's one-WS-per-account limit)
```
Alpaca WS ─► Node engine (sole consumer) ─► Redis pub/sub ─► Laravel Reverb ─► browser
```
Browser never connects to Alpaca directly. Throttle/conflate ticks to ~1–2 Hz before pushing to the UI.

### Run modes (one engine, swappable adapters): backtest · paper · live.

### Two sizing regimes (reconciles "live-small early" + "aggressive target")
- **Regime 1 — validation/data-gathering:** forced micro size (hard cap ~1–2 shares / ~$50 notional,
  overriding the risk formula). Purpose is *data* (real fills/slippage), not P&L.
- **Regime 2 — proven:** the aggressive posture, reached only via the promotion ladder (§6).
- Aggressive sizing must **never** apply to an unproven strategy.

---

## 5. Risk & sizing

```
risk_based_shares   = (equity * risk_per_trade)   / (entry - stop)
notional_cap_shares = (equity * max_position_pct)  / entry
shares = floor( min(risk_based_shares, notional_cap_shares, buying_power/entry) )
            [Regime 1: additionally clamp to the micro hard-cap]
reject if shares < 1 OR position too small to clear the spread
```
- Per-position cap 25%; max 4–5 concurrent; aggregate open risk ≤ 2–3%.
- **At $2,500 the notional cap, not the risk %, sets size** (added 2026-09-19): the 10%-ATR stop is so
  tight in dollars that 1.5% risk would imply a position far above the 25% cap, so effective risk per
  trade lands around 0.1–0.25% of equity ($1–6). The posture percentages only bind as capital and/or
  leverage rise. A wider stop (A/B'd in §3) raises R$ toward the intended risk and improves cost/R.
- **Daily-loss circuit breaker (most important rule):** −5% day P&L → halt new entries (optionally flatten).
- Stops at broker (structure or ~1–1.5× ATR); breakeven at +1R; trail; **EOD hard-flatten ~15:50 ET**.
- **Exits are deterministic and never gated** by the approval workflow.

---

## 6. Validation & proof methodology  *(the heart of the project)*

**Philosophy (revised 2026-09-19): backtest proves the edge, live proves the cost.** The June plan leaned
on live-small as the arbiter, but the arithmetic doesn't allow it. A +0.08R expectancy at a ~17% win
rate (losers −1R, winners ~5.3R) has a per-trade SD of ~2.4R; a t-stat of 2 needs ≈ (2 × 2.4 / 0.08)² ≈
**3,500 trades**, which at 2–5 trades/day is **3–7 years**. Live-small yields a few hundred trades and
cannot confirm a thin edge. So the proof decomposes:
- **Backtest establishes the gross edge**: the only place thousands of trades exist. Lite in
  infrastructure, **thorough in coverage** (full history, all regimes). Must also pass the
  **null-model tripwire** (GBM random walks; profit on driftless data = alarm) and catch look-ahead /
  accounting bugs. Research-replay stays a nice-to-have; keep archiving but don't gold-plate it.
- **Live-small establishes the cost model**: realized slippage ≈ modeled, fills as expected, results
  not inconsistent with the backtest distribution. It measures cost, not edge.
- **Together** they are the proof; neither alone is.
- **Lever:** required sample ∝ (SD/E)². Tightening the RVOL gate (top 5–10 vs 20) raises per-trade E
  and cuts the required sample quadratically — "fewer, higher-conviction" with math behind it.

**Backtest realism rules (ORB-specific):**
- Intrabar ordering: if a 1-min bar touches both the entry trigger and the stop, assume the stop. Always.
- Stop-order entries fill as market orders into momentum; model that slippage separately and
  pessimistically. It is the number live-small exists to calibrate.
- **Regime stability is a hard gate:** the source data (2016–2023) includes the 2020–21 retail-momentum
  regime. Require a year-by-year breakdown; an edge concentrated in two years is not an edge.
- Survivorship: the historical universe must include names active in-period but delisted since.

**Pre-registration (before any results):** a dated document stating the hypotheses, the scorecard
thresholds, and a **project-level stopping rule** including the negative outcome ("if the edge isn't
year-over-year stable, or live slippage exceeds X, we stop"). A clean "no edge" is a successful
measurement; pre-committing is what prevents goalpost-moving.

**Measurement instrumentation** stays first-class: real-vs-modeled slippage per fill, per-trade R
logging, and the **validation scorecard**.

### The promotion/demotion ladder (the most important logic in the system)
Because the plan is **scale-fast-once-proven** on a **razor-thin (+0.08R, ~17% win) edge**, "proven"
must be defined with enough statistical power that we don't lever into a lucky streak:
- **Promotion:** step size up in tranches only when (a) the backtest edge is established with large n
  and year-over-year stability, (b) live slippage ≈ modeled over a minimum fill count, and (c) live
  results are not inconsistent with the backtest distribution. Not "live expectancy statistically > 0":
  that bar is unreachable for a thin edge (see above).
- **Demotion / kill:** an automatic rule that **cuts size or halts the moment live diverges** from
  expectation. Crisp and pre-committed.
- The promotion threshold is the single most important number in the system.

LLM + news layer validated only by **forward paper/live on real news** (no other look-ahead-free ground truth).

---

## 7. Safety & ops  *(build early — real money before the edge is proven)*

- **Panic button (build first):** flatten-all + halt; direct authenticated POST to an engine endpoint
  that flattens via Alpaca **REST**, independent of the websocket/broadcast stack.
- **Startup reconciliation:** Alpaca is truth — adopt its positions/orders, reconcile DB, **alert on
  anything unexplained**, never auto-submit to "fix" a discrepancy.
- **Idempotent orders** keyed off client order IDs.
- **Partial fills:** filled qty *is* the position; cancel/replace stop+target legs to cover exactly that
  qty; abort if remainder < minimum viable size.
- **Watchdog/heartbeat** → **ntfy** push on breaker trip, stall, fills, divergence-kill.
- **LLM failure** (malformed JSON / timeout / down): skip the candidate, log, trade nothing.
- **LLM shadow mode (v1):** Stage-5 runs and logs every decision but gates no trade. Promote it into
  the live path only if the logged data shows its vetoes/rankings would have improved results.
- **Bad-tick filter:** reject quotes/prints more than a threshold away from the last bar before acting;
  one erroneous print must never trigger a stop or a false breakout.
- **Mode banner** (backtest/paper/**LIVE**) impossible to miss — color the whole UI chrome.
- **Decision inspector / log:** every Stage-5 LLM payload+response stored & browsable (one shared
  schema powering inspector, approval card, and replay).

---

## 8. Infrastructure

- **Hosting:** Linode VPS (always-on) for live; develop locally, deploy via Docker (parity).
- **DB:** self-hosted TimescaleDB in Docker, hypertables for bars; **nightly off-box backups** of the
  (irreplaceable) archive + trade log.
- **Secrets:** Docker secrets + .env.
- **Time:** store UTC, compute/display in ET, NTP-synced; show a market-session clock.
- **Cost model (engineering default):** fills at quote ± half-spread + slippage allowance (~1 tick / few
  bps, tunable); never frictionless; applied in backtest *and* paper accounting.
- **Auth:** Laravel Fortify + 2FA gating the go-live / flip-to-autonomous actions; panic endpoint gets
  its own token (works in degraded state).

---

## 9. Data

- **Market data:** Alpaca SIP (Algo Trader Plus) **on now**. Screener + static list + news symbols →
  universe; multi-symbol snapshots → buyable gate; 1-min bar + NBBO stream for watchlist/positions only;
  REST-batch the wide scan. History `adjustment=all` for backtest, raw for live.
- **Fundamentals:** Finviz Elite nightly CSV → Postgres `fundamentals`. Real-time borrow = Alpaca
  `shortable`/`easy_to_borrow` at execution.
- **News:** Alpaca news API + websocket.
- **The archiver (cheap insurance, build early):** append-only, timestamped capture of the nightly
  Finviz snapshot, the news stream, and daily screener output. It records exactly the feed the live
  system acts on, which keeps replay and debugging faithful. It is NOT the only route to this data:
  ADV, RVOL, and the screener/in-play ranking are pure computations on Alpaca historical bars (free
  when older than 15 min); news history comes from Alpaca's REST endpoint by date range; short-interest
  history from FINRA/Polygon; shares outstanding from SEC filings. The one source with no history API is
  Finviz itself (its computed float / short-float snapshot), for which current values or SEC-derived
  shares outstanding are a workable proxy. A gap in the archiver is recoverable by backfill (Tasks.md
  B.10), so this is early-priority, not an emergency.

---

## 10. Build order & milestones

0. **Data archiver + historical backfill** — append-only capture going forward, plus a backfill of the
   missing history from bars, news REST, and short-interest sources. *Cheap; do early, decoupled. Not
   an emergency: a gap is recoverable.*
1. **`packages/core`** — risk + sizing (two regimes), indicators, `Setup` interface + ORB. 100% tested.
2. **Synthetic path generator + property/invariant suite + null-model tripwire.**
3. **`packages/contracts`** — LLM payload/response + decision-log schema.
4. **Safety core + Alpaca paper smoke test** — bracket, reconciliation, idempotency, **panic** (early).
5. **Data ingestion** — SIP screener/snapshots/min-bar stream + news + Finviz nightly → Timescale.
6. **The loops** — 30-min scan, watchlist, 30s monitor, EOD flatten + watchdog/ntfy.
7. **Backtest-lite** — null-model + ORB A/B sanity on real bars (don't over-build).
8. **LLM integration** (Stage 5) + golden-case eval.
9. **GUI (lean ops)** — panic, status/positions, trade log, basic P&L.
10. **Paper trading** — full forward run.
11. **Live-small** — Regime 1 micro size; measure live-vs-modeled slippage; the real proof.
12. **Validate against the scorecard → scale fast** via the promotion ladder (kill rule live).

**Minimum critical path to live-small** (the only way "a few months" holds; ~60% of total points):
EPIC-A, B (archiver + backfill), C, D, E, F (all; F.2 feeds the edge-establishing backtest), G,
H.2/H.3/H.6/H.7/H.8, I,
L.0/L.1(minimal)/L.2/L.3/L.6 (backtest coverage for the edge), K.3/K.4/K.6/K.7 (+ minimal K.5),
M.1/M.2, N. **Deferred past live-small:** the rest of the GUI (K.8/K.9), LLM live gating (J stays in
shadow; J.8 later), backtest UI polish (L.4), M.3.

---

## 11. Open design artifacts to produce

- [ ] LLM payload + response JSON contract (`packages/contracts`)
- [ ] Shared decision-log schema
- [ ] Reconciliation algorithm (explicit discrepancy-resolution rules)
- [ ] Validation scorecard + promotion/demotion ladder (metrics, min trade counts, bands)
- [ ] Risk-config schema (tunable params + bounds)
- [ ] Archiver table schemas (`fundamentals_snapshots`, `news_events`, `screener_snapshots`)
- [ ] ORB Stage-3/Stage-4 spec as pure-function signatures
- [x] Pre-registration document (hypotheses, scorecard thresholds, project-level stopping rule), dated
  before any backtest result: `Docs/Pre-Registration.md`, which also fixes the scorecard, ladder, and
  kill-rule numbers

---

## 12. Recurring costs (live)

| Item | Cost |
|---|---|
| Alpaca commissions | $0 |
| Alpaca Algo Trader Plus (SIP) | ~$99/mo |
| Finviz Elite | ~$25/mo |
| Linode VPS | ~$10–40/mo |
| News feed | Alpaca-bundled ($0) |
| LLM (Anthropic, event-triggered) | ~$10–50/mo |
| **Approx total** | **~$145–215/mo** |

> Annual infra (~$1,700–2,600) exceeds plausible returns on $2,500 — which is *why the objective is
> proving-ground-to-scale, not income on $2,500.* Verify current model IDs/pricing at build time.

---

## 13. Hard-won cautions (non-negotiable)

- Small-account stock day trading has a **brutal cost floor**; the liquidity gate + cost realism *are*
  the strategy. A +0.08R edge means **spread + slippage is the whole game**.
- **Backtest the mechanics; forward-test the intelligence.** Here, **live-small is the arbiter.**
- The **LLM proposes; deterministic code disposes** — it never sizes or executes; risk can veto it.
- **Build the kill switch before the strategy.**
- **Scale-fast is only safe if "proven" has real statistical power.** Define the bar and the kill rule
  before levering up.
