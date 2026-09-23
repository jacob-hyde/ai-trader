# Pre-Registration: ORB edge test (L.0)

Written 2026-09-22, before any ORB backtest result exists. The commit that adds this file is its
timestamp. It fixes the hypotheses, the exact strategy tested, the samples, the statistics, every
pass/fail threshold, and the project-level stopping rule, so that no number produced later can move
them.

A clean "no edge" is a successful measurement. The design below is strict on purpose: it would rather
miss a thin real edge than fund a lucky one (see the operating characteristics, section 9).

Everything in section 11 is machine-readable. O.1 (scorecard), O.2 (promotion ladder), and O.3 (kill
rule) take their numbers from there and nowhere else.

## 1. What was seen before this was written

This matters because the in-sample period overlaps data already looked at. The full list:

1. **The published result.** Zarattini, Barbon, and Aziz (SSRN 4729284) report the ORB edge on
   2016 to 2023. That is our in-sample period, so the paper's parameters were in effect fitted on it.
   This is why the holdout (section 4) starts in 2024, after the paper appeared.
2. **Daily bars for every ticker since 2016**, loaded and screened for eligibility (H.7). No returns
   were computed from them.
3. **The F.2 benchmark (2026-09-22).** A stand-in breakout was replayed on 2017 to time the adapter:
   the 20 busiest liquid names (not ranked by RVOL, no cost gate), entry one tick over the first
   five-minute high, stop at its low, flatten at 15:49, one share. It printed its final equity only:
   -$484 over about 3,692 round trips on a $25,000 account, and -$25.66 for June 2017 alone. This
   is outcome information about a related strategy inside the in-sample period.
4. **The signal-time feasibility check in section 8**, on 2017-01-03 to 2017-05-31. It used bars up
   to 09:35 only: which names ranked in play, their opening range, and whether each stop passed the
   cost gate. No bar after the signal was read.
5. Synthetic data only, everywhere else (goldens, invariants, null model).

## 2. Hypotheses

**H1 (confirmatory).** Long-only ORB on the top-20 opening-RVOL names of the $5 to $100 universe, with
the range-low stop and the cost-to-risk gate, has positive expectancy net of modeled costs. Tested for
two exits, as a family of two:

- **A. EOD:** no target, flatten at the end of day.
- **B. 2R:** target at 2R, stop moved to breakeven once price reaches 1R.

**H2 (confirmatory, part of the verdict).** The edge is stable year over year and not concentrated in
the 2020 to 2021 retail-momentum regime.

**H3 (secondary).** The cost-to-risk gate improves expectancy: signals it passes do better, net, than
the signals it rejects.

**H4 (secondary).** The published stop (10% of the 14-day ATR) does not survive our cost model. The
feasibility check (section 8) found it passes the 0.15R gate on 1 signal in 873, median cost 1.32R,
so it cannot be a confirmatory arm. It is still measured, with the gate off, so the answer is on record.

**H5 (secondary).** Expectancy falls with RVOL rank: ranks 1 to 5 beat 6 to 10, which beat 11 to 20.

Secondary hypotheses are reported with every run. None of them changes the verdict.

## 3. The strategy as tested

Frozen. Any change is an amendment (section 12).

**Data.** The H.7 bar store: SIP minute bars, regular hours, ticker-at-time, prices as traded. Every
lookback is split-restated as of the session being traded. Dividends are not adjusted.

**Universe, per session D.** A symbol qualifies when, judged on sessions before D only:

- Prior close between $5 and $100 inclusive.
- Mean daily volume over the prior 14 sessions above 1,000,000 shares.
- ATR(14) on daily bars (Wilder, core's `Atr`) above $0.50.
- Its 14 most recent sessions with bars all fall inside the last 20 sessions of the calendar. This
  drops new listings and a ticker that has just been reused by another company.
- It is not on the frozen ETF/ETN exclusion list (below).

**ETF/ETN exclusion.** Built once, before L.2, from a keyword match on Alpaca's asset names (ETF, ETN,
Fund, and the fund issuers: iShares, SPDR, ProShares, Direxion, Invesco, VanEck, Vanguard, Global X,
WisdomTree, and similar), reviewed by hand so REITs ("Realty Trust") and ADRs ("Depositary Shares")
stay in, plus manual additions for delisted products the asset list does not carry. Committed as a
file with its own date before the first L.2 run, and never changed after it.

