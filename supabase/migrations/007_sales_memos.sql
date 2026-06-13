-- Wave 7: Sales memos, load orders, reroutes

CREATE TABLE IF NOT EXISTS app.sales_memos (
  id            uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id       uuid           NOT NULL REFERENCES app.loads (id) ON DELETE CASCADE,
  memo_number   text           NOT NULL,
  memo_date     date           NOT NULL DEFAULT CURRENT_DATE,
  amount        numeric(12, 2),
  status        text           NOT NULL DEFAULT 'draft',
  notes         text,
  document_url  text,
  created_at    timestamptz    NOT NULL DEFAULT now(),
  updated_at    timestamptz    NOT NULL DEFAULT now(),
  UNIQUE (memo_number)
);

CREATE INDEX IF NOT EXISTS sales_memos_load_id_idx ON app.sales_memos (load_id);
CREATE INDEX IF NOT EXISTS sales_memos_memo_date_idx ON app.sales_memos (memo_date);
CREATE INDEX IF NOT EXISTS sales_memos_status_idx ON app.sales_memos (status);

CREATE TABLE IF NOT EXISTS app.load_orders (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id         uuid           NOT NULL REFERENCES app.loads (id) ON DELETE CASCADE,
  order_number    text,
  order_date      date           NOT NULL DEFAULT CURRENT_DATE,
  quantity        numeric(12, 4),
  quantity_unit   text,
  unit_price      numeric(12, 4),
  total_amount    numeric(12, 2),
  status          text           NOT NULL DEFAULT 'open',
  notes           text,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS load_orders_load_id_idx ON app.load_orders (load_id);
CREATE INDEX IF NOT EXISTS load_orders_order_number_idx ON app.load_orders (order_number);
CREATE INDEX IF NOT EXISTS load_orders_status_idx ON app.load_orders (status);

CREATE TABLE IF NOT EXISTS app.reroutes (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id             uuid        NOT NULL REFERENCES app.loads (id) ON DELETE CASCADE,
  from_buyer_account_id uuid      REFERENCES app.buyer_accounts (id) ON DELETE RESTRICT,
  to_buyer_account_id   uuid      REFERENCES app.buyer_accounts (id) ON DELETE RESTRICT,
  reroute_date        date        NOT NULL DEFAULT CURRENT_DATE,
  reason              text,
  status              text        NOT NULL DEFAULT 'pending',
  approved_by         uuid        REFERENCES app.users (id) ON DELETE SET NULL,
  approved_at         timestamptz,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reroutes_load_id_idx ON app.reroutes (load_id);
CREATE INDEX IF NOT EXISTS reroutes_status_idx ON app.reroutes (status);

ALTER TABLE app.sales_memos ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.load_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.reroutes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'sales_memos' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.sales_memos
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'load_orders' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.load_orders
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'reroutes' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.reroutes
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

DROP TRIGGER IF EXISTS set_updated_at ON app.sales_memos;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.sales_memos
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.load_orders;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.load_orders
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.reroutes;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.reroutes
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

INSERT INTO app._migrations (name)
VALUES ('007_sales_memos')
ON CONFLICT (name) DO NOTHING;
