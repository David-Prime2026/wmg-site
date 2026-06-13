-- Wave 13: Sync auth.users signups into app.users

CREATE OR REPLACE FUNCTION private.sync_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, private, auth
AS $$
BEGIN
  INSERT INTO app.users (id, email, full_name, is_active)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name',
    true
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.sync_auth_user() FROM PUBLIC;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION private.sync_auth_user();

INSERT INTO app._migrations (name)
VALUES ('013_auth_user_sync')
ON CONFLICT (name) DO NOTHING;
