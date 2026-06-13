-- Wave 14: Comms layer — notification preferences, outbound log, inbound email routing

CREATE TABLE IF NOT EXISTS app.notification_preferences (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  channel     text        NOT NULL CHECK (channel IN ('email', 'sms')),
  opted_in    boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel)
);

CREATE INDEX IF NOT EXISTS notification_preferences_user_id_idx
  ON app.notification_preferences (user_id);

CREATE TABLE IF NOT EXISTS app.outbound_notification_log (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id   uuid        REFERENCES app.users (id) ON DELETE SET NULL,
  recipient_email     text,
  recipient_phone     text,
  channel             text        NOT NULL CHECK (channel IN ('email', 'sms')),
  notification_type   text        NOT NULL CHECK (
    notification_type IN (
      'sales_memo',
      'payment_confirmation',
      'ar_overdue',
      'load_status'
    )
  ),
  subject             text,
  body                text,
  status              text        NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'sent', 'failed', 'delivered')
  ),
  related_entity_type text        CHECK (
    related_entity_type IS NULL
    OR related_entity_type IN ('load', 'invoice', 'statement', 'sales_memo')
  ),
  related_entity_id   uuid,
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbound_notification_log_recipient_user_id_idx
  ON app.outbound_notification_log (recipient_user_id);

CREATE INDEX IF NOT EXISTS outbound_notification_log_status_idx
  ON app.outbound_notification_log (status);

CREATE INDEX IF NOT EXISTS outbound_notification_log_notification_type_idx
  ON app.outbound_notification_log (notification_type);

CREATE INDEX IF NOT EXISTS outbound_notification_log_related_entity_idx
  ON app.outbound_notification_log (related_entity_type, related_entity_id);

CREATE TABLE IF NOT EXISTS app.inbound_email_routing (
  id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  to_address          text           NOT NULL,
  from_address        text,
  subject             text,
  raw_body            text,
  classification      text           CHECK (
    classification IS NULL
    OR classification IN ('invoice', 'load_order', 'pickup_verification')
  ),
  confidence          numeric(5, 4),
  processed           boolean        NOT NULL DEFAULT false,
  processed_at        timestamptz,
  related_entity_type text,
  related_entity_id   uuid,
  created_at          timestamptz    NOT NULL DEFAULT now(),
  updated_at          timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbound_email_routing_to_address_idx
  ON app.inbound_email_routing (to_address);

CREATE INDEX IF NOT EXISTS inbound_email_routing_processed_idx
  ON app.inbound_email_routing (processed);

CREATE INDEX IF NOT EXISTS inbound_email_routing_classification_idx
  ON app.inbound_email_routing (classification);

ALTER TABLE app.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbound_notification_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.inbound_email_routing ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS internal_full_access ON app.notification_preferences;
CREATE POLICY internal_full_access ON app.notification_preferences
  FOR ALL TO authenticated
  USING (private.is_internal_user())
  WITH CHECK (private.is_internal_user());

DROP POLICY IF EXISTS internal_full_access ON app.outbound_notification_log;
CREATE POLICY internal_full_access ON app.outbound_notification_log
  FOR ALL TO authenticated
  USING (private.is_internal_user())
  WITH CHECK (private.is_internal_user());

DROP POLICY IF EXISTS internal_full_access ON app.inbound_email_routing;
CREATE POLICY internal_full_access ON app.inbound_email_routing
  FOR ALL TO authenticated
  USING (private.is_internal_user())
  WITH CHECK (private.is_internal_user());

DROP TRIGGER IF EXISTS set_updated_at ON app.notification_preferences;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.outbound_notification_log;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.outbound_notification_log
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.inbound_email_routing;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.inbound_email_routing
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON app.notification_preferences TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.outbound_notification_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.inbound_email_routing TO authenticated;

INSERT INTO app._migrations (name)
VALUES ('014_comms_layer')
ON CONFLICT (name) DO NOTHING;
