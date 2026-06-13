-- Wave 17: Staging schema for quarantined Drive imports (not exposed via Data API)

CREATE SCHEMA IF NOT EXISTS staging;

COMMENT ON SCHEMA staging IS
  'Quarantined Drive import catalog and raw records before promotion to app. '
  'Do NOT add staging to Supabase API exposed schemas — access via service role only.';

-- ---------------------------------------------------------------------------
-- staging.drive_files — catalog of every file found in Drive
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staging.drive_files (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  drive_file_id       text        NOT NULL UNIQUE,
  file_name           text        NOT NULL,
  mime_type           text,
  folder_path         text,
  parent_folder_name  text,
  size_bytes          bigint,
  modified_time       timestamptz,
  survey_status       text        NOT NULL DEFAULT 'cataloged' CHECK (
    survey_status IN ('cataloged', 'sampled', 'imported', 'skipped', 'error')
  ),
  sample_content      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS drive_files_drive_file_id_idx ON staging.drive_files (drive_file_id);
CREATE INDEX IF NOT EXISTS drive_files_survey_status_idx ON staging.drive_files (survey_status);
CREATE INDEX IF NOT EXISTS drive_files_folder_path_idx ON staging.drive_files (folder_path);

-- ---------------------------------------------------------------------------
-- staging.import_runs — track each import batch
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staging.import_runs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type         text        NOT NULL CHECK (run_type IN ('survey', 'import')),
  status           text        NOT NULL DEFAULT 'running' CHECK (
    status IN ('running', 'completed', 'failed')
  ),
  files_processed  integer     NOT NULL DEFAULT 0,
  notes            text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);

CREATE INDEX IF NOT EXISTS import_runs_run_type_idx ON staging.import_runs (run_type);
CREATE INDEX IF NOT EXISTS import_runs_status_idx ON staging.import_runs (status);
CREATE INDEX IF NOT EXISTS import_runs_started_at_idx ON staging.import_runs (started_at);

-- ---------------------------------------------------------------------------
-- staging.raw_records — untyped imported rows before mapping to app
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staging.raw_records (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  drive_file_id      text        NOT NULL REFERENCES staging.drive_files (drive_file_id) ON DELETE CASCADE,
  record_type        text        NOT NULL DEFAULT 'unknown' CHECK (
    record_type IN ('crm_account', 'contact', 'load', 'invoice', 'unknown')
  ),
  raw_data           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  mapping_status     text        NOT NULL DEFAULT 'unmapped' CHECK (
    mapping_status IN ('unmapped', 'mapped', 'promoted', 'rejected')
  ),
  target_table       text,
  validation_errors  jsonb,
  promoted_to_id     uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS raw_records_drive_file_id_idx ON staging.raw_records (drive_file_id);
CREATE INDEX IF NOT EXISTS raw_records_record_type_idx ON staging.raw_records (record_type);
CREATE INDEX IF NOT EXISTS raw_records_mapping_status_idx ON staging.raw_records (mapping_status);
CREATE INDEX IF NOT EXISTS raw_records_target_table_idx ON staging.raw_records (target_table);
CREATE INDEX IF NOT EXISTS raw_records_promoted_to_id_idx ON staging.raw_records (promoted_to_id);

-- ---------------------------------------------------------------------------
-- RLS — internal users only (requires private.is_internal_user from 012)
-- ---------------------------------------------------------------------------

ALTER TABLE staging.drive_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE staging.import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE staging.raw_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS internal_full_access ON staging.drive_files;
CREATE POLICY internal_full_access ON staging.drive_files
  FOR ALL TO authenticated
  USING (private.is_internal_user())
  WITH CHECK (private.is_internal_user());

DROP POLICY IF EXISTS internal_full_access ON staging.import_runs;
CREATE POLICY internal_full_access ON staging.import_runs
  FOR ALL TO authenticated
  USING (private.is_internal_user())
  WITH CHECK (private.is_internal_user());

DROP POLICY IF EXISTS internal_full_access ON staging.raw_records;
CREATE POLICY internal_full_access ON staging.raw_records
  FOR ALL TO authenticated
  USING (private.is_internal_user())
  WITH CHECK (private.is_internal_user());

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS set_updated_at ON staging.drive_files;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON staging.drive_files
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON staging.raw_records;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON staging.raw_records
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Privileges — service role for edge functions; authenticated gated by RLS
-- Do NOT add staging to Supabase API exposed schemas (config.toml / dashboard)
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA staging TO postgres, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA staging
  GRANT ALL ON TABLES TO postgres, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA staging TO postgres, service_role;

GRANT USAGE ON SCHEMA staging TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA staging TO authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA staging
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;

INSERT INTO app._migrations (name)
VALUES ('017_staging_schema')
ON CONFLICT (name) DO NOTHING;
