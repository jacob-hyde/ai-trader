-- Up Migration
-- Turns an existing table into a hypertable with the project defaults for 1-minute bars: 7-day chunks,
-- compression after 30 days segmented by symbol and ordered by time descending. Safe to call again on
-- a table it already converted, as long as no chunk has been compressed yet.
CREATE OR REPLACE FUNCTION trader_make_hypertable(
  tbl regclass,
  time_col name DEFAULT 'ts',
  segment_col name DEFAULT 'symbol',
  chunk_interval interval DEFAULT interval '7 days',
  compress_after interval DEFAULT interval '30 days'
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM create_hypertable(tbl, time_col, chunk_time_interval => chunk_interval, if_not_exists => true);

  IF NOT EXISTS (
    SELECT 1
    FROM timescaledb_information.hypertables h
    WHERE format('%I.%I', h.hypertable_schema, h.hypertable_name)::regclass = tbl
      AND h.compression_enabled
  ) THEN
    EXECUTE format(
      'ALTER TABLE %s SET (timescaledb.compress, timescaledb.compress_segmentby = %L, timescaledb.compress_orderby = %L)',
      tbl,
      segment_col::text,
      time_col::text || ' DESC'
    );
  END IF;

  PERFORM add_compression_policy(tbl, compress_after, if_not_exists => true);
END
$$;

-- Down Migration
DROP FUNCTION IF EXISTS trader_make_hypertable(regclass, name, name, interval, interval);
