-- Wave 15: Extend ocr_documents for inbound email attachment pipeline

ALTER TABLE app.ocr_documents
  ADD COLUMN IF NOT EXISTS inbound_email_id uuid;

ALTER TABLE app.ocr_documents
  ADD COLUMN IF NOT EXISTS media_type text;

ALTER TABLE app.ocr_documents
  ADD COLUMN IF NOT EXISTS source_filename text;

ALTER TABLE app.ocr_documents
  ADD COLUMN IF NOT EXISTS confidence_score numeric(5, 4);

ALTER TABLE app.ocr_documents
  ADD COLUMN IF NOT EXISTS ocr_status text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ocr_documents_inbound_email_id_fkey'
      AND conrelid = 'app.ocr_documents'::regclass
  ) THEN
    ALTER TABLE app.ocr_documents
      ADD CONSTRAINT ocr_documents_inbound_email_id_fkey
      FOREIGN KEY (inbound_email_id)
      REFERENCES app.inbound_email_routing (id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ocr_documents_inbound_email_id_idx
  ON app.ocr_documents (inbound_email_id);

INSERT INTO app._migrations (name)
VALUES ('015_ocr_documents_extend')
ON CONFLICT (name) DO NOTHING;
