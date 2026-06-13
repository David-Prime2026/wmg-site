-- Wave 12: Replace placeholder RLS with internal + portal-scoped policies

-- ---------------------------------------------------------------------------
-- Private helper functions (SECURITY DEFINER — bypass RLS for role lookups)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.is_app_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, private, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.users u
    WHERE u.id = auth.uid()
      AND u.is_active = true
  );
$$;

CREATE OR REPLACE FUNCTION private.is_internal_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, private, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.users u
    JOIN app.user_roles ur ON ur.user_id = u.id
    JOIN app.roles r ON r.id = ur.role_id
    WHERE u.id = auth.uid()
      AND u.is_active = true
      AND r.is_internal = true
  );
$$;

CREATE OR REPLACE FUNCTION private.is_seller_portal_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, private, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.users u
    JOIN app.user_roles ur ON ur.user_id = u.id
    JOIN app.roles r ON r.id = ur.role_id
    WHERE u.id = auth.uid()
      AND u.is_active = true
      AND r.name = 'seller_portal'
  );
$$;

CREATE OR REPLACE FUNCTION private.is_buyer_portal_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, private, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.users u
    JOIN app.user_roles ur ON ur.user_id = u.id
    JOIN app.roles r ON r.id = ur.role_id
    WHERE u.id = auth.uid()
      AND u.is_active = true
      AND r.name = 'buyer_portal'
  );
$$;

CREATE OR REPLACE FUNCTION private.user_has_seller_account(p_seller_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, private, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.users u
    JOIN app.portal_access_settings pas ON pas.user_id = u.id
    WHERE u.id = auth.uid()
      AND u.is_active = true
      AND pas.seller_account_id = p_seller_account_id
      AND pas.is_enabled = true
  );
$$;

CREATE OR REPLACE FUNCTION private.user_has_buyer_account(p_buyer_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, private, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.users u
    JOIN app.portal_access_settings pas ON pas.user_id = u.id
    WHERE u.id = auth.uid()
      AND u.is_active = true
      AND pas.buyer_account_id = p_buyer_account_id
      AND pas.is_enabled = true
  );
$$;

CREATE OR REPLACE FUNCTION private.seller_owns_load(p_load_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, private, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.loads l
    WHERE l.id = p_load_id
      AND private.user_has_seller_account(l.seller_account_id)
  );
$$;

CREATE OR REPLACE FUNCTION private.seller_owns_payment(p_payment_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, private, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.payment_matching_records pmr
    JOIN app.invoices inv ON inv.id = pmr.invoice_id
    JOIN app.loads ld ON ld.id = inv.load_id
    WHERE pmr.payment_id = p_payment_id
      AND private.user_has_seller_account(ld.seller_account_id)
  );
$$;

