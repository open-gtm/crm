-- Platform tables: tenants, identities, API keys, audit log, idempotency, outbox.
-- Runs as hlcrm_migrator (owner). The app connects as hlcrm_app, which is subject to RLS.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS app;

-- The current tenant. Raises when unset, so a query that forgets tenant context fails
-- instead of silently matching nothing (or everything).
CREATE OR REPLACE FUNCTION app.tenant_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE v text := current_setting('app.tenant_id', true);
BEGIN
  IF v IS NULL OR v = '' THEN
    RAISE EXCEPTION 'app.tenant_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v::uuid;
END $$;

-- Enables and forces RLS on a tenant table with the standard isolation policy.
CREATE OR REPLACE FUNCTION app.enable_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())',
    tbl);
END $$;

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Tenant IDs only, without RLS, so background workers can enumerate tenants.
-- Holds no customer data. See docs/decisions/0002-tenant-directory.md.
CREATE TABLE tenant_directory (
  tenant_id  uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  tenant_id         uuid PRIMARY KEY REFERENCES tenant_directory (tenant_id),
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind              text NOT NULL DEFAULT 'production' CHECK (kind IN ('production', 'sandbox')),
  parent_tenant_id  uuid NULL,
  currency          char(3) NOT NULL DEFAULT 'USD',
  modules           text[] NOT NULL DEFAULT ARRAY['core', 'sales'],
  lifecycle_options jsonb NOT NULL DEFAULT '{}',
  schema_version    bigint NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('tenants');

CREATE TABLE users (
  tenant_id   uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id          uuid NOT NULL,
  email       citext NOT NULL,
  name        text NOT NULL,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'read_only')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, email)
);
SELECT app.enable_tenant_rls('users');

CREATE TABLE service_accounts (
  tenant_id   uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id          uuid NOT NULL,
  name        text NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin', 'member', 'read_only')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NULL,
  disabled_at timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name)
);
SELECT app.enable_tenant_rls('service_accounts');

CREATE TABLE api_keys (
  tenant_id    uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id           uuid NOT NULL,
  owner_type   text NOT NULL CHECK (owner_type IN ('user', 'service_account')),
  owner_id     uuid NOT NULL,
  name         text NOT NULL,
  lookup       text NOT NULL UNIQUE,           -- public part of the key, used to find the row
  secret_hash  bytea NOT NULL,                 -- SHA-256 of the full key; the key itself is never stored
  scopes       text[] NOT NULL,
  environment  text NOT NULL CHECK (environment IN ('live', 'test')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NULL,
  expires_at   timestamptz NULL,
  revoked_at   timestamptz NULL,
  last_used_at timestamptz NULL,
  rotated_from uuid NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK (scopes <@ ARRAY['admin', 'ops:write', 'ops:read', 'restricted:read'])
);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
-- Tenant isolation, plus one narrow exception for authentication: before the tenant is
-- known, a request may read the single row whose lookup value it presents.
-- Permissive policies are OR-ed, so this one must not raise when the tenant is unset.
CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = app.tenant_id());
CREATE POLICY key_lookup ON api_keys FOR SELECT
  USING (lookup = current_setting('app.key_lookup', true));

-- Append-only, hash-chained audit log. Rows are inserted unsealed; the worker seals them
-- in order per tenant (hash = sha256(prev_hash || canonical row)).
CREATE TABLE audit_log (
  seq          bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id    uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id           uuid NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type   text NOT NULL CHECK (actor_type IN ('user', 'service_account', 'system', 'automation', 'integration')),
  actor_id     uuid NULL,
  key_id       uuid NULL,
  surface      text NOT NULL CHECK (surface IN ('api', 'cli', 'admin-mcp', 'ops-mcp', 'automation', 'system')),
  action       text NOT NULL,
  object_type  text NULL,
  record_id    uuid NULL,
  request_id   text NULL,
  details      jsonb NOT NULL DEFAULT '{}',
  prev_hash    bytea NULL,
  hash         bytea NULL,
  sealed_at    timestamptz NULL,
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX audit_log_unsealed ON audit_log (tenant_id, seq) WHERE hash IS NULL;
CREATE INDEX audit_log_record ON audit_log (tenant_id, record_id, occurred_at DESC) WHERE record_id IS NOT NULL;
SELECT app.enable_tenant_rls('audit_log');

CREATE OR REPLACE FUNCTION app.audit_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'audit_log is append-only';
  END IF;
  -- The only permitted update is sealing an unsealed row, once.
  IF OLD.hash IS NOT NULL
     OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.actor_type IS DISTINCT FROM OLD.actor_type OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR NEW.key_id IS DISTINCT FROM OLD.key_id OR NEW.surface IS DISTINCT FROM OLD.surface
     OR NEW.action IS DISTINCT FROM OLD.action OR NEW.object_type IS DISTINCT FROM OLD.object_type
     OR NEW.record_id IS DISTINCT FROM OLD.record_id OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.details IS DISTINCT FROM OLD.details THEN
    RAISE EXCEPTION 'audit_log rows are immutable once written';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_guard BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_log_guard();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_log_guard();

CREATE TABLE audit_anchors (
  tenant_id   uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  seq         bigint NOT NULL,
  hash        bytea NOT NULL,
  location    text NOT NULL,
  anchored_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seq)
);
SELECT app.enable_tenant_rls('audit_anchors');

CREATE TABLE idempotency_keys (
  tenant_id   uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  key_id      uuid NOT NULL,
  idem_key    text NOT NULL CHECK (length(idem_key) BETWEEN 1 AND 255),
  method      text NOT NULL,
  path        text NOT NULL,
  body_hash   bytea NOT NULL,
  status      int NOT NULL,
  response    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key_id, idem_key)
);
CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);
SELECT app.enable_tenant_rls('idempotency_keys');

-- Transactional outbox: written in the same transaction as the change it describes.
CREATE TABLE outbox_events (
  tenant_id       uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id              uuid NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  type            text NOT NULL,
  object_type     text NULL,
  record_id       uuid NULL,
  actor_type      text NOT NULL,
  actor_id        uuid NULL,
  surface         text NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}',
  causation_depth int NOT NULL DEFAULT 0,
  processed_at    timestamptz NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX outbox_unprocessed ON outbox_events (occurred_at) WHERE processed_at IS NULL;
SELECT app.enable_tenant_rls('outbox_events');
