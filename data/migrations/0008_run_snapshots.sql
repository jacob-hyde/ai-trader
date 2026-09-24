-- Up Migration
-- Reproducibility (L.5): the data a run read, recorded when a worker takes it, beside its commit. The id
-- hashes the facts (checkpoints, rows, last loads, the bad-tick scan, the calendar), so two runs with the
-- same configuration, commit, and id read the same store and must give the same result.
ALTER TABLE backtest_runs ADD COLUMN data_snapshot jsonb;

-- Down Migration
ALTER TABLE backtest_runs DROP COLUMN IF EXISTS data_snapshot;
