-- Up Migration
-- Round 2 study runs (Docs/Pre-Registration-Round-2.md): one row per run of a registered study, with the
-- code, the registration text, and the report; and one row per trade the run priced. A study run is not
-- a backtest run: it prices its own trades from the market and keeps no fills.
CREATE TABLE study_runs (
  id uuid PRIMARY KEY,
  study text NOT NULL,
  sample text NOT NULL CHECK (sample IN ('inSample', 'holdout')),
  git_commit text,
  git_dirty boolean NOT NULL,
  -- Of the round's pre-registration file, as it stood when the run began.
  registration_sha256 text NOT NULL,
  spec jsonb NOT NULL,
  report jsonb,
  text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE study_trades (
  run_id uuid NOT NULL REFERENCES study_runs (id) ON DELETE CASCADE,
  symbol text NOT NULL,
  session date NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long', 'short')),
  -- The signal, e.g. the gap at 09:25 as a fraction of the prior close.
  signal double precision NOT NULL,
  entry bigint,
  exit bigint,
  -- Net return in millionths of the entry. Null when a price could not be found.
  net integer,
  PRIMARY KEY (run_id, session, symbol)
);

-- Down Migration
DROP TABLE IF EXISTS study_trades;
DROP TABLE IF EXISTS study_runs;
