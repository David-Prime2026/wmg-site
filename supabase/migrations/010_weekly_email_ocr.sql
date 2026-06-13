-- Wave 10: Weekly load lists, email records, OCR documents

CREATE TABLE IF NOT EXISTS app.weekly_load_lists (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start    date        NOT NULL,
  week_end      date        NOT NULL,
  list_name     text,
  status        text        NOT NULL DEFAULT 'draft',
  published_at  timestamptz,
  notes         text,
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (week_end >= week_start)
);

CREATE INDEX IF NOT EXISTS weekly_load_lists_week_start_idx ON app.weekly_load_lists (week_start);
CREATE INDEX IF NOT EXISTS weekly_load_lists_status_idx ON app.weekly_load_lists (status);

CREATE TABLE IF NOT EXISTS app.weekly_load_list_items (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_load_list_id uuid        NOT NULL REFERENCES app.weekly_load_lists (id) ON DELETE CASCADE,
  load_id             uuid        NOT NULL REFERENCES app.loads (id) ON DELETE CASCADE,
  sort_order          integer     NOT NULL DEFAULT 0,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (weekly_load_list_id, load_id)
);

CREATE INDEX IF NOT EXISTS weekly_load_list_items_weekly_load_list_id_idx
  ON app.weekly_load_list_items (weekly_load_list_id);

CREATE INDEX IF NOT EXISTS weekly_load_list_items_load_id_idx
  ON app.weekly_load_list_items (load_id);

CREATE TABLE IF NOT EXISTS app.email_records (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      text,
  subject         text,
  sender          text,
  recipients      text[],
  received_at     timestamptz NOT NULL DEFAULT now(),
  body_text       text,
  body_html       text,
  load_id         uuid        REFERENCES app.loads (id) ON DELETE SET NULL,
  processing_status text      NOT NULL DEFAULT 'pending',
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_records_message_id_idx ON app.email_records (message_id);
CREATE INDEX IF NOT EXISTS email_records_load_id_idx ON app.email_records (load_id);
CREATE INDEX IF NOT EXISTS email_records_processing_status_idx ON app.email_records (processing_status);
CREATE INDEX IF NOT EXISTS email_records_received_at_idx ON app.email_records (received_at);

CREATE TABLE IF NOT EXISTS app.ocr_documents (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email_record_id   uuid        REFERENCES app.email_records (id) ON DELETE SET NULL,
  load_id           uuid        REFERENCES app.loads (id) ON DELETE SET NULL,
  document_type     text        NOT NULL DEFAULT 'unknown',
  source_filename   text,
  storage_path      text,
  ocr_status        text        NOT NULL DEFAULT 'pending',
  extracted_text    text,
  extracted_data    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  confidence_score  numeric(5, 4),
  processed_at      timestamptz,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ocr_documents_email_record_id_idx ON app.ocr_documents (email_record_id);
CREATE INDEX IF NOT EXISTS ocr_documents_load_id_idx ON app.ocr_documents (load_id);
CREATE INDEX IF NOT EXISTS ocr_documents_ocr_status_idx ON app.ocr_documents (ocr_status);
CREATE INDEX IF NOT EXISTS ocr_documents_document_type_idx ON app.ocr_documents (document_type);

ALTER TABLE app.weekly_load_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.weekly_load_list_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.email_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ocr_documents ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'weekly_load_lists' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.weekly_load_lists
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'weekly_load_list_items' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.weekly_load_list_items
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'email_records' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.email_records
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'ocr_documents' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.ocr_documents
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

DROP TRIGGER IF EXISTS set_updated_at ON app.weekly_load_lists;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.weekly_load_lists
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.weekly_load_list_items;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.weekly_load_list_items
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.email_records;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.email_records
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.ocr_documents;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.ocr_documents
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

INSERT INTO app._migrations (name)
VALUES ('010_weekly_email_ocr')
ON CONFLICT (name) DO NOTHING;
