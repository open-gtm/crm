-- Permission sets (ADR 0013). A member keeps exactly one role, and can also hold any number of
-- permission sets. A permission set is built like a custom role (permissions from the catalog, object
-- rules, field rules) and only adds: a member's access is the union of their role and their sets.
--
-- Sets live in the roles table with kind = 'permission_set', so the rule tables, their triggers
-- (access_version, the unrestricted-managers check) and the catalog CHECKs cover them unchanged.

ALTER TABLE roles ADD COLUMN kind text NOT NULL DEFAULT 'role' CHECK (kind IN ('role', 'permission_set'));
-- System roles are roles; there are no system permission sets.
ALTER TABLE roles ADD CONSTRAINT roles_system_are_roles CHECK (NOT is_system OR kind = 'role');
-- A set's key is never `pset_…`, so a key can't be mistaken for a set ID (as `role_…` for roles).
ALTER TABLE roles ADD CONSTRAINT roles_key_not_pset_id CHECK (key !~ '^pset_');

-- Roles and sets have separate key namespaces.
DROP INDEX roles_key;
CREATE UNIQUE INDEX roles_key ON roles (tenant_id, kind, key) WHERE archived_at IS NULL;
-- The target of member_permission_sets' foreign key, which carries the kind.
CREATE UNIQUE INDEX roles_id_kind ON roles (tenant_id, id, kind);

-- A row never changes kind: a role's members and a set's holders are counted and checked differently.
CREATE OR REPLACE FUNCTION app.refuse_role_kind_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a role or permission set cannot change kind' USING ERRCODE = 'check_violation', CONSTRAINT = 'roles_kind_fixed';
END $$;
CREATE TRIGGER roles_kind_fixed BEFORE UPDATE OF kind ON roles
  FOR EACH ROW WHEN (OLD.kind IS DISTINCT FROM NEW.kind) EXECUTE FUNCTION app.refuse_role_kind_change();

-- A member's role is a role, never a permission set. The app resolves roles by kind; this is the backstop.
-- A role_id that names no row here (another workspace's, or nothing) is left to the foreign key.
CREATE OR REPLACE FUNCTION app.check_member_role_kind() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM roles r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.role_id AND r.kind <> 'role') THEN
    RAISE EXCEPTION 'a member''s role must be a role, not a permission set' USING ERRCODE = 'check_violation', CONSTRAINT = 'member_role_kind';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_role_kind BEFORE INSERT OR UPDATE OF role_id ON users
  FOR EACH ROW EXECUTE FUNCTION app.check_member_role_kind();
CREATE TRIGGER service_accounts_role_kind BEFORE INSERT OR UPDATE OF role_id ON service_accounts
  FOR EACH ROW EXECUTE FUNCTION app.check_member_role_kind();

-- Which members hold which sets. One row per member and set; the member is a user or a service account.
CREATE TABLE member_permission_sets (
  tenant_id          uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  permission_set_id  uuid NOT NULL,
  -- Always 'permission_set': part of the foreign key, so a role can never be assigned as a set.
  kind               text NOT NULL DEFAULT 'permission_set' CHECK (kind = 'permission_set'),
  user_id            uuid NULL,
  service_account_id uuid NULL,
  assigned_at        timestamptz NOT NULL DEFAULT now(),
  assigned_by        uuid NULL,
  CHECK (num_nonnulls(user_id, service_account_id) = 1),
  FOREIGN KEY (tenant_id, permission_set_id, kind) REFERENCES roles (tenant_id, id, kind),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, service_account_id) REFERENCES service_accounts (tenant_id, id)
);
CREATE UNIQUE INDEX member_permission_sets_user ON member_permission_sets (tenant_id, user_id, permission_set_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX member_permission_sets_service_account ON member_permission_sets (tenant_id, service_account_id, permission_set_id)
  WHERE service_account_id IS NOT NULL;
CREATE INDEX member_permission_sets_set ON member_permission_sets (tenant_id, permission_set_id);
SELECT app.enable_tenant_rls('member_permission_sets');
