-- Wave 11: Notifications, audit log, SOP/tutorial records, workflow settings, master data lists

CREATE TABLE IF NOT EXISTS app.notifications (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  title       text        NOT NULL,
  body        text,
  category    text        NOT NULL DEFAULT 'general',
  entity_type text,
  entity_id   uuid,
  is_read     boolean     NOT NULL DEFAULT false,
  read_at     timestamptz,
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON app.notifications (user_id);
CREATE INDEX IF NOT EXISTS notifications_is_read_idx ON app.notifications (is_read);
CREATE INDEX IF NOT EXISTS notifications_category_idx ON app.notifications (category);

CREATE TABLE IF NOT EXISTS app.audit_log_entries (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        REFERENCES app.users (id) ON DELETE SET NULL,
  action      text        NOT NULL,
  entity_type text        NOT NULL,
  entity_id   uuid,
  old_values  jsonb,
  new_values  jsonb,
  ip_address  inet,
  user_agent  text,
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_entries_user_id_idx ON app.audit_log_entries (user_id);
CREATE INDEX IF NOT EXISTS audit_log_entries_entity_idx ON app.audit_log_entries (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_entries_action_idx ON app.audit_log_entries (action);
CREATE INDEX IF NOT EXISTS audit_log_entries_created_at_idx ON app.audit_log_entries (created_at);

CREATE TABLE IF NOT EXISTS app.sop_tutorial_records (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text        NOT NULL,
  slug          text        NOT NULL UNIQUE,
  category      text        NOT NULL DEFAULT 'sop',
  content       text,
  content_url   text,
  sort_order    integer     NOT NULL DEFAULT 0,
  is_published  boolean     NOT NULL DEFAULT false,
  published_at  timestamptz,
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sop_tutorial_records_category_idx ON app.sop_tutorial_records (category);
CREATE INDEX IF NOT EXISTS sop_tutorial_records_is_published_idx ON app.sop_tutorial_records (is_published);

CREATE TABLE IF NOT EXISTS app.workflow_settings (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key text        NOT NULL UNIQUE,
  setting_value jsonb     NOT NULL DEFAULT '{}'::jsonb,
  description text,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_settings_is_active_idx ON app.workflow_settings (is_active);

CREATE TABLE IF NOT EXISTS app.master_data_lists (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  list_key    text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  description text,
  is_active   boolean     NOT NULL DEFAULT true,
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS master_data_lists_is_active_idx ON app.master_data_lists (is_active);

CREATE TABLE IF NOT EXISTS app.master_data_list_items (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  master_data_list_id uuid        NOT NULL REFERENCES app.master_data_lists (id) ON DELETE CASCADE,
  item_key            text        NOT NULL,
  label               text        NOT NULL,
  value               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  sort_order          integer     NOT NULL DEFAULT 0,
  is_active           boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (master_data_list_id, item_key)
);

CREATE INDEX IF NOT EXISTS master_data_list_items_master_data_list_id_idx
  ON app.master_data_list_items (master_data_list_id);

CREATE INDEX IF NOT EXISTS master_data_list_items_is_active_idx
  ON app.master_data_list_items (is_active);

ALTER TABLE app.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_log_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sop_tutorial_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.master_data_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.master_data_list_items ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'notifications' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.notifications
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'audit_log_entries' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.audit_log_entries
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'sop_tutorial_records' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.sop_tutorial_records
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'workflow_settings' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.workflow_settings
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'master_data_lists' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.master_data_lists
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'master_data_list_items' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.master_data_list_items
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

DROP TRIGGER IF EXISTS set_updated_at ON app.notifications;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.notifications
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.audit_log_entries;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.audit_log_entries
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.sop_tutorial_records;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.sop_tutorial_records
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.workflow_settings;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.workflow_settings
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.master_data_lists;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.master_data_lists
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.master_data_list_items;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.master_data_list_items
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

INSERT INTO app._migrations (name)
VALUES ('011_notifications_audit')
ON CONFLICT (name) DO NOTHING;
