# Pre-Registration, Round 2: five strategies on the same data

Written 2026-09-24, after the ORB study (`Docs/Pre-Registration.md`) ended NO EDGE and before any result
of the strategies below exists. The commit that adds a study's section is its timestamp. Nothing in a
study's section moves after its first run.

## 1. Why a round, and the ledger

One data set can test several strategies. What it cannot do is test them without counting: with enough
unrelated ideas that have no edge, one passes a 5% bar by luck. So every strategy tested on this store is
written down here before it runs, a round fixes in advance how many it may test, and the bar each one
must clear is the round's 5% shared out over its studies.

| Study | Strategy | Registered | Outcome |
|---|---|---|---|
| 1 | Opening range breakout on stocks in play | 2026-09-22 | NO EDGE, 2026-09-24 |
| 2.1 | No-news overnight gap fade, auction to auction | 2026-09-24, section 5 | |
| 2.2 | LLM-scored overnight news, short, auction to auction | section 6 | |
| 2.3 | LLM-scored intraday news, entered 15 minutes after release | section 6 | |
| 2.4 | End-of-day reversal with a resting limit entry | section 6 | |
| 2.5 | ORB with a resting limit entry on the retest | section 6 | |

A study not written down before its run does not count, whatever it shows. Changing a study after its
first run makes it a new study, in the next round.

## 2. What was seen before this was written

- Everything in `Docs/Pre-Registration.md`, including its section 14: the ORB in-sample run, 2016 to
  2023, every year negative on both exits.
- The cost check on that run (2026-09-24): 800 of its trades priced from SIP trades and quotes cost
  about 0.050R each against the 0.078R the model charged. Quoted spreads at the entries had a median of
  22 bps. This is why every fill in this round is priced from the market (section 4).
- A literature survey of intraday strategies with net-of-cost evidence (2026-09-24). Its candidates are
  studies 2.1 to 2.4. It reported published results, never ours.
- Three data probes on 2019-05-14, prices only: opening and closing auction prints carry the "O" and "6"
  conditions in SIP trades; SIP has pre-market bars; Alpaca's news feed held about 340 articles
  published between that day's prior close and 09:25.
- Nothing about any round 2 strategy's returns, on any data.

## 3. How every study is judged

**In-sample, 2016-01-04 to 2023-12-29.** The store is used as the ORB registration left it: 2022-03-08
is not a session (its Amendment 1), the ETF and ETN list is excluded (Amendment 4), and a corrupted
symbol-session is left out whole (Amendment 3). A study passes only if all hold:

| Gate | Threshold |
|---|---|
| Trades | at least the study's own minimum, fixed in its section |
| Net expectancy | day-clustered bootstrap one-sided p-value below 0.01; Holm at 0.01 over a study's arms if it has more than one |
| Years positive | net mean above 0 in at least 5 of the 8 calendar years |
| No year carries it | dropping any single year, the rest is still above 0 |
| Not a 2020 to 2021 edge | 2016 to 2019 and 2022 to 2023 together above 0 |

The bootstrap and every other computation are the ORB registration's as its Amendment 6 fixes them:
20,000 resamples of the sessions with a trade, seed 20260922, nearest-rank bounds. A study under its
trade minimum is INSUFFICIENT, which is a failure. The unit is the study's own, fixed in its section:
net R where a trade has a stop, net return in basis points of the entry where it does not.

**Holdout, 2024-01-02 to 2026-08-31.** Untouched by every study until one passes in-sample. A passing
study's configuration is frozen by its section's rule and committed, with its in-sample numbers, before
its holdout runs, once. It passes if its holdout net mean is above 0 and its in-sample net mean is at
most the holdout mean plus 1.96 day-clustered standard errors.

**Outcomes.** EDGE for a study that passes both. The round ends when all five are judged. NO EDGE for the
round if none is EDGE; anything after that is round 3, registered the same way.

## 4. Prices