**Ranking.** Opening RVOL = volume of minutes 0 to 4 on D over the mean volume of minutes 0 to 4 across
the prior 14 sessions. It must be above 1.00. Qualifying names rank by RVOL, highest first, ties by
symbol. The top 20 are in play.

**Signal.** The opening range is minutes 0 to 4 (09:30 to 09:35). Close above open is a long signal.
Close at or below open is no trade. Shorts are simulated as a diagnostic only.

**Entry.** Buy stop at the range high, placed at the range close. No entry once price has already traded
through it. The entry works until 30 minutes before the close: minute 360 on a full day, 180 on a half
day. One trade per symbol per session.

**Stop.** The range low. At least one tick below entry, otherwise no trade.

**Cost-to-risk gate.** Round-trip cost per share (C.9: modeled quote on the minute-4 close, stop-entry
leg and stop-exit leg) at or below 0.15 times the stop distance.

**Exits.** A (EOD): flatten at minute 380 on a full day (15:50), 200 on a half day, at the next bar's
open. B (2R): take-profit at entry + 2R, and the stop moves to entry after a bar reaches entry + 1R,
protecting from the next bar on. Either way, anything still open at the close exits at the last close.

**Fills.** The F.2 simulated broker: a bar that reaches the stop and anything favorable is a stop-out,
a gap through a level fills at the open, halts fill nothing, every fill priced by the default cost
model (spread 10 bps or 1 tick; market 2 bps or 1 tick; stop entry and stop exit 10 bps or 2 ticks;
no commission). Sell-side SEC and TAF fees are left out: about 0.002R per trade.

**Preconditions for L.2 to count.** The minute load is complete for every month used, and the verify
report shows no unexplained holes. The H.8 bad-tick filter runs between the store and the broker; a
single bad print otherwise fills an entry and a target. The null model (L.3) passes on the same commit.

## 4. Samples

- **In-sample:** 2016-01-04 to 2023-12-29. The first tradable session is 2016-01-25, the first with a
  full 14-session lookback. Eight calendar years.
- **Holdout:** 2024-01-02 to 2026-08-31. Untouched until the holdout protocol runs.

**Holdout protocol.** It runs once. Before it runs, a dated addendum is committed to this file with the
in-sample verdict, every in-sample number used below, and the frozen configuration. The holdout then
runs on that configuration only. L.1 should refuse sessions on or after 2024-01-02 unless a frozen
configuration is committed.

**Frozen configuration.** Chosen from in-sample data by rule, not by judgment:

1. Exit: of the variants that pass section 6, the one with the higher one-sided 95% lower bound on
   in-sample net mean R (day-clustered bootstrap).
2. Top N: 20, or 10 if the top 10 alone passes every in-sample gate and has the higher lower bound.

## 5. Measurement and statistics

**Unit.** Net R per trade: (exit fill minus entry fill), signed by direction, over the planned risk per
share (entry minus stop). Gross R (reference to reference) is recorded too.

**Per signal, not per account.** The confirmatory test measures every qualifying signal with no account
constraints: no position cap, no concurrency limit, no buying-power limit, fixed size. The question is
whether the signal has an edge. Account constraints decide which signals a small account can take,
and they are measured separately (section 7).

**Estimator.** The mean net R across trades.

**Inference.** A day-clustered bootstrap. Trades on the same day share the market's direction, so they
are not independent, and a per-trade standard error would overstate certainty. Resample trading days
with replacement, all of a day's trades together, 20,000 times, seed 20260922. The one-sided p-value
is the share of resampled means at or below zero. Lower bounds are the matching percentiles.

