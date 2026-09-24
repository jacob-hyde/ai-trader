-- Up Migration
-- Reports on a run (L.4, L.2): what was computed from its persisted trades, as JSON for code and as text
-- for a reader, with the commit of the code that computed it. One of each kind a run; computing it again
-- replaces it, and the commit says which code wrote the one kept.
CREATE TABLE backtest_reports (
  run_id uuid NOT NULL REFERENCES backtest_runs (id) ON DELETE CASCADE,
  -- "metrics" (L.4), "verdict" (L.2).
  kind text NOT NULL,
  content jsonb NOT NULL,
  text text NOT NULL,
  git_commit text,
  git_dirty boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, kind)
);

-- Down Migration
DROP TABLE IF EXISTS backtest_reports;