No assumed spread or slippage. Every fill is priced from the market's own SIP trades and quotes, one
share at a time, ticker at time:

- **Auction orders** (on the open, on the close) fill at the auction's official print: the largest
  print carrying the opening condition ("O", or "Q" where only that is reported) in the first 15 minutes
  of the session, and the largest print carrying the closing condition ("6", or "M") in the 5 minutes
  after the close. A symbol-session with no such print is not traded and is counted.
- **Stop orders** fill at the touch 250 ms after the first print through the level that can set the last
  sale, as the cost check prices them (`apps/backtest/src/fills.ts`).
- **Market orders** fill at the touch 250 ms after they are sent.
- **Limit orders** fill at the limit, and only when a print trades strictly through it. A touch is not a
  fill.
- **Fees:** every sale, long or short, pays 0.5 bps, above the SEC and FINRA fees of 2016 to 2023. No
  commission.

A study with more than 2% of its trades impossible to price reports no verdict.

**Shorts.** Whether a name was easy to borrow on a past day is not recorded anywhere we can read, so a
short is taken to have been borrowable when the name passes its study's price and volume screen, with no
borrow fee. A name under the short-sale price test that day (its prior session's low at least 10% under
the close before it) is not shorted. Both are limitations, reported with every short study.

## 5. Study 2.1: no-news overnight gap fade

Registered 2026-09-24, after the signal-time feasibility check in section 5.1 and before any of its
returns.

**Hypothesis.** A liquid stock that gaps up overnight with no news gives back part of the gap between the
opening and closing auctions. Attention inflates its opening price (Berkman, Koch, Tuttle and Zhang,
2012), and a price move without information reverses where one with information drifts (Savor, 2012).
Shorted on the opening auction and covered on the closing auction, it earns a positive mean net of costs.

**Universe, per session D.** Judged before D's open, on the ORB study's screen with its own numbers:
prior close $10 to $100, mean daily volume above 1,000,000 shares over the prior 14 sessions, those 14
inside the last 20 sessions of the calendar, not on the ETF and ETN list, not a corrupted symbol-session.

**Signal at 09:25.** The gap is the last pre-market trade by 09:25 (the close of the last SIP 5-minute
bar that ended by then) over the prior close, restated for a split, less one. A name qualifies when its
gap is at least 3%, no article in Alpaca's news feed names it between the prior session's close and
09:25, and it is not under the short-sale price test. Qualifying names rank by gap, largest first, ties
by symbol, and the top 3 are traded.

**Trade.** Short one share on the opening auction and cover on the closing auction, both at the official
prints (section 4). No stop and no target: the design holds to the close, as the published results do.
A name with no opening print is not traded. One with an opening print and no closing print is unpriced.

**Measure.** Net return in basis points of the entry: the opening print less the closing print, over the
opening print, less the 0.5 bps fee on the sale.

**Verdict.** Section 3's gates with a minimum of 2,000 trades, one arm at p below 0.01.

**Frozen configuration.** Nothing is chosen in-sample. The holdout runs this exact design on its own
sessions.

**Diagnostics.** Priced from each day's own bar (its open and close as traded), not the auction prints,
and gating nothing: the same short on gap-ups that had news, the long on quiet gap-downs, the confirmatory
trades by gap size (under 5%, 5 to 10%, over 10%), and the count of names left out under the short-sale
price test.

**Limitations.** Borrow and the price test are section 4's assumptions. Pre-market trading is thin, so a
gap can rest on a few prints. No article in Alpaca's feed is not the same as no news. One share a trade.

### 5.1 Signal-time feasibility

Read before this section was written: for every in-sample session, the eligible names, their last
pre-market trade by 09:25, and the overnight articles naming each name that moved 2% or more either way.
Nothing after 09:25. Per session, quiet meaning no article in the overnight window:

