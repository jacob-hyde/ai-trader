-- Up Migration
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Down Migration
-- The extension stays installed. Dropping it would take every hypertable with it.
SELECT 1;
