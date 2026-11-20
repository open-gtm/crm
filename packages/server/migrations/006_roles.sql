-- Configurable roles. A role is a named set of permissions from the fixed catalog in
-- core/context.ts (PERMISSIONS). Every member and service account holds exactly one role.
-- The four system roles are seeded per tenant; upgrades may change them, so the app never edits them.

CREATE TABLE roles (
  tenant_id   uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id          uuid NOT NULL,
  -- A slug. Never `role_…`, so a role key can't be mistaken for a role ID.
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$' AND key !~ '^role_'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  permissions text[] NOT NULL CHECK (permissions <@ ARRAY[
    'records:read', 'records:write', 'records:archive', 'restricted:read', 'schema:manage', 'members:manage',
    'roles:manage', 'keys:manage', 'webhooks:manage', 'automations:manage', 'alerts:manage', 'audit:read']::text[]),
  -- Permissions that reach record data need the record permissions they reach (PERMISSION_REQUIRES).
  CONSTRAINT roles_permission_requires CHECK (
    (NOT permissions @> '{automations:manage}' OR permissions @> '{records:read,records:write,records:archive}')
    AND (NOT permissions @> '{webhooks:manage}' OR permissions @> '{records:read}')
    AND (NOT permissions @> '{alerts:manage}' OR permissions @> '{records:read}')),
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NULL,
  archived_at timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK (NOT (is_system AND archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX roles_key ON roles (tenant_id, key) WHERE archived_at IS NULL;
CREATE TRIGGER roles_touch BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
SELECT app.enable_tenant_rls('roles');

-- Seeds the system roles for the current tenant (app.tenant_id). Kept in step with SYSTEM_ROLES.
CREATE OR REPLACE FUNCTION app.seed_system_roles() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE everything text[] := ARRAY['records:read', 'records:write', 'records:archive', 'restricted:read', 'schema:manage',
  'members:manage', 'roles:manage', 'keys:manage', 'webhooks:manage', 'automations:manage', 'alerts:manage', 'audit:read'];
BEGIN
  INSERT INTO roles (tenant_id, id, key, name, description, permissions, is_system) VALUES
    (app.tenant_id(), gen_random_uuid(), 'owner', 'Owner', 'Full access. Only an owner can grant or remove the owner role.', everything, true),
    (app.tenant_id(), gen_random_uuid(), 'admin', 'Admin', 'Full access to data and configuration.', everything, true),
    (app.tenant_id(), gen_random_uuid(), 'member', 'Member', 'Works with records.',
      ARRAY['records:read', 'records:write', 'records:archive', 'restricted:read'], true),
    (app.tenant_id(), gen_random_uuid(), 'read_only', 'Read only', 'Reads records.', ARRAY['records:read', 'restricted:read'], true)
  ON CONFLICT DO NOTHING;
END $$;

ALTER TABLE users ADD COLUMN role_id uuid NULL;
ALTER TABLE service_accounts ADD COLUMN role_id uuid NULL;

-- Backfill tenant by tenant. This runs as the table owner, which FORCE ROW LEVEL SECURITY
-- still binds, so each tenant's rows are only visible with that tenant set.
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT tenant_id FROM tenant_directory LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM app.seed_system_roles();
    UPDATE users u SET role_id = r.id FROM roles r WHERE r.tenant_id = u.tenant_id AND r.key = u.role AND r.is_system;
    UPDATE service_accounts s SET role_id = r.id FROM roles r WHERE r.tenant_id = s.tenant_id AND r.key = s.role AND r.is_system;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- Validating a new foreign key runs a query that RLS would limit to one tenant (or fail without
-- one), so RLS is relaxed for the owner only while the keys are added. This is all one transaction:
-- no other session ever sees these tables unforced.
ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
ALTER TABLE service_accounts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE users ALTER COLUMN role_id SET NOT NULL,
  ADD FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id),
  DROP COLUMN role;
ALTER TABLE service_accounts ALTER COLUMN role_id SET NOT NULL,
  ADD FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id),
  DROP COLUMN role;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE service_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE INDEX users_role ON users (tenant_id, role_id);
CREATE INDEX service_accounts_role ON service_accounts (tenant_id, role_id);
