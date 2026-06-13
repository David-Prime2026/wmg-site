-- Wave 1: Foundation — _migrations ledger, schemas, extensions

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS private;

COMMENT ON SCHEMA app IS 'Core WMG OS application data';
COMMENT ON SCHEMA private IS 'Internal logic, triggers, and security definer functions';

-- Updated-at trigger helper (private schema — not exposed via Data API)
CREATE OR REPLACE FUNCTION private.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Application migration ledger (separate from supabase_migrations.schema_migrations)
CREATE TABLE IF NOT EXISTS app._migrations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL UNIQUE,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app._migrations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app'
      AND tablename = '_migrations'
      AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app._migrations
      FOR ALL TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

DROP TRIGGER IF EXISTS set_updated_at ON app._migrations;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app._migrations
  FOR EACH ROW
  EXECUTE FUNCTION private.set_updated_at();

-- Schema privileges for Supabase Data API roles
GRANT USAGE ON SCHEMA app TO postgres, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA private TO postgres, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT ALL ON TABLES TO postgres, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA app TO service_role;

INSERT INTO app._migrations (name)
VALUES ('001_foundation')
ON CONFLICT (name) DO NOTHING;