**Multiplicity.** Holm over the two confirmatory exits, family-wise alpha 0.05 one-sided: the smaller
p-value must be at or below 0.025, the larger at or below 0.05.

## 6. The verdict

**In-sample gates.** A variant passes only if all hold:

| Gate | Threshold |
|---|---|
| Trades | at least 2,000 |
| Net expectancy | Holm-adjusted day-clustered bootstrap p-value within alpha (section 5) |
| Years positive | net mean R above 0 in at least 5 of the 8 calendar years |
| No year carries it | dropping any single year, the rest still has net mean R above 0 |
| Not a 2020 to 2021 edge | 2016 to 2019 and 2022 to 2023 together have net mean R above 0 |

A variant under 2,000 trades is INSUFFICIENT. That is a failure for this study: a strategy that cannot
produce a testable sample under our costs is not one we can deploy.

**Holdout gates.** The frozen configuration passes only if both hold:

| Gate | Threshold |
|---|---|
| Positive | holdout net mean R above 0 |
| Not worse | in-sample net mean R at or below the holdout mean plus 1.96 day-clustered standard errors |

**Outcomes.**

- **EDGE:** a variant passes in-sample and the frozen configuration passes the holdout. The project
  proceeds to paper (M) and live-small (N).
- **NO EDGE:** anything else. The project stops (section 10).

## 7. Diagnostics reported with every run

None of these gates the verdict.

- **H3, the gate's value:** net mean R of range-low signals the gate passed against those it rejected
  (simulated anyway).
- **H4, the published stop:** 10% ATR stop, gate off, both exits, net mean R with its interval.
- **50% ATR stop:** gate on, both exits. Its sample is small (about 0.9 signals a session pass).
- **H5, RVOL buckets:** net mean R for ranks 1 to 5, 6 to 10, and 11 to 20.
- **Shorts:** the bearish-range side, both exits.
- **Year-by-year table:** trades, net mean R, and total net R per calendar year (L.6 requires it).
- **Cost sensitivity:** net mean R with every slippage allowance at 0.5x, 1.5x, and 2x.
- **Break-even stop-entry allowance B:** the stop-entry allowance, in basis points, at which the
  frozen configuration's in-sample net mean R reaches zero. The live cost check uses the same margin.
- **As deployed:** the frozen configuration run through the real account rules: $2,500, 1x, 25% per
  position, 4 concurrent, 2% open risk, 5% daily breaker (no flatten), sized at the aggressive posture
  (1.5% risk per trade). Reports dollars, maximum drawdown, and how many signals the account rules
  skipped. Its maximum drawdown sets the drawdown bands in section 10.

## 8. Feasibility check (signal time only)

2017-01-03 to 2017-05-31, 89 sessions with a full lookback, top 20 by opening RVOL, long signals only.
No data after 09:35. About 9.8 bullish signals a session.

| Stop | Pass the 0.15R gate | Per session | Median cost |
|---|---|---|---|
| 10% ATR (published) | 1 of 873 (0.1%) | 0.01 | 1.32R |
| 50% ATR | 79 of 873 (9%) | 0.89 | 0.26R |
| Range low | 312 of 873 (36%) | 3.5 | 0.20R |

If about 60% of range-low signals trigger, that is roughly 2 trades a day: about 4,000 in-sample trades
and about 1,300 in the holdout. The trigger rate was not measured, since that would read bars after
the signal.

## 9. Operating characteristics

How often the full chain (in-sample gates, then the holdout) passes, simulated with the section 6 rules
on a skewed per-trade distribution (35% winners, per-trade SD 1.9R), day-clustered, 2,000 runs each.
The true net edge is fixed per row.

| True net edge | 2 trades/day, day correlation 0.15 | 2 trades/day, correlation 0.05 | 1 trade/day, correlation 0.15 |
|---|---|---|---|
| 0 | 0.6% | 0.8% | 0.5% |
| +0.03R | 8% | 10% | 4% |
| +0.05R | 21% | 28% | 8% |
| +0.08R | 52% | 65% | 21% |
| +0.12R | 85% | 92% | 42% |

