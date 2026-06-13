-- Wave 9: AR records, seller statements, statement lines, adjustments

CREATE TABLE IF NOT EXISTS app.ar_records (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_account_id uuid          REFERENCES app.buyer_accounts (id) ON DELETE RESTRICT,
  invoice_id      uuid           REFERENCES app.invoices (id) ON DELETE SET NULL,
  load_id         uuid           REFERENCES app.loads (id) ON DELETE SET NULL,
  record_date     date           NOT NULL DEFAULT CURRENT_DATE,
  amount          numeric(12, 2) NOT NULL,
  balance         numeric(12, 2) NOT NULL DEFAULT 0,
  status          text           NOT NULL DEFAULT 'open',
  notes           text,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ar_records_buyer_account_id_idx ON app.ar_records (buyer_account_id);
CREATE INDEX IF NOT EXISTS ar_records_invoice_id_idx ON app.ar_records (invoice_id);
CREATE INDEX IF NOT EXISTS ar_records_load_id_idx ON app.ar_records (load_id);
CREATE INDEX IF NOT EXISTS ar_records_status_idx ON app.ar_records (status);

CREATE TABLE IF NOT EXISTS app.seller_statements (
  id                uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_account_id uuid           NOT NULL REFERENCES app.seller_accounts (id) ON DELETE RESTRICT,
  statement_number  text,
  period_start      date           NOT NULL,
  period_end        date           NOT NULL,
  total_amount      numeric(12, 2) NOT NULL DEFAULT 0,
  status            text           NOT NULL DEFAULT 'draft',
  issued_at         timestamptz,
  notes             text,
  created_at        timestamptz    NOT NULL DEFAULT now(),
  updated_at        timestamptz    NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS seller_statements_seller_account_id_idx
  ON app.seller_statements (seller_account_id);

CREATE INDEX IF NOT EXISTS seller_statements_period_idx
  ON app.seller_statements (period_start, period_end);

CREATE INDEX IF NOT EXISTS seller_statements_status_idx ON app.seller_statements (status);

CREATE TABLE IF NOT EXISTS app.statement_lines (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id    uuid           NOT NULL REFERENCES app.seller_statements (id) ON DELETE CASCADE,
  load_id         uuid           REFERENCES app.loads (id) ON DELETE SET NULL,
  line_date       date           NOT NULL DEFAULT CURRENT_DATE,
  description     text,
  quantity        numeric(12, 4),
  unit_price      numeric(12, 4),
  amount          numeric(12, 2) NOT NULL DEFAULT 0,
  line_type       text           NOT NULL DEFAULT 'load',
  sort_order      integer        NOT NULL DEFAULT 0,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS statement_lines_statement_id_idx ON app.statement_lines (statement_id);
CREATE INDEX IF NOT EXISTS statement_lines_load_id_idx ON app.statement_lines (load_id);

CREATE TABLE IF NOT EXISTS app.adjustments (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id    uuid           REFERENCES app.seller_statements (id) ON DELETE CASCADE,
  load_id         uuid           REFERENCES app.loads (id) ON DELETE SET NULL,
  adjustment_date date           NOT NULL DEFAULT CURRENT_DATE,
  amount          numeric(12, 2) NOT NULL,
  reason          text           NOT NULL,
  adjustment_type text           NOT NULL DEFAULT 'credit',
  status          text           NOT NULL DEFAULT 'pending',
  approved_by     uuid           REFERENCES app.users (id) ON DELETE SET NULL,
  approved_at     timestamptz,
  notes           text,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS adjustments_statement_id_idx ON app.adjustments (statement_id);
CREATE INDEX IF NOT EXISTS adjustments_load_id_idx ON app.adjustments (load_id);
CREATE INDEX IF NOT EXISTS adjustments_status_idx ON app.adjustments (status);

ALTER TABLE app.ar_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.seller_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.statement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.adjustments ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'ar_records' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.ar_records
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'seller_statements' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.seller_statements
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'statement_lines' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.statement_lines
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'adjustments' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.adjustments
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

DROP TRIGGER IF EXISTS set_updated_at ON app.ar_records;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.ar_records
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.seller_statements;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.seller_statements
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.statement_lines;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.statement_lines
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.adjustments;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.adjustments
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

INSERT INTO app._migrations (name)
VALUES ('009_ar_statements')
ON CONFLICT (name) DO NOTHING;
