-- Read-side features for list, board and saved-filter UIs: saved views, per-member preferences, and the
-- views:manage permission that creating or changing a shared view needs.

-- views:manage joins the permission catalog (core/context.ts PERMISSIONS). The catalog CHECK on
-- roles.permissions is replaced (found by its definition, so its generated name doesn't matter), the
-- system-role seed function grants it to owner and admin, and existing owner and admin roles get it.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'roles'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%audit:read%'
             AND conname <> 'roles_permission_requires' LOOP
    EXECUTE format('ALTER TABLE roles DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE roles ADD CONSTRAINT roles_permissions_catalog CHECK (permissions <@ ARRAY[
  'records:read', 'records:write', 'records:archive', 'restricted:read', 'schema:manage', 'members:manage',
  'roles:manage', 'keys:manage', 'webhooks:manage', 'automations:manage', 'alerts:manage', 'audit:read', 'views:manage']::text[]);

-- Kept in step with SYSTEM_ROLES.
CREATE OR REPLACE FUNCTION app.seed_system_roles() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE everything text[] := ARRAY['records:read', 'records:write', 'records:archive', 'restricted:read', 'schema:manage',
  'members:manage', 'roles:manage', 'keys:manage', 'webhooks:manage', 'automations:manage', 'alerts:manage', 'audit:read', 'views:manage'];
BEGIN
  INSERT INTO roles (tenant_id, id, key, name, description, permissions, is_system) VALUES
    (app.tenant_id(), gen_random_uuid(), 'owner', 'Owner', 'Full access. Only an owner can grant or remove the owner role.', everything, true),
    (app.tenant_id(), gen_random_uuid(), 'admin', 'Admin', 'Full access to data and configuration.', everything, true),
    (app.tenant_id(), gen_random_uuid(), 'member', 'Member', 'Works with records.',
      ARRAY['records:read', 'records:write', 'records:archive', 'restricted:read'], true),
    (app.tenant_id(), gen_random_uuid(), 'read_only', 'Read only', 'Reads records.', ARRAY['records:read', 'restricted:read'], true)
  ON CONFLICT DO NOTHING;
END $$;

-- Tenant by tenant: FORCE ROW LEVEL SECURITY binds the table owner too. The deferred check that roles
-- managing record work are unrestricted (migration 008) runs per statement here, while each tenant is
-- set; at commit no tenant is set and it could not read the rows.
SET CONSTRAINTS roles_record_managers_unrestricted IMMEDIATE;
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT tenant_id FROM tenant_directory LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE roles SET permissions = permissions || '{views:manage}'::text[]
      WHERE is_system AND key IN ('owner', 'admin') AND NOT permissions @> '{views:manage}';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- A saved view: an object, a filter, a sort, the columns to show and an optional grouping. Personal views
-- have an owner (a user or service account) and are seen only by them; shared views have none and are
-- seen by everyone who can read the object. A view is never a grant: it runs with the reader's access.
-- Field names are kept as written (the filter language uses names), so a renamed or archived field makes
-- the view fail with a clear error when it runs; the object is kept by ID. View IDs are v_…: one letter,
-- which no object's id_prefix can be (the CHECK on objects.id_prefix), so they never collide with records.
CREATE TABLE views (
  tenant_id   uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id          uuid NOT NULL,
  object_id   uuid NOT NULL,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  shared      boolean NOT NULL,
  owner_type  text NULL CHECK (owner_type IN ('user', 'service_account')),
  owner_id    uuid NULL,
  definition  jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 32768),
  created_by  uuid NULL,
  updated_by  uuid NULL, -- who last changed it: anyone with views:manage can change a shared view
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, object_id) REFERENCES objects (tenant_id, id),
  CHECK ((shared AND owner_id IS NULL AND owner_type IS NULL) OR (NOT shared AND owner_id IS NOT NULL AND owner_type IS NOT NULL))
);
CREATE INDEX views_object ON views (tenant_id, object_id);
CREATE INDEX views_owner ON views (tenant_id, owner_id) WHERE owner_id IS NOT NULL;
CREATE TRIGGER views_touch BEFORE UPDATE ON views FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
SELECT app.enable_tenant_rls('views');

-- Per-member UI state (column widths, the last view opened, …): small JSON values under validated keys.
-- Not for secrets; the app refuses values that look like API keys.
CREATE TABLE member_preferences (
  tenant_id   uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  member_type text NOT NULL CHECK (member_type IN ('user', 'service_account')),
  member_id   uuid NOT NULL,
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  value       jsonb NOT NULL CHECK (octet_length(value::text) <= 8192),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, member_type, member_id, key)
);
SELECT app.enable_tenant_rls('member_preferences');
