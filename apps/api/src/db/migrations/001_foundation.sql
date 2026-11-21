-- Phase 1: tenancy, access, plans/features, audit, idempotency, jobs.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ---------- helpers used by RLS policies ----------
CREATE FUNCTION app_shop() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.shop_id', true), '')::uuid $$;

CREATE FUNCTION app_is_platform() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.is_platform_admin', true), 'false') = 'true' $$;

-- ---------- platform tables (no tenant data) ----------
CREATE TABLE plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  price_monthly numeric(18,2) NOT NULL DEFAULT 0,
  price_annual numeric(18,2) NOT NULL DEFAULT 0,
  trial_days int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feature (
  key text PRIMARY KEY,
  description text,
  module text
);

CREATE TABLE plan_feature (
  plan_id uuid NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES feature(key),
  PRIMARY KEY (plan_id, feature_key)
);

CREATE TABLE plan_limit (
  plan_id uuid NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  limit_key text NOT NULL,
  value int NOT NULL,
  PRIMARY KEY (plan_id, limit_key)
);

CREATE TABLE platform_admin (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_admin_email ON platform_admin (lower(email));

-- ---------- shop (tenant root) ----------
CREATE TABLE shop (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  shop_type text NOT NULL CHECK (shop_type IN ('hardware','paint','both')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscription (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL UNIQUE REFERENCES shop(id),
  plan_id uuid NOT NULL REFERENCES plan(id),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('trial','active','past_due','restricted','cancelled')),
  billing_period text NOT NULL DEFAULT 'monthly' CHECK (billing_period IN ('monthly','annual')),
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  grace_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shop_feature_override (
  shop_id uuid NOT NULL REFERENCES shop(id),
  feature_key text NOT NULL REFERENCES feature(key),
  enabled boolean NOT NULL,
  expires_at timestamptz,
  reason text,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, feature_key)
);

CREATE TABLE shop_limit_override (
  shop_id uuid NOT NULL REFERENCES shop(id),
  limit_key text NOT NULL,
  value int NOT NULL,
  expires_at timestamptz,
  reason text,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, limit_key)
);

-- ---------- tenant tables ----------
CREATE TABLE branch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shop(id),
  name text NOT NULL,
  code text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  is_default boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, name)
);

CREATE TABLE role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shop(id),
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  system_key text,
  permissions text[] NOT NULL DEFAULT '{}',
  approval_limits jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, name)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shop(id),
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  pin_hash text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  must_change_password boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);
CREATE UNIQUE INDEX users_email_global ON users (lower(email));

CREATE TABLE user_branch_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  user_id uuid NOT NULL,
  branch_id uuid,           -- NULL = all branches (shop-wide)
  role_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, user_id) REFERENCES users(shop_id, id),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branch(shop_id, id),
  FOREIGN KEY (shop_id, role_id) REFERENCES role(shop_id, id)
);
CREATE UNIQUE INDEX ubr_unique ON user_branch_role (user_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), role_id);

CREATE TABLE terminal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  name text NOT NULL,
  prefix text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, prefix),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branch(shop_id, id)
);

-- One counter row per terminal: tills never contend with each other.
CREATE TABLE invoice_sequence (
  shop_id uuid NOT NULL,
  terminal_id uuid PRIMARY KEY,
  next bigint NOT NULL DEFAULT 1,
  FOREIGN KEY (shop_id, terminal_id) REFERENCES terminal(shop_id, id)
);

CREATE TABLE refresh_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  user_id uuid NOT NULL,
  family_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  terminal_id uuid,
  branch_id uuid,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, user_id) REFERENCES users(shop_id, id)
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  shop_id uuid,
  actor_id uuid,
  actor_type text NOT NULL DEFAULT 'user',
  approver_id uuid,
  action text NOT NULL,
  entity text,
  entity_id text,
  old_value jsonb,
  new_value jsonb,
  terminal_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_shop_time ON audit_log (shop_id, created_at DESC);

CREATE TABLE idempotency_key (
  shop_id uuid NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status_code int,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, key)
);

CREATE TABLE outbox_event (
  id bigserial PRIMARY KEY,
  shop_id uuid,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts int NOT NULL DEFAULT 0
);
CREATE INDEX outbox_unprocessed ON outbox_event (id) WHERE processed_at IS NULL;

CREATE TABLE job (
  id bigserial PRIMARY KEY,
  shop_id uuid,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  run_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','dead')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  last_error text,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz
);
CREATE UNIQUE INDEX job_dedupe ON job (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running');
CREATE INDEX job_due ON job (run_at) WHERE status = 'queued';

-- ---------- Row-Level Security ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branch','role','users','user_branch_role','terminal','invoice_sequence','refresh_token','idempotency_key']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (shop_id = app_shop()) WITH CHECK (shop_id = app_shop())', t);
  END LOOP;
END $$;

-- shop: a tenant sees only itself; the platform sees all.
ALTER TABLE shop ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_select ON shop FOR SELECT USING (id = app_shop() OR app_is_platform());
CREATE POLICY shop_insert ON shop FOR INSERT WITH CHECK (app_is_platform());
CREATE POLICY shop_update ON shop FOR UPDATE USING (id = app_shop() OR app_is_platform())
  WITH CHECK (id = app_shop() OR app_is_platform());

-- Platform-controlled data: tenants can read their own rows, only the platform can write.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscription','shop_feature_override','shop_limit_override']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT USING (shop_id = app_shop() OR app_is_platform())', t);
    EXECUTE format('CREATE POLICY platform_write ON %I FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform())', t);
  END LOOP;
END $$;

-- audit / outbox / job: tenant rows by shop; platform sees everything (shop_id NULL = platform events).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_log','outbox_event','job']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_or_platform ON %I USING (shop_id = app_shop() OR app_is_platform()) WITH CHECK (shop_id = app_shop() OR app_is_platform())', t);
  END LOOP;
END $$;

-- ---------- pre-session lookups (login / refresh) ----------
-- These must find a row before the shop is known, so they bypass RLS in a controlled way.
CREATE FUNCTION auth_find_user(p_email text)
RETURNS TABLE (id uuid, shop_id uuid, name text, password_hash text, status text, must_change_password boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS
$$ SELECT u.id, u.shop_id, u.name, u.password_hash, u.status, u.must_change_password
   FROM users u WHERE lower(u.email) = lower(p_email) $$;

CREATE FUNCTION auth_find_refresh(p_hash text)
RETURNS TABLE (id uuid, shop_id uuid, user_id uuid, family_id uuid, terminal_id uuid, branch_id uuid, expires_at timestamptz, revoked_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS
$$ SELECT r.id, r.shop_id, r.user_id, r.family_id, r.terminal_id, r.branch_id, r.expires_at, r.revoked_at
   FROM refresh_token r WHERE r.token_hash = p_hash $$;

-- Revoke an entire refresh-token family (reuse detection) before the shop context is known.
CREATE FUNCTION auth_revoke_family(p_family uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS
$$ UPDATE refresh_token SET revoked_at = now() WHERE family_id = p_family AND revoked_at IS NULL $$;

REVOKE ALL ON FUNCTION auth_find_user(text), auth_find_refresh(text), auth_revoke_family(uuid) FROM PUBLIC;
