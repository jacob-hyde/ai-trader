-- Up Migration
-- Backtest runs (L.1): one row per run, and under it what the run produced. Every price is a whole
-- number of $0.0001 units, as in the bar store, and every R is whole basis points of R (-10000 is a full
-- 1R loss), floored the way the trade simulator floors it.
--
-- A blind run keeps its row and its sessions, which hold only what was known by 09:35 (the screen,
-- the ranking, the signals, the cost gate). It never writes a trade or a fill.

CREATE TABLE backtest_runs (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  blind boolean NOT NULL,
  -- The run's configuration after parsing, defaults filled in. What the worker executed.
  config jsonb NOT NULL,
  -- Set when a worker takes the run: the code and the registration it ran under.
  git_commit text,
  git_dirty boolean,
  registration_version integer,
  registration_sha256 text,
  progress jsonb,
  summary jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX backtest_runs_created ON backtest_runs (created_at DESC);

-- One row per session replayed. Signal-time counts only, so a blind run writes them too.
CREATE TABLE backtest_sessions (
  run_id uuid NOT NULL REFERENCES backtest_runs (id) ON DELETE CASCADE,
  session date NOT NULL,
  -- Passed the price, volume, ATR, and lookback screen.
  eligible integer NOT NULL,
  -- Eligible with opening RVOL above the minimum.
  qualified integer NOT NULL,
  in_play integer NOT NULL,
  -- Eligible but without minute bars to rank on, e.g. a month never loaded.
  unrankable integer NOT NULL,
  -- Which ones, as [{"symbol", "reason"}]: minutesNotLoaded or baselineEmpty.
  unrankable_symbols jsonb NOT NULL,
  -- In-play names whose opening range gave a signal.
  signals integer NOT NULL,
  -- Per variant: signals the cost gate passed, and signals refused before an order.
  by_variant jsonb NOT NULL,
  PRIMARY KEY (run_id, session)
);

-- One row per signal per variant: every signal, whether or not it filled, so the gate's rejects and the
-- entries that never triggered are measured too.
CREATE TABLE backtest_trades (
  run_id uuid NOT NULL REFERENCES backtest_runs (id) ON DELETE CASCADE,
  variant text NOT NULL,
  symbol text NOT NULL,
  session date NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long', 'short')),
  rank smallint NOT NULL,
  opening_rvol integer NOT NULL,
  daily_atr bigint NOT NULL,
  prior_close bigint NOT NULL,
  signal_minute smallint NOT NULL,
  entry bigint NOT NULL,
  -- Null only when the setup could not state a plan, e.g. a short's 2R target at or below $0.
  stop bigint,
  target bigint,
  cost_per_share bigint,
  cost_to_risk integer,
  gate_passed boolean NOT NULL,
  -- Why no order went in: "stage: reasons". Null when one did.
  refusal text,
  shares integer NOT NULL,
  entry_outcome text NOT NULL CHECK (entry_outcome IN ('refused', 'filled', 'canceled', 'expired')),
  entry_minute smallint,
  entry_reference bigint,
  entry_fill bigint,
  exit_minute smallint,
  exit_reason text CHECK (exit_reason IN ('stop', 'breakevenStop', 'target', 'flatten', 'close')),
  exit_reference bigint,
  exit_fill bigint,
  gross_pnl bigint,
  net_pnl bigint,
  gross_r integer,
  net_r integer,
  PRIMARY KEY (run_id, variant, symbol, session)
);

-- Every fill the simulated broker made, with the price it acted at before costs.
CREATE TABLE backtest_fills (
  run_id uuid NOT NULL REFERENCES backtest_runs (id) ON DELETE CASCADE,
  fill_id text NOT NULL,
  order_id text NOT NULL,
  client_order_id text NOT NULL,
  leg text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity integer NOT NULL,
  price bigint NOT NULL,
  reference bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('market', 'stopEntry', 'stopExit')),
  fees bigint NOT NULL,
  at timestamptz NOT NULL,
  PRIMARY KEY (run_id, fill_id)
);

-- Down Migration
DROP TABLE IF EXISTS backtest_fills;
DROP TABLE IF EXISTS backtest_trades;
DROP TABLE IF EXISTS backtest_sessions;
DROP TABLE IF EXISTS backtest_runs;
