-- Add 'skipped' to outbound_notification_log.status allowed values

ALTER TABLE app.outbound_notification_log
  DROP CONSTRAINT IF EXISTS outbound_notification_log_status_check;

ALTER TABLE app.outbound_notification_log
  ADD CONSTRAINT outbound_notification_log_status_check
  CHECK (status IN ('queued', 'sent', 'failed', 'delivered', 'skipped'));

INSERT INTO app._migrations (name)
VALUES ('016_add_skipped_status')
ON CONFLICT (name) DO NOTHING;