A zero edge almost never passes. An edge as thin as the paper's +0.08R, and it is thinner still after
our costs, passes about half the time. The significance gate does nearly all of the rejecting; the
stability gates add protection against a regime-concentrated edge, which this simulation does not model.

## 10. Stopping rule and live bands

**The project stops** (no capital beyond the micro regime, no further strategy build-out) on any of:

1. **NO EDGE** in section 6, including INSUFFICIENT.
2. **The null model fails** on the commit that produced L.2 and the cause is not a bug. A bug voids every
   result produced before its fix; the rerun uses this design unchanged.
3. **Live costs eat the edge:** after at least 100 live stop-entry fills, the lower 95% bound of live
   excess cost per round trip (realized minus modeled fills, both legs, in R) is above the frozen
   configuration's in-sample net mean R.
4. **Live is inconsistent with the backtest:** after at least 300 live trades, live net mean R is below
   the in-sample net mean R minus 2.33 day-clustered standard errors of the live mean.
5. **A second statistical HALT** (below) within 12 months, not explained by a software fault.

After a stop, any new setup or variant is a new study with its own pre-registration. Results from this
one cannot justify it, and the data looked at here is no longer out of sample for anything inspired by it.

**Live-small (Regime 1).** One share per trade, any name in the universe, every other risk rule on. It
measures cost, not edge.

**Promotion out of each tranche (O.2).** Micro, then 25%, 50%, and 100% of the aggressive posture
(1.5% risk per trade, 25% per position, 4 concurrent, 5% daily breaker). Every step needs all of:

- At least 100 closed trades and 100 stop-entry fills at the current tranche.
- **Cost:** in-sample net mean R minus the upper 95% bound of live excess cost per round trip, in R,
  at or above 0.
- **Consistency:** live net mean R at or above in-sample net mean R minus 2.33 standard errors.
- **Breaker held:** no session lost more than the daily limit plus the largest position's planned risk.
- **Drawdown:** live maximum drawdown at most 1.5x the as-deployed backtest's, scaled to the tranche.
- No open kill condition, and a 2FA-confirmed human step. Tranches cannot be skipped.

**Kill bands (O.3),** checked after every closed trade on the trailing 100 trades at the current tranche:

| Band | Demote one tranche | HALT |
|---|---|---|
| Expectancy | trailing net mean R below in-sample mean minus 3 SE | below in-sample mean minus 4 SE |
| Cost | live excess cost point estimate above half the in-sample mean | lower 95% bound above the in-sample mean |
| Drawdown | above 1.5x the as-deployed backtest's, scaled | above 2x |
| Breaker | | any session past the daily limit plus one position's planned risk |

Re-promotion after any demotion or HALT needs a logged, 2FA-gated review, not just passing gates.

## 11. Thresholds (machine-readable)

