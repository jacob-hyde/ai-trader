-- Up Migration
-- The engine connects as trader_engine and can only read and write rows. Schema changes come from the
-- migration owner (MIGRATION_DATABASE_URL). The dev password is the role name; production rotates it
-- with ALTER ROLE from a Docker secret at provisioning (infra/linode-runbook.md).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trader_engine') THEN
    CREATE ROLE trader_engine LOGIN PASSWORD 'trader_engine';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO trader_engine', current_database());
END $$;

GRANT USAGE ON SCHEMA public TO trader_engine;
REVOKE CREATE ON SCHEMA public FROM trader_engine;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO trader_engine;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO trader_engine;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO trader_engine;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO trader_engine;
-- The migration ledger is the owner's business.
REVOKE ALL ON TABLE pgmigrations FROM trader_engine;

-- Down Migration
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM trader_engine;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM trader_engine;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM trader_engine;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM trader_engine;
REVOKE ALL ON SCHEMA public FROM trader_engine;
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM trader_engine', current_database());
END $$;
DROP ROLE IF EXISTS trader_engine;
