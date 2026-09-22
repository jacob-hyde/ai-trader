-- Up Migration
-- The historical bar store (H.7): the exchange calendar, what Alpaca says about assets, every ticker we
-- know of, daily and minute bars, and the load's checkpoints.
--
-- Bars are ticker-at-time. A row for (FB, 2021-06-01) is whatever traded as FB that day, pulled with
-- Alpaca's symbol mapping off. A backtest that asks "what was in play on this date" must see the
-- tickers of that date, not today's: META in 2021 was an ETF, and BBBY has been two companies.
--
-- Prices are as traded, never adjusted for later splits, and in integer units of $0.0001 (Fixed). An
-- adjusted history rewrites the past: NVDA traded at $516.71 on 2021-01-27 and reads $12.85 adjusted,
-- which would put it inside the $5 to $100 screen, shrink its ATR under $0.50, and make a one-cent
-- spread a quarter of a cent. Each daily bar carries its split factor instead, so a lookback that spans
-- a split can be put on one footing as of any date without looking ahead.

-- Regular sessions, from Alpaca's calendar. Half days close early. The bar store's clock.
CREATE TABLE market_sessions (
  session date PRIMARY KEY,
  open_at timestamptz NOT NULL,
  close_at timestamptz NOT NULL,
  CHECK (close_at > open_at)
);

-- Alpaca's asset list as of one pull. Append-only: each pull adds a snapshot, so what Alpaca said about
-- a symbol on a given day stays answerable. It is not complete for delisted names (see symbols).
CREATE TABLE asset_snapshots (
  taken_at timestamptz NOT NULL,
  asset_id uuid NOT NULL,
  symbol text NOT NULL,
  name text NOT NULL,
  exchange text NOT NULL,
  asset_class text NOT NULL,
  status text NOT NULL,
  tradable boolean NOT NULL,
  shortable boolean NOT NULL,
  easy_to_borrow boolean NOT NULL,
  PRIMARY KEY (taken_at, asset_id)
);
CREATE INDEX asset_snapshots_symbol ON asset_snapshots (symbol, taken_at DESC);

-- Every ticker the load knows about and where it heard of it: the asset list (active or inactive), a
-- merger's acquiree, either side of a name change, or a file. Alpaca's asset list alone misses many
-- delisted names (TWTR, SIVB, BBBY), which is exactly the survivorship hole this table exists to close.
-- first_session and last_session are the first and last daily bars seen: listing and delisting as
-- observed, since no source here gives the real dates.
CREATE TABLE symbols (
  symbol text PRIMARY KEY,
  sources text[] NOT NULL,
  first_session date,
  last_session date,
  added_at timestamptz NOT NULL DEFAULT now()
);

-- split_factor is shares today per share on this date: 40 for NVDA in 2021, after its 4:1 and 10:1.
-- As of date D, an earlier bar t's price is price(t) * split_factor(D) / split_factor(t), and its volume
-- is volume(t) * split_factor(t) / split_factor(D). Dividends are not adjusted. Null when the day had no
-- volume to take the ratio from.
CREATE TABLE bars_1d (
  symbol text NOT NULL,
  session date NOT NULL,
  open bigint NOT NULL,
  high bigint NOT NULL,
  low bigint NOT NULL,
  close bigint NOT NULL,
  volume bigint NOT NULL,
  trades integer,
  vwap bigint,
  split_factor double precision CHECK (split_factor > 0),
  PRIMARY KEY (symbol, session)
);
SELECT trader_make_hypertable('bars_1d', 'session', 'symbol', interval '365 days', interval '30 days');

-- Regular-hours minute bars only, as traded. minute counts from the session's open, so 09:30 ET is 0,
-- and the session and minute are assigned here once, from the calendar, rather than by every reader.
-- A lookback across a split (the opening-volume average behind RVOL) takes its factor from bars_1d.
CREATE TABLE bars_1m (
  symbol text NOT NULL,
  ts timestamptz NOT NULL,
  session date NOT NULL,
  minute smallint NOT NULL CHECK (minute >= 0 AND minute < 390),
  open bigint NOT NULL,
  high bigint NOT NULL,
  low bigint NOT NULL,
  close bigint NOT NULL,
  volume bigint NOT NULL,
  trades integer,
  vwap bigint,
  PRIMARY KEY (symbol, ts)
);
SELECT trader_make_hypertable('bars_1m');

-- One row per timeframe, symbol, and month the load has finished. "complete" months are never fetched
-- again. A month still in progress is "partial" and is fetched again on the next run. rows and sessions
-- are what arrived; the verify report compares sessions against the calendar.
CREATE TABLE bar_load_checkpoints (
  timeframe text NOT NULL CHECK (timeframe IN ('1Day', '1Min')),
  symbol text NOT NULL,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  status text NOT NULL CHECK (status IN ('complete', 'partial')),
  rows integer NOT NULL,
  sessions integer NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (timeframe, symbol, month)
);

-- Down Migration
DROP TABLE IF EXISTS bar_load_checkpoints;
DROP TABLE IF EXISTS bars_1m;
DROP TABLE IF EXISTS bars_1d;
DROP TABLE IF EXISTS symbols;
DROP TABLE IF EXISTS asset_snapshots;
DROP TABLE IF EXISTS market_sessions;
