-- Wave 3: CRM accounts, parent/child relationships, contacts

CREATE TABLE IF NOT EXISTS app.crm_accounts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL,
  account_type    text        NOT NULL,
  status          text        NOT NULL DEFAULT 'active',
  external_ref    text,
  billing_address jsonb,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_accounts_name_idx ON app.crm_accounts (name);
CREATE INDEX IF NOT EXISTS crm_accounts_account_type_idx ON app.crm_accounts (account_type);
CREATE INDEX IF NOT EXISTS crm_accounts_status_idx ON app.crm_accounts (status);

CREATE TABLE IF NOT EXISTS app.crm_account_relationships (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_account_id   uuid        NOT NULL REFERENCES app.crm_accounts (id) ON DELETE CASCADE,
  child_account_id    uuid        NOT NULL REFERENCES app.crm_accounts (id) ON DELETE CASCADE,
  relationship_type   text        NOT NULL DEFAULT 'parent_child',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_account_id, child_account_id, relationship_type),
  CHECK (parent_account_id <> child_account_id)
);

CREATE INDEX IF NOT EXISTS crm_account_relationships_parent_idx
  ON app.crm_account_relationships (parent_account_id);

CREATE INDEX IF NOT EXISTS crm_account_relationships_child_idx
  ON app.crm_account_relationships (child_account_id);

CREATE TABLE IF NOT EXISTS app.contacts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  crm_account_id  uuid        NOT NULL REFERENCES app.crm_accounts (id) ON DELETE CASCADE,
  first_name      text,
  last_name       text,
  email           text,
  phone           text,
  title           text,
  is_primary      boolean     NOT NULL DEFAULT false,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contacts_crm_account_id_idx ON app.contacts (crm_account_id);
CREATE INDEX IF NOT EXISTS contacts_email_idx ON app.contacts (email);

ALTER TABLE app.crm_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.crm_account_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contacts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'crm_accounts' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.crm_accounts
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'crm_account_relationships' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.crm_account_relationships
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'contacts' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.contacts
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

DROP TRIGGER IF EXISTS set_updated_at ON app.crm_accounts;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.crm_accounts
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.crm_account_relationships;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.crm_account_relationships
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.contacts;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.contacts
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

INSERT INTO app._migrations (name)
VALUES ('003_crm_accounts')
ON CONFLICT (name) DO NOTHING;
