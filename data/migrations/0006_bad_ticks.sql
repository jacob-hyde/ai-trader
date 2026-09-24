-- Up Migration
-- The bad-tick filter (H.8).
--
-- A scan of the minute store keeps every symbol-session with a bar whose high or low reaches more than 9%
-- past its body. Any filter limit of 10% or more can only cut inside these, so a backtest runs the exact
-- filter over these sessions alone to find the corrupted ones (more cuts than a session can have and
-- still be trusted), instead of over 1.2 billion bars. bad_tick_scans says which months were scanned and
-- when: a month loaded after its scan must be scanned again, and a backtest refuses it until it is.
CREATE TABLE bad_tick_scans (
  month date PRIMARY KEY CHECK (extract(day FROM month) = 1),
  scanned_at timestamptz NOT NULL
);

CREATE TABLE bad_tick_candidates (
  symbol text NOT NULL,
  session date NOT NULL,
  -- Bars that session with a high or low more than 9% past the body.
  wide_bars integer NOT NULL CHECK (wide_bars > 0),
  PRIMARY KEY (symbol, session)
);
CREATE INDEX bad_tick_candidates_session ON bad_tick_candidates (session);

-- What the filter did in a backtest session: the highs and lows it cut before the broker saw them, as
-- [{"symbol", "minute", "side", "reported", "kept", "limit"}] in $0.0001 units, null for a blind run since
-- those bars run past 09:35; and the symbols left out that session as corrupted.
ALTER TABLE backtest_sessions ADD COLUMN bad_ticks jsonb;
ALTER TABLE backtest_sessions ADD COLUMN corrupt_symbols jsonb NOT NULL DEFAULT '[]';

-- Down Migration
ALTER TABLE backtest_sessions DROP COLUMN IF EXISTS corrupt_symbols;
ALTER TABLE backtest_sessions DROP COLUMN IF EXISTS bad_ticks;
DROP TABLE IF EXISTS bad_tick_candidates;
DROP TABLE IF EXISTS bad_tick_scans;
