-- Up Migration
-- Null-model runs (L.3): the tripwire (D.4) over driftless walks, once for each confirmatory exit, and
-- the commit it ran on. An L.2 number is read only when the latest run on the same commit, from a clean
-- checkout, passed (pre-registration section 3). A run from a dirty checkout is kept but never counts:
-- its commit does not name the code that ran.
CREATE TABLE null_model_runs (
  id uuid PRIMARY KEY,
  git_commit text,
  git_dirty boolean NOT NULL,
  -- Over every exit: fail if any failed, else insufficient if any was, else pass.
  verdict text NOT NULL CHECK (verdict IN ('pass', 'fail', 'insufficient')),
  -- Paths per exit, the same paths for each.
  paths integer NOT NULL,
  -- Per exit id, the tripwire's report: counts, gross and net intervals in R, drag, tolerance, reasons.
  reports jsonb NOT NULL,
  elapsed_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX null_model_runs_commit ON null_model_runs (git_commit, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS null_model_runs;