```json
{
  "version": 2,
  "registered": "2026-09-22",
  "samples": {
    "inSample": { "from": "2016-01-04", "to": "2023-12-29", "firstTradable": "2016-01-25" },
    "holdout": { "from": "2024-01-02", "to": "2026-08-31" },
    "excludedSessions": ["2022-03-08"]
  },
  "strategy": {
    "setup": "orb",
    "direction": "long",
    "priceMin": 5,
    "priceMax": 100,
    "minAverageVolume": 1000000,
    "minDailyAtr": 0.5,
    "lookbackSessions": 14,
    "lookbackWindowSessions": 20,
    "openingRangeMinutes": 5,
    "minOpeningRvol": 1.0,
    "topN": 20,
    "topNChoices": [10, 20],
    "stop": { "kind": "openingRange" },
    "exits": [
      { "id": "A", "kind": "eod" },
      { "id": "B", "kind": "fixedR", "targetR": 2, "breakevenAtR": 1 }
    ],
    "lastEntryMinutesBeforeClose": 30,
    "flattenMinutesBeforeClose": 10,
    "maxCostToRisk": 0.15,
    "excludeEtfs": true
  },
  "statistics": {
    "method": "dayClusteredBootstrap",
    "resamples": 20000,
    "seed": 20260922,
    "familyAlpha": 0.05,
    "correction": "holm",
    "sided": "one"
  },
  "inSampleGates": {
    "minTrades": 2000,
    "minPositiveYears": 5,
    "years": 8,
    "leaveOneYearOutPositive": true,
    "excludedRegimeYears": [2020, 2021],
    "excludedRegimeMeanPositive": true
  },
  "holdoutGates": {
    "meanPositive": true,
    "notWorseZ": 1.96
  },
  "live": {
    "microShares": 1,
    "minClosedTrades": 100,
    "minStopEntryFills": 100,
    "costUpperBound": 0.95,
    "consistencyZ": 2.33,
    "consistencyMinTradesForStop": 300,
    "drawdownPromoteMultiple": 1.5,
    "tranches": ["micro", 0.25, 0.5, 1.0],
    "aggressivePosture": { "riskPerTrade": 0.015, "maxPositionPct": 0.25, "maxConcurrent": 4, "dailyLossLimit": 0.05 }
  },
  "killBands": {
    "trailingTrades": 100,
    "demoteExpectancyZ": 3,
    "haltExpectancyZ": 4,
    "demoteCostFractionOfMean": 0.5,
    "haltCostLowerBound": 0.95,
    "demoteDrawdownMultiple": 1.5,
    "haltDrawdownMultiple": 2.0,
    "statisticalHaltsToStop": 2,
    "haltWindowMonths": 12
  }
}
```

## 12. Amendments

Before the first L.2 run, this file may change only through a dated amendment appended below, in its
own commit, with the reason. After any L.2 result exists, a change cannot alter a verdict. It can only
start a new, separately registered study. Data fixes that are not informed by results (loading a
missing month, adding a delisted ticker, building the ETF list) are allowed before the first run and
are recorded here.

### Amendment 1 (2026-09-23): 2022-03-08 is not a session

2022-03-08 is removed from the calendar for this study. No signal is taken that day, and every lookback
(prior close, average volume, ATR, the lookback-window rule, and the opening-RVOL baseline) skips it as
if the exchange had been closed. It applies to every symbol, not only the affected ones, so the rule
needs no judgment about which names were hit.

Why: Alpaca's SIP history has no regular-hours bars that day for about 111 symbols, many of them large
NYSE listings (BAC, KO, PFE, RTX, CVS, MET, VALE, EPD). For BAC it returns 125 minute bars, every one
before the open or after the close, and a daily bar of 6.3M shares, which is that extended-hours volume
alone against a usual 40M to 60M. 1,453 other symbols have normal bars that day. Traded, the day's
in-play ranking would be picked from a market missing those names. Kept in the lookbacks, their ATR and
opening-volume baselines would carry a day that did not happen as recorded. Re-fetching cannot fix it:
the store matches what Alpaca serves today.

Found by the coverage check after the minute load finished, before any L.2 run, and not informed by any
result. Section 11 carries it as `samples.excludedSessions`, and its version is now 2.

## 13. Known limitations

- **Survivorship.** A few delisted names are in no Alpaca source (SIVB, FRC, DISCA), and corporate
  actions only go back to about 2019, so some pre-2019 delistings may be missing. Their share of in-play
  names is small but not zero.
- **Dividends are not adjusted.** A large special dividend inside a lookback shifts the ATR and prior
  close slightly.
- **Halted into the close.** The simulated broker exits at the last print before the halt. The real
  position would be stuck until the reopen.
- **Modeled costs.** The spread and slippage allowances are assumptions until live-small measures
  them. Section 10's cost check exists for exactly this.
- **Minute bars.** Fills act on one-minute bars with worst-case ordering. Finer data would be less
  pessimistic on the entry bar and more realistic on fast gaps.