| Year | Sessions | Eligible | Quiet gap-ups: 2%+ | 3%+ | 5%+ | Sessions with a quiet 3%+ gap-up |
|---|---|---|---|---|---|---|
| 2016 | 238 | 724.5 | 11.4 | 4.7 | 1.3 | 196 |
| 2017 | 251 | 736.2 | 7.3 | 2.5 | 0.5 | 208 |
| 2018 | 251 | 802.3 | 14.3 | 5.4 | 1.1 | 230 |
| 2019 | 252 | 778.7 | 11.0 | 3.6 | 0.8 | 214 |
| 2020 | 253 | 847.1 | 62.4 | 34.5 | 12.8 | 244 |
| 2021 | 252 | 918.2 | 39.5 | 16.7 | 4.1 | 248 |
| 2022 | 250 | 879.3 | 41.3 | 18.8 | 4.2 | 239 |
| 2023 | 250 | 798.6 | 23.3 | 9.3 | 1.7 | 241 |

Trades each setting would take, before the short-sale price test removes any:

| Year | 2%, top 3 | 3%, top 3 | 3%, top 5 | 5%, top 3 | 5%, top 5 |
|---|---|---|---|---|---|
| 2016 | 638 | 450 | 593 | 164 | 201 |
| 2017 | 706 | 445 | 533 | 113 | 114 |
| 2018 | 709 | 566 | 774 | 213 | 236 |
| 2019 | 705 | 487 | 617 | 161 | 178 |
| 2020 | 735 | 689 | 1,071 | 453 | 605 |
| 2021 | 742 | 703 | 1,083 | 418 | 542 |
| 2022 | 739 | 674 | 1,021 | 356 | 460 |
| 2023 | 740 | 664 | 981 | 269 | 313 |
| All | 5,714 | 4,678 | 6,673 | 2,147 | 2,649 |

3% and the top 3 give every year at least 445 trades, so the year gates judge a real sample in each year
and no year dominates the count. 5% leaves 2017 with 113. The minimum of 2,000 sits well under the
expected count; it catches a data failure, not a design choice. At about 4,600 trades with a per-trade
standard deviation of 300 to 400 bps, the test has about 80% power for a true net edge of 15 to 20 bps,
less once trades on the same day move together.

```json
{
  "study": "2.1",
  "registered": "2026-09-24",
  "universe": {
    "priceMin": 10,
    "priceMax": 100,
    "minAverageVolume": 1000000,
    "lookbackSessions": 14,
    "lookbackWindowSessions": 20
  },
  "minGap": 0.03,
  "maxArticles": 0,
  "topN": 3,
  "minTrades": 2000
}
```

## 6. Studies 2.2 to 2.5

Each is written here, in full, before its first run.

## 7. Thresholds (machine-readable)

```json
{
  "round": 2,
  "registered": "2026-09-24",
  "studies": ["2.1", "2.2", "2.3", "2.4", "2.5"],
  "familyAlpha": 0.05,
  "studyAlpha": 0.01,
  "samples": {
    "inSample": { "from": "2016-01-04", "to": "2023-12-29" },
    "holdout": { "from": "2024-01-02", "to": "2026-08-31" },
    "excludedSessions": ["2022-03-08"]
  },
  "statistics": { "method": "dayClusteredBootstrap", "resamples": 20000, "seed": 20260922, "sided": "one" },
  "inSampleGates": {
    "minPositiveYears": 5,
    "years": 8,
    "leaveOneYearOutPositive": true,
    "excludedRegimeYears": [2020, 2021],
    "excludedRegimeMeanPositive": true
  },
  "holdoutGates": { "meanPositive": true, "notWorseZ": 1.96 },
  "prices": {
    "latencyMs": 250,
    "openingAuctionWindowMinutes": 15,
    "closingAuctionWindowMinutes": 5,
    "saleFeeBps": 0.5,
    "maxUnpricedShare": 0.02
  },
  "shorts": { "shortSaleTestDrop": 0.1, "borrowFee": 0 }
}
```
