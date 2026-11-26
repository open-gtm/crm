-- Connections (ADR 0016): a named credential for one outside host, which an automation's http_request
-- step names instead of carrying its own secret. Three types: a token as written, OAuth client credentials,
-- and an OAuth refresh token. Secrets and the cached access token are encrypted with the tenant's data key.

-- connections:manage joins the permission catalog (core/context.ts PERMISSIONS), as views:manage did in
-- migration 012: the catalog CHECK is replaced, the system-role seed grants it to owner and admin, and
-- existing owner and admin roles get it.
ALTER TABLE roles DROP CONSTRAINT roles_permissions_catalog;
ALTER TABLE roles ADD CONSTRAINT roles_permissions_catalog CHECK (permissions <@ ARRAY[
  'records:read', 'records:write', 'records:archive', 'restricted:read', 'schema:manage', 'members:manage',
  'roles:manage', 'keys:manage', 'webhooks:manage', 'automations:manage', 'alerts:manage', 'audit:read', 'views:manage',
  'connections:manage']::text[]);

-- Kept in step with SYSTEM_ROLES.
CREATE OR REPLACE FUNCTION app.seed_system_roles() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE everything text[] := ARRAY['records:read', 'records:write', 'records:archive', 'restricted:read', 'schema:manage',
  'members:manage', 'roles:manage', 'keys:manage', 'webhooks:manage', 'automations:manage', 'alerts:manage', 'audit:read', 'views:manage',
  'connections:manage'];
BEGIN
  INSERT INTO roles (tenant_id, id, key, name, description, permissions, is_system) VALUES
    (app.tenant_id(), gen_random_uuid(), 'owner', 'Owner', 'Full access. Only an owner can grant or remove the owner role.', everything, true),
    (app.tenant_id(), gen_random_uuid(), 'admin', 'Admin', 'Full access to data and configuration.', everything, true),
    (app.tenant_id(), gen_random_uuid(), 'member', 'Member', 'Works with records.',
      ARRAY['records:read', 'records:write', 'records:archive', 'restricted:read'], true),
    (app.tenant_id(), gen_random_uuid(), 'read_only', 'Read only', 'Reads records.', ARRAY['records:read', 'restricted:read'], true)
  ON CONFLICT DO NOTHING;
END $$;

-- Tenant by tenant, for the reasons given in migration 012.
SET CONSTRAINTS roles_record_managers_unrestricted IMMEDIATE;
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT tenant_id FROM tenant_directory LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE roles SET permissions = permissions || '{connections:manage}'::text[]
      WHERE is_system AND key IN ('owner', 'admin') AND NOT permissions @> '{connections:manage}';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

CREATE TABLE connections (
  tenant_id               uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id                      uuid NOT NULL,
  -- The name steps use ("connection": "salesforce"). It never changes: steps keep it.
  key                     text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name                    text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description             text NULL CHECK (length(description) <= 2000),
  type                    text NOT NULL CHECK (type IN ('static_token', 'oauth_client_credentials', 'oauth_refresh_token')),
  -- https origin and an optional path prefix, no trailing slash. The credential is only sent under it.
  base_url                text NOT NULL CHECK (length(base_url) <= 500),
  header_name             text NOT NULL DEFAULT 'Authorization' CHECK (length(header_name) <= 100),
  header_prefix           text NOT NULL DEFAULT 'Bearer ' CHECK (length(header_prefix) <= 40),
  -- OAuth types only.
  token_url               text NULL CHECK (length(token_url) <= 500),
  client_id               text NULL CHECK (length(client_id) <= 500),
  scope                   text NULL CHECK (length(scope) <= 1000),
  token_params            jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(token_params) = 'object'),
  -- Used when a token reply has no expires_in.
  token_lifetime_minutes  int NOT NULL DEFAULT 30 CHECK (token_lifetime_minutes BETWEEN 1 AND 1440),
  test_path               text NULL CHECK (length(test_path) <= 500),
  secret                  text NULL,   -- encrypted: the token (static_token) or the client secret
  secret_set_at           timestamptz NULL,
  refresh_token           text NULL,   -- encrypted
  refresh_token_set_at    timestamptz NULL,
  access_token            text NULL,   -- encrypted: the cached access token
  access_token_expires_at timestamptz NULL,
  access_token_fetched_at timestamptz NULL,
  enabled                 boolean NOT NULL DEFAULT true,
  last_used_at            timestamptz NULL,
  last_error              text NULL CHECK (length(last_error) <= 300),
  last_error_at           timestamptz NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid NULL,
  -- Set when a person changes the connection, not when a token is cached or it is used.
  updated_at              timestamptz NOT NULL DEFAULT now(),
  archived_at             timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK ((type = 'static_token') = (token_url IS NULL))
);
CREATE UNIQUE INDEX connections_key ON connections (tenant_id, key) WHERE archived_at IS NULL;
SELECT app.enable_tenant_rls('connections');
