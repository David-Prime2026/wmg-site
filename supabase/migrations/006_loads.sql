-- Wave 6: Loads, load states, release numbers

CREATE TABLE IF NOT EXISTS app.load_states (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  description text,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_terminal boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS load_states_sort_order_idx ON app.load_states (sort_order);

CREATE TABLE IF NOT EXISTS app.loads (
  id                uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  load_number       text,
  seller_account_id uuid           NOT NULL REFERENCES app.seller_accounts (id) ON DELETE RESTRICT,
  buyer_account_id  uuid           REFERENCES app.buyer_accounts (id) ON DELETE RESTRICT,
  commodity_id      uuid           NOT NULL REFERENCES app.commodities (id) ON DELETE RESTRICT,
  load_state_id     uuid           NOT NULL REFERENCES app.load_states (id) ON DELETE RESTRICT,
  quantity          numeric(12, 4),
  quantity_unit     text,
  intake_date       date,
  assigned_at       timestamptz,
  notes             text,
  metadata          jsonb          NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz    NOT NULL DEFAULT now(),
  updated_at        timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS loads_load_number_idx ON app.loads (load_number);
CREATE INDEX IF NOT EXISTS loads_seller_account_id_idx ON app.loads (seller_account_id);
CREATE INDEX IF NOT EXISTS loads_buyer_account_id_idx ON app.loads (buyer_account_id);
CREATE INDEX IF NOT EXISTS loads_commodity_id_idx ON app.loads (commodity_id);
CREATE INDEX IF NOT EXISTS loads_load_state_id_idx ON app.loads (load_state_id);
CREATE INDEX IF NOT EXISTS loads_intake_date_idx ON app.loads (intake_date);

CREATE TABLE IF NOT EXISTS app.release_numbers (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id         uuid        NOT NULL REFERENCES app.loads (id) ON DELETE CASCADE,
  release_number  text        NOT NULL,
  issued_at       timestamptz,
  expires_at      timestamptz,
  status          text        NOT NULL DEFAULT 'active',
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (load_id, release_number)
);

CREATE INDEX IF NOT EXISTS release_numbers_load_id_idx ON app.release_numbers (load_id);
CREATE INDEX IF NOT EXISTS release_numbers_release_number_idx ON app.release_numbers (release_number);

ALTER TABLE app.load_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.loads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.release_numbers ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'load_states' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.load_states
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'loads' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.loads
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'release_numbers' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.release_numbers
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

DROP TRIGGER IF EXISTS set_updated_at ON app.load_states;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.load_states
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.loads;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.loads
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.release_numbers;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.release_numbers
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

INSERT INTO app.load_states (code, name, sort_order, is_terminal)
VALUES
  ('intake', 'Intake', 10, false),
  ('assigned', 'Buyer Assigned', 20, false),
  ('on_board', 'On Load Board', 30, false),
  ('sold', 'Sold', 40, false),
  ('in_transit', 'In Transit', 50, false),
  ('delivered', 'Delivered', 60, false),
  ('closed', 'Closed', 70, true),
  ('cancelled', 'Cancelled', 80, true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO app._migrations (name)
VALUES ('006_loads')
ON CONFLICT (name) DO NOTHING;
