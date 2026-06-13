-- Wave 8: Invoices, BOLs, payments, payment notices, payment matching

CREATE TABLE IF NOT EXISTS app.invoices (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id         uuid           REFERENCES app.loads (id) ON DELETE SET NULL,
  buyer_account_id uuid          REFERENCES app.buyer_accounts (id) ON DELETE RESTRICT,
  invoice_number  text           NOT NULL,
  invoice_date    date           NOT NULL DEFAULT CURRENT_DATE,
  due_date        date,
  amount          numeric(12, 2) NOT NULL DEFAULT 0,
  status          text           NOT NULL DEFAULT 'draft',
  notes           text,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now(),
  UNIQUE (invoice_number)
);

CREATE INDEX IF NOT EXISTS invoices_load_id_idx ON app.invoices (load_id);
CREATE INDEX IF NOT EXISTS invoices_buyer_account_id_idx ON app.invoices (buyer_account_id);
CREATE INDEX IF NOT EXISTS invoices_status_idx ON app.invoices (status);

CREATE TABLE IF NOT EXISTS app.bols (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id     uuid        NOT NULL REFERENCES app.loads (id) ON DELETE CASCADE,
  bol_number  text        NOT NULL,
  bol_date    date,
  carrier     text,
  status      text        NOT NULL DEFAULT 'pending',
  document_url text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (load_id, bol_number)
);

CREATE INDEX IF NOT EXISTS bols_bol_number_idx ON app.bols (bol_number);
CREATE INDEX IF NOT EXISTS bols_status_idx ON app.bols (status);

CREATE TABLE IF NOT EXISTS app.payments (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_account_id uuid          REFERENCES app.buyer_accounts (id) ON DELETE RESTRICT,
  payment_number  text,
  payment_date    date           NOT NULL DEFAULT CURRENT_DATE,
  amount          numeric(12, 2) NOT NULL,
  payment_method  text,
  reference       text,
  status          text           NOT NULL DEFAULT 'received',
  notes           text,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_buyer_account_id_idx ON app.payments (buyer_account_id);
CREATE INDEX IF NOT EXISTS payments_payment_date_idx ON app.payments (payment_date);
CREATE INDEX IF NOT EXISTS payments_status_idx ON app.payments (status);

CREATE TABLE IF NOT EXISTS app.payment_notices (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id         uuid           REFERENCES app.loads (id) ON DELETE SET NULL,
  buyer_account_id uuid          REFERENCES app.buyer_accounts (id) ON DELETE RESTRICT,
  notice_number   text,
  notice_date     date           NOT NULL DEFAULT CURRENT_DATE,
  amount_due      numeric(12, 2) NOT NULL DEFAULT 0,
  due_date        date,
  status          text           NOT NULL DEFAULT 'sent',
  notes           text,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_notices_load_id_idx ON app.payment_notices (load_id);
CREATE INDEX IF NOT EXISTS payment_notices_buyer_account_id_idx ON app.payment_notices (buyer_account_id);
CREATE INDEX IF NOT EXISTS payment_notices_status_idx ON app.payment_notices (status);

CREATE TABLE IF NOT EXISTS app.payment_matching_records (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id      uuid           NOT NULL REFERENCES app.payments (id) ON DELETE CASCADE,
  invoice_id      uuid           REFERENCES app.invoices (id) ON DELETE SET NULL,
  payment_notice_id uuid         REFERENCES app.payment_notices (id) ON DELETE SET NULL,
  matched_amount  numeric(12, 2) NOT NULL,
  matched_at      timestamptz    NOT NULL DEFAULT now(),
  match_status    text           NOT NULL DEFAULT 'matched',
  notes           text,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_matching_records_payment_id_idx
  ON app.payment_matching_records (payment_id);

CREATE INDEX IF NOT EXISTS payment_matching_records_invoice_id_idx
  ON app.payment_matching_records (invoice_id);

CREATE INDEX IF NOT EXISTS payment_matching_records_payment_notice_id_idx
  ON app.payment_matching_records (payment_notice_id);

ALTER TABLE app.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bols ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payment_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payment_matching_records ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'invoices' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.invoices
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'bols' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.bols
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'payments' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.payments
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'payment_notices' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.payment_notices
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'payment_matching_records' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.payment_matching_records
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

DROP TRIGGER IF EXISTS set_updated_at ON app.invoices;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.invoices
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.bols;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.bols
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.payments;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.payments
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.payment_notices;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.payment_notices
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.payment_matching_records;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.payment_matching_records
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

INSERT INTO app._migrations (name)
VALUES ('008_invoices_payments')
ON CONFLICT (name) DO NOTHING;
