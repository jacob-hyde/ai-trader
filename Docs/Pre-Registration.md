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
5. **The L.1 blind runs (2026-09-23 and 2026-09-24)**, over the whole in-sample period. Signal-time
   counts only; the numbers are in Amendments 2, 3, and 4.
6. Synthetic data only, everywhere else (goldens, invariants, null model).

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
  "version": 5,
  "registered": "2026-09-22",
  "samples": {
    "inSample": { "from": "2016-01-04", "to": "2023-12-29", "firstTradable": "2016-01-25" },
    "holdout": { "from": "2024-01-02", "to": "2026-08-31" },
    "excludedSessions": ["2022-03-08"],
    "badTicks": { "maxExcursion": 0.2, "maxExcursionRanges": 10, "rangeBars": 30, "maxCutsPerSession": 5 }
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
  "nullModel": {
    "paths": 100000,
    "firstSeed": 1,
    "exits": ["A", "B"],
    "minTrades": 200,
    "grossToleranceR": 0.02,
    "cleanCheckout": true
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
  "asDeployed": {
    "startingCash": 2500,
    "maxGrossExposure": 1,
    "maxOpenRisk": 0.02,
    "flattenOnBreaker": false
  },
  "diagnostics": {
    "costScales": [0.5, 1.5, 2],
    "rvolBuckets": [[1, 5], [6, 10], [11, 20]],
    "breakEvenMaxBps": 1000
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

### Amendment 2 (2026-09-23): the L.1 blind runs, and 66 months of minute bars loaded

Both happened while building L.1 (the backtest runner), before any L.2 run. No threshold changes, so
section 11 stays at version 2.

**What was seen.** The runner was proven on real data blind: it ran the whole mechanics over the
in-sample period, and everything after 09:35 (fills, exits, which entries triggered, R) was computed in
memory and dropped, never stored or shown. What came out is timing and signal-time counts, the kind of
information section 8 used, now for all of 2016 to 2023. From the last blind run, before the ETF list,
long and short together:

| | |
|---|---|
| Sessions | 2,011 |
| Eligible names a session | 827 on average |
| In play a session | 19.9 on average |
| Signals | 39,175 |
| Passed the 0.15R gate, range-low stop | 19,709 (exit A), 19,708 (exit B) |
| Passed, 50% ATR stop | 13,384 (A), 13,369 (B) |
| Passed, 10% ATR stop | 184 (A), 183 (B) |

These pass more often than section 8 because 2016 to 2023 holds far more volatile years than early 2017.
Run over section 8's own window, longs only, the runner gives 9.97 signals a session and gate passes of
35.7% (range low), 9.7% (50% ATR), and 0 of 1,027 (10% ATR), against section 8's 9.8, 36%, 9%, and 1 of
873.

Exit B passes a few fewer than exit A because a short whose 2R target would sit at or below $0 cannot
be expressed as an order. Such a signal, like an ATR stop that would sit below $0 under either exit, is
counted as refused for that variant, not traded. It cannot happen to the confirmatory range-low longs,
whose stop and target are always positive.

**Data fix.** The blind run lists every eligible name it could not rank. 157 symbol-sessions were names
that traded that day with minute bars never loaded, 66 symbol-months in all. 38 of them are February and
March 2022: the loader chose months with a screen that counted 2022-03-08's extended-hours volume in the
average, so names pushed below 1M shares by that one day were skipped, while the study leaves the day out
(Amendment 1). The other 28 are scattered from 2017 to 2023, where the loader's screen and the study's
differ at the margin. All 66 were loaded on 2026-09-23 (356,401 bars). Afterwards the only names left
unrankable are 27 symbol-sessions whose lookback traded nothing in the opening minutes, which have no RVOL
to rank on.

Neither was informed by any result: the blind runs produce none.

### Amendment 3 (2026-09-23): the bad-tick filter

Section 3 requires the H.8 bad-tick filter between the store and the broker. This fixes what it does,
before any L.2 run, since its thresholds decide which prints can fill an entry, a stop, or a target.

**The rule.** Every minute bar is judged before the broker or the engine sees it, on itself and the bars
before it that session only. A high or low that reaches past both the bar's body (its open and close)
and the last close by more than 20%, or by more than 10 times the symbol's average minute range over its
last 30 bars that session if that is further, is a bad print, and is cut back to the body. Open, close,
and volume are never changed, so a gap, a halt reopening, or a squeeze that moves the body passes.

**Corrupted days.** A symbol-session the filter cuts more than 5 times cannot be trusted at all: its good
and bad prints share bars, so its opens and closes are suspect too. It is left out whole, as if the
symbol had not traded that day: no signal, and skipped in every lookback, the way Amendment 1 treats
2022-03-08 but for one name. The rule is applied the same way to both samples, with no hand-made list.

**Why these numbers.** Tuned on the in-sample minute bars of liquid $5 to $100 names, by looking at the
bars alone, never at a trade. At 10% the filter cut 154 bars, and in about a third of them the next bar
traded right back there: real squeezes (AMC in January 2021, SN, SHPH), the very names that rank in
play. At 20% it cuts 10 bars in eight years outside one corrupted day: BBBY's $123.45 prints on a $40
stock, the opening prints of the 2023-01-24 NYSE auction fault (NCLH, NLY, T), and a few one-offs. At
25% the 2023-01-24 prints get through. The corrupted day is JWN on 2018-03-26, which traded at $46.90
and at a phantom $63.60 all day, its daily bar included. It is the only in-sample symbol-session, of any
name, that the filter cuts more than 5 times.

**How it runs.** Finding corrupted days means judging whole sessions, so the whole minute store, both
samples, was scanned once for bars with a wick more than 9% past the body (`pnpm bars suspects`). Only
those symbol-sessions can be cut, so a run counts cuts in them alone to find the corrupted days. The scan
reads bars, never a trade; for the holdout it is the only look at its data, and it is the same rule for
both samples. A month loaded after its scan is refused until it is scanned again.

**What it cannot catch.** A bar that is bad from open to close with no wick past the limit. Nothing
inside the bar disagrees with it, and only the next bar could, which would be look-ahead. Its day is
left out only if the filter cuts it more than 5 times.

A blind in-sample run with the filter on (as Amendment 2's, nothing kept after 09:35) left out that one
symbol-session, and the signal-time counts barely moved: 39,175 signals as before, and range-low gate
passes of 19,708 (A) and 19,707 (B), one fewer each.

Section 11 carries the thresholds as `samples.badTicks`, and its version is now 3.

### Amendment 4 (2026-09-24): the ETF and ETN exclusion list

The list section 3 requires is built and committed as `Docs/ETF-ETN-Exclusions.txt`, dated 2026-09-24,
before any L.2 run. It is never changed after the first one. Its header records the method and every
hand decision; this is the summary.

**What it covers.** Every symbol with minute bars loaded, 6,256 of them, since only those can rank in
play. Names come from Alpaca's asset list, and for a symbol the list no longer carries, from Alpaca's
single-asset lookup, which still knows many delisted products. 293 symbols no source names; reviewed one
by one, seven of them are products (BWV, CETH, FNGB, PHB, SATG, SPLG, XXXX) and the rest are companies,
SPACs, warrants, ADRs, and preferreds.

**The match and the review.** The keywords and issuers match 995 names. Seven are kept in: the issuers'
own stock and banks (AMPY, BCS, CS, DB, IVR, IVZ, WT). Closed-end funds go with the ETFs, since the
keyword "Fund" catches most of them, and the six that carry no keyword (BDJ, BIGZ, BTX, BTZ, CSQ, GDV) are
added. REITs, royalty trusts, bank preferreds, ADRs, and BDCs not named Fund stay in. 1,001 entries in all.

**Reused tickers.** Section 3 speaks of a list of symbols, but the store is ticker-at-time, and 53 tickers
a fund holds today belonged to a company first: FB was Facebook until 2022, LQ La Quinta, NFX Newfield.
Excluding the symbol outright would take those companies out of the study. So an entry can carry a date,
and such a ticker is excluded only from the first session of its fund era. Five tickers were products in
both eras (UGLD, USLV, MLPI, MEME, PCI) and are excluded whole.

**What it changes at signal time.** A blind in-sample run with the list (nothing kept after 09:35):
eligible names fall from 827 to 723 a session, with 39,241 signals and range-low gate passes of 20,802 (A)
and 20,801 (B). Nothing after 09:35 was seen, and the list was built from names alone.
### Amendment 5 (2026-09-24): what "the null model passes" means

Section 3 makes a passing null model on the same commit a precondition for L.2, and section 10 stops the
project when it fails for a reason other than a bug. Neither said what the run is or what passes. This
fixes both before any L.2 run.

**The run.** `pnpm backtest null-model`. The whole decision core (the ORB on its opening range, the
cost-to-risk gate, sizing, the risk rules, the bracket builder, and the trade simulator under the default
cost model) over 100,000 one-session driftless random walks, seeds 1 to 100,000: a volatile $20 name, 70
bps of volatility a minute, a price move every second. It uses the range-low stop, and stops entries 30
minutes and flattens 10 minutes before the close, as section 3 does. It runs once for each confirmatory
exit, A and B, on the same paths. It takes no settings, so every run on a commit is the same run.

**What passes.** For each exit: at least 200 trades, the lower bound of the 95% interval on mean gross R
at or below +0.02R (no established edge on data that cannot have one), and mean gross R above mean net R
(every fill was charged). Both exits must pass. Fewer than 200 trades is not a pass.

**Which commit.** The latest null-model run from a clean checkout of the exact commit that produced the
L.2 result. A run from a checkout with uncommitted changes is kept and counts for nothing, since its
commit does not name the code that ran. `pnpm backtest status` shows the verdict next to every run.

**Why exit B too.** The null model as D.4 built it ran only exit A. A target fills at its limit and a
breakeven stop moves during the trade, so exit B has fill rules that exit A never reaches, and they had
not been checked on random data. Measured while building this, on the definition above: exit A gross
-0.0336R [-0.0672, +0.0001] and net -0.1445R; exit B gross +0.0088R [-0.0060, +0.0236] and net
-0.1004R. Both pass. These are random walks, not study data.

**What it does not cover.** It runs the decision core, not the L.1 runner. The runner is held to the same
trade simulator trade for trade by its parity test, so a leak in the runner's own replay has to get past
that test instead. At 100,000 paths the tripwire sees a leak of about a tenth of an R: the nightly run
proves it catches a trigger decided from the breakout bar's own close. A smaller leak can pass.

Section 11 carries this as `nullModel`, and its version is now 4.

### Amendment 6 (2026-09-24): how the verdict and the diagnostics are computed

Sections 4 to 7 fix what is tested and every threshold. Where their text leaves a choice in how a
number is computed, this fixes it, before any L.2 run, and section 11 now carries the numbers section 7
gave only in prose. No threshold moves.

**Trades.** A trade is a signal whose entry filled and that the cost gate passed. Its value is net R as
the run recorded it, in whole basis points of R, floored (section 5), so every sum is exact. A signal
whose entry never triggered, or that the setup could not express as an order, is not a trade.

**The bootstrap.** The clusters are the sessions with at least one trade of the variant. Each resample
draws that many of them with replacement, all of a drawn session's trades together, and its statistic
is total net R over total trades. The draws come from core's mulberry32 generator seeded with section
11's seed, the same seed for every variant, over the sessions in date order. The one-sided p-value is
the share of resampled means at or below zero. The one-sided 95% lower bound is their 5th percentile by
nearest rank. The day-clustered standard error the holdout's second gate uses is their sample standard
deviation.

**Holm.** The smaller p-value against 0.025, the larger against 0.05, and the larger fails if the
smaller did.

**Years.** The calendar years of the in-sample window, 2016 to 2023. A year without a trade is not a
positive year.

**Top 10 (section 4, step 2).** The whole in-sample test again, both exits and Holm, on the trades
ranked 10 or better. The chosen exit takes top 10 only if it passes every gate there with a higher lower
bound than at top 20. Per signal, a top-10 name's trade is the same trade at top 20, so this reads the
same run.

**Preconditions (section 3), as checked.** No verdict is reported unless all hold:

- The run is the pre-registered in-sample configuration exactly, completed, not blind, from a clean
  checkout at a commit, under this file's text as it stood (the same sha256).
- The null model's latest run from a clean checkout of that commit passed (Amendment 5).
- The ETF and ETN list is part of that commit.
- The bad-tick filter ran, with section 11's settings.
- No eligible name went unranked for want of minute bars. A name whose lookback traded nothing in the
  opening minutes has no RVOL to rank and is not a hole.

**Diagnostics (section 7).** Intervals on diagnostics are the analytic day-clustered 95% intervals, not
the bootstrap, which decides the verdict alone.

- H3: each exit's range-low longs, those the gate passed against those it rejected, which were simulated
  the same way.
- H4: the 10% ATR stop's longs, every signal whether the gate passed it or not.
- 50% ATR: its longs the gate passed.
- H5: the confirmatory trades by rank, in section 11's buckets (1 to 5, 6 to 10, 11 to 20).
- Shorts: the range-low shorts the gate passed, both exits.
- Cost sensitivity: each trade's two fills priced again from the prices they acted at, with every fill
  kind's per-share slippage times 0.5, 1.5, and 2, rounded up to $0.0001 against the fill, the spread
  unchanged. The trades stay the same: the gate is not run again, since the question is how much of the
  result survives dearer fills. At 1x this must reproduce every recorded fill to the unit, or no cost
  figure is reported.
- Break-even B: the stop-entry allowance, in basis points of the price it fills against and with no
  tick floor, at which mean net R on the same trades is zero, found by bisection to 0.01 bps between 0
  and section 11's ceiling (1,000 bps). It is reported beside the modeled allowance's average in basis
  points; the difference is the margin. None if the mean is at or below zero with a free stop entry.
- As deployed: the frozen configuration through one account on section 11's `asDeployed` settings and
  the aggressive posture in `live.aggressivePosture`. A skipped signal is one refused at sizing or by
  the risk rules.

**The holdout addendum.** Its JSON block holds `frozenConfiguration`, the exact holdout run, and
`inSample`: the in-sample run's id and commit, the chosen exit and top N, the trade count, and the net
mean R. The holdout's second gate reads the in-sample mean from there.

Section 11 is now version 5, with `asDeployed` and `diagnostics`.

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

## 14. Result

This section records outcomes. It changes nothing above.

### In-sample (2026-09-24): NO EDGE

Run 2cc91018-ca88-42f9-b7fb-801cef276473, the pre-registered in-sample run, on commit
8e7d64a15d9ded07a6533911f56255f1831cbf89 under this file at version 5 (sha256
a8a7b18045e12bd45f2434e6597238f4d76952c3e82b34b2b26dee24b3dcd6fd), data snapshot a6217f3a137037f2.
Every section 3 precondition held as Amendment 6 checks them: the null model passed on that commit, the
ETF list was in it, the bad-tick filter ran, and no eligible name went unranked for want of minute bars.

Neither confirmatory exit passes section 6:

| Gate | A (EOD) | B (2R, breakeven at 1R) |
|---|---|---|
| Trades | 8,003 | 8,003 |
| Net mean R | -0.0432R | -0.0323R |
| One-sided 95% lower bound | -0.0668R | -0.0524R |
| Bootstrap p-value, Holm threshold | 0.9974, 0.05 | 0.9948, 0.025 |
| Years positive | 0 of 8 | 0 of 8 |
| Without 2020 and 2021 | -0.0365R | -0.0356R |

| Year | A net mean R | B net mean R | Trades |
|---|---|---|---|
| 2016 | -0.0120R | -0.0122R | 725 |
| 2017 | -0.0537R | -0.0388R | 698 |
| 2018 | -0.0317R | -0.0320R | 892 |
| 2019 | -0.0406R | -0.0362R | 860 |
| 2020 | -0.0510R | -0.0406R | 1,234 |
| 2021 | -0.0643R | -0.0100R | 1,284 |
| 2022 | -0.0302R | -0.0347R | 1,213 |
| 2023 | -0.0494R | -0.0523R | 1,097 |

The top 10 alone fails too: -0.0293R (A) and -0.0212R (B) over 4,503 trades each.

**Outcome: NO EDGE.** Section 10, rule 1: the project stops. No capital beyond the micro regime and no
further build-out of this strategy. Nothing is frozen, and the holdout, 2024-01-02 to 2026-08-31, is not
run and stays unseen. Any new setup or variant is a new study with its own pre-registration, and 2016 to
2023 is no longer out of sample for it.

**What section 7 adds.** None of it is a verdict.

- Before costs both exits are slightly positive, +0.0344R (A) and +0.0467R (B). The modeled costs take
  about 0.08R a trade.
- With every slippage allowance halved both are still negative, -0.0187R and -0.0070R, and neither
  reaches zero with a free stop entry.
- The gate works: the range-low longs it rejected lost -0.2456R (A) and -0.2694R (B).
- The published 10% ATR stop, gate off, lost -1.2109R (A) and -1.2484R (B). The gate passed 75 of its
  19,757 long signals.
- The 50% ATR stop lost -0.0539R (A) and -0.0430R (B).
- By RVOL rank, 1 to 5, 6 to 10, 11 to 20: -0.0155R, -0.0453R, -0.0611R (A) and -0.0101R, -0.0341R,
  -0.0465R (B). Ordered as H5 expects, all below zero.
- The shorts lost -0.0181R (A) and -0.0139R (B).

The full report and the run's metrics are kept with the run (backtest_reports, kinds "verdict" and
"metrics").
