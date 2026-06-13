-- Wave 5: Commodities, commodity monthly pricing

CREATE TABLE IF NOT EXISTS app.commodities (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  unit        text,
  description text,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commodities_name_idx ON app.commodities (name);
CREATE INDEX IF NOT EXISTS commodities_is_active_idx ON app.commodities (is_active);

CREATE TABLE IF NOT EXISTS app.commodity_monthly_pricing (
  id            uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  commodity_id  uuid           NOT NULL REFERENCES app.commodities (id) ON DELETE CASCADE,
  pricing_year  integer        NOT NULL,
  pricing_month integer        NOT NULL CHECK (pricing_month BETWEEN 1 AND 12),
  price         numeric(12, 4) NOT NULL,
  currency      text           NOT NULL DEFAULT 'USD',
  notes         text,
  created_at    timestamptz    NOT NULL DEFAULT now(),
  updated_at    timestamptz    NOT NULL DEFAULT now(),
  UNIQUE (commodity_id, pricing_year, pricing_month)
);

CREATE INDEX IF NOT EXISTS commodity_monthly_pricing_commodity_id_idx
  ON app.commodity_monthly_pricing (commodity_id);

CREATE INDEX IF NOT EXISTS commodity_monthly_pricing_period_idx
  ON app.commodity_monthly_pricing (pricing_year, pricing_month);

ALTER TABLE app.commodities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.commodity_monthly_pricing ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'commodities' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.commodities
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = 'commodity_monthly_pricing' AND policyname = 'placeholder_authenticated_all'
  ) THEN
    CREATE POLICY placeholder_authenticated_all ON app.commodity_monthly_pricing
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

DROP TRIGGER IF EXISTS set_updated_at ON app.commodities;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.commodities
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON app.commodity_monthly_pricing;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON app.commodity_monthly_pricing
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

INSERT INTO app._migrations (name)
VALUES ('005_commodities')
ON CONFLICT (name) DO NOTHING;