REVOKE ALL ON FUNCTION private.is_app_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.is_internal_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.is_seller_portal_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.is_buyer_portal_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.user_has_seller_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.user_has_buyer_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.seller_owns_load(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.seller_owns_payment(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION private.is_app_user() TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_internal_user() TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_seller_portal_user() TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_buyer_portal_user() TO authenticated;
GRANT EXECUTE ON FUNCTION private.user_has_seller_account(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.user_has_buyer_account(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.seller_owns_load(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.seller_owns_payment(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Drop all placeholder policies
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'app'
      AND policyname = 'placeholder_authenticated_all'
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      pol.policyname,
      pol.schemaname,
      pol.tablename
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Internal users: full CRUD on every app schema table
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'app'
    ORDER BY tablename
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS internal_full_access ON app.%I', tbl);
    EXECUTE format(
      'CREATE POLICY internal_full_access ON app.%I
         FOR ALL TO authenticated
         USING (private.is_internal_user())
         WITH CHECK (private.is_internal_user())',
      tbl
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Seller portal: SELECT-only on own records (no INSERT/UPDATE/DELETE)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS seller_select_own ON app.seller_accounts;
CREATE POLICY seller_select_own ON app.seller_accounts
  FOR SELECT TO authenticated
  USING (
    private.is_app_user()
    AND private.is_seller_portal_user()
    AND private.user_has_seller_account(id)
  );

DROP POLICY IF EXISTS seller_select_own ON app.loads;
CREATE POLICY seller_select_own ON app.loads
  FOR SELECT TO authenticated
  USING (
    private.is_app_user()
    AND private.is_seller_portal_user()
    AND private.user_has_seller_account(seller_account_id)
  );

DROP POLICY IF EXISTS seller_select_own ON app.invoices;
CREATE POLICY seller_select_own ON app.invoices
  FOR SELECT TO authenticated
  USING (
    private.is_app_user()
    AND private.is_seller_portal_user()
    AND load_id IS NOT NULL
    AND private.seller_owns_load(load_id)
  );

DROP POLICY IF EXISTS seller_select_own ON app.payments;
CREATE POLICY seller_select_own ON app.payments
  FOR SELECT TO authenticated
  USING (
    private.is_app_user()
    AND private.is_seller_portal_user()
    AND private.seller_owns_payment(id)
  );

DROP POLICY IF EXISTS seller_select_own ON app.seller_statements;
CREATE POLICY seller_select_own ON app.seller_statements
  FOR SELECT TO authenticated
  USING (
    private.is_app_user()
    AND private.is_seller_portal_user()
    AND private.user_has_seller_account(seller_account_id)
  );

DROP POLICY IF EXISTS seller_select_own ON app.statement_lines;
CREATE POLICY seller_select_own ON app.statement_lines
  FOR SELECT TO authenticated
  USING (
    private.is_app_user()
    AND private.is_seller_portal_user()
    AND EXISTS (
      SELECT 1
      FROM app.seller_statements ss
      WHERE ss.id = statement_lines.statement_id
        AND private.user_has_seller_account(ss.seller_account_id)
    )
  );

DROP POLICY IF EXISTS seller_select_own ON app.ar_records;
CREATE POLICY seller_select_own ON app.ar_records
  FOR SELECT TO authenticated
  USING (
    private.is_app_user()
    AND private.is_seller_portal_user()
    AND load_id IS NOT NULL
    AND private.seller_owns_load(load_id)
  );

-- ---------------------------------------------------------------------------
-- Buyer portal: SELECT-only on own records (no INSERT/UPDATE/DELETE)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS buyer_select_own ON app.buyer_accounts;
CREATE POLICY buyer_select_own ON app.buyer_accounts
  FOR SELECT TO authenticated
  USING (
    private.is_app_user()
    AND private.is_buyer_portal_user()
    AND private.user_has_buyer_account(id)
  );

DROP POLICY IF EXISTS buyer_select_own ON app.loads;
CREATE POLICY buyer_select_own ON app.loads
  FOR SELECT TO authenticated
  USING (
    private.is_app_user()
    AND private.is_buyer_portal_user()
    AND buyer_account_id IS NOT NULL
    AND private.user_has_buyer_account(buyer_account_id)
  );

DROP POLICY IF EXISTS buyer_select_own ON app.invoices;
CREATE POLICY buyer_select_own ON app.invoices
  FOR SELECT TO authenticated
  USING (
    private.is_app_user()
    AND private.is_buyer_portal_user()
    AND buyer_account_id IS NOT NULL
    AND private.user_has_buyer_account(buyer_account_id)
  );

DROP POLICY IF EXISTS buyer_select_own ON app.payments;
CREATE POLICY buyer_select_own ON app.payments
  FOR SELECT TO authenticated
  USING (
    private.is_app_user()
    AND private.is_buyer_portal_user()
    AND buyer_account_id IS NOT NULL
    AND private.user_has_buyer_account(buyer_account_id)
  );

INSERT INTO app._migrations (name)
VALUES ('012_rls_policies')
ON CONFLICT (name) DO NOTHING;
