-- Wave 4: Seller accounts, buyer accounts, portal access

CREATE TABLE IF NOT EXISTS app.seller_accounts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  crm_account_id  uuid        NOT NULL UNIQUE REFERENCES app.crm_accounts (id) ON DELETE RESTRICT,
  seller_code     text,
  nonprofit_ein   text,
  status          text        NOT NULL DEFAULT 'active',
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS seller_accounts_crm_account_id_idx ON app.seller_accounts (crm_account_id);
CREATE INDEX IF NOT EXISTS seller_accounts_status_idx ON app.seller_accounts (status);

CREATE TABLE IF NOT EXISTS app.buyer_accounts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  crm_account_id  uuid        NOT NULL UNIQUE REFERENCES app.crm_accounts (id) ON DELETE RESTRICT,
  buyer_code      text,
  status          text        NOT NULL DEFAULT 'active',
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buyer_accounts_crm_account_id_idx ON app.buyer_accounts (crm_account_id);
CREATE INDEX IF NOT EXISTS buyer_accounts_status_idx ON app.buyer_accounts (status);

CREATE TABLE IF NOT EXISTS app.portal_access_settings (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        REFERENCES app.users (id) ON DELETE CASCADE,
  seller_account_id uuid        REFERENCES app.seller_accounts (id) ON DELETE CASCADE,
  buyer_account_id  uuid        REFERENCES app.buyer_accounts (id) ON DELETE CASCADE,
  portal_type       text        NOT NULL,
  access_level      text        NOT NULL DEFAULT 'read',
  is_enabled        boolean     NOT NULL DEFAULT true,
  permissions       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (seller_account_id IS NOT NULL AND buyer_account_id IS NULL)
    OR (seller_account_id IS NULL AND buyer_account_id IS NOT NULL)
    OR (seller_account_id IS NULL AND buyer_account_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS portal_access_settings_user_id_idx ON app.portal_access_settings (user_id);
CREATE INDEX IF NOT EXISTS portal_access_settings_seller_account_id_idx ON app.portal_access_settings (seller_account_id);
CREATE INDEX IF NOT EXISTS portal_access_settings_buyer_account_id_idx ON app.portal_access_settings (buyer_account_id);
CREATE INDEX IF NOT EXISTS portal_access_settings_portal_type_idx ON app.portal_access_settings (portal_type);

ALTER TABLE app.seller_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.buyer_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.portal_access_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'seller_accounts' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.seller_accounts
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'buyer_accounts' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.buyer_accounts
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'portal_access_settings' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.portal_access_settings
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

DROP TRIGGER IF EXISTS set_updated_at ON app.seller_accounts;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.seller_accounts
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.buyer_accounts;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.buyer_accounts
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.portal_access_settings;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.portal_access_settings
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

INSERT INTO app._migrations (name)
VALUES ('004_seller_buyer_portal')
ON CONFLICT (name) DO NOTHING;
