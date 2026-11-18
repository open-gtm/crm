-- Per-object and per-field record access on custom roles (ADR 0008).
--
-- A role's records:read / records:write / records:archive permissions stay the default for every
-- object. role_object_permissions overrides that default for one object, in either direction: NULL
-- inherits it, true grants, false denies. role_field_permissions only restricts: 'none' hides a
-- field, 'read' makes it read-only; no row means the field follows its object's access.
-- Rules are keyed by object and field IDs, so renaming a field or relabelling an object keeps them.

-- Changed by the triggers below whenever a role's rules change. The role is read on every request; the
-- rules are cached per (role, access_version), so a change takes effect on the next request in every process.
-- Values come from a sequence, not access_version + 1: a sequence never hands out a value twice, even
-- when a transaction rolls back, so a version can't name two different sets of rules.
CREATE SEQUENCE role_access_version_seq;
ALTER TABLE roles ADD COLUMN access_version bigint NOT NULL DEFAULT 0;

CREATE TABLE role_object_permissions (
  tenant_id   uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  role_id     uuid NOT NULL,
  object_id   uuid NOT NULL,
  can_read    boolean NULL,
  can_write   boolean NULL,
  can_archive boolean NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid NULL,
  PRIMARY KEY (tenant_id, role_id, object_id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id),
  FOREIGN KEY (tenant_id, object_id) REFERENCES objects (tenant_id, id),
  -- A row that inherits everything says nothing; the app deletes it instead.
  CHECK (can_read IS NOT NULL OR can_write IS NOT NULL OR can_archive IS NOT NULL)
);
CREATE INDEX role_object_permissions_object ON role_object_permissions (tenant_id, object_id);
SELECT app.enable_tenant_rls('role_object_permissions');

CREATE TABLE role_field_permissions (
  tenant_id  uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  role_id    uuid NOT NULL,
  field_id   uuid NOT NULL,
  access     text NOT NULL CHECK (access IN ('none', 'read')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL,
  PRIMARY KEY (tenant_id, role_id, field_id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id),
  FOREIGN KEY (tenant_id, field_id) REFERENCES fields (tenant_id, id)
);
CREATE INDEX role_field_permissions_field ON role_field_permissions (tenant_id, field_id);
SELECT app.enable_tenant_rls('role_field_permissions');

-- Any change to a role's rules, however it is made (the app, a manual fix, a later migration), moves the
-- role to a new access_version, so no process keeps serving the old rules from its cache. Runs as the
-- caller: the app role may update roles, and the row is in the tenant the change was made in.
CREATE OR REPLACE FUNCTION app.bump_role_access_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE roles SET access_version = nextval('role_access_version_seq') WHERE tenant_id = OLD.tenant_id AND id = OLD.role_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE roles SET access_version = nextval('role_access_version_seq') WHERE tenant_id = NEW.tenant_id AND id = NEW.role_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER role_object_permissions_version AFTER INSERT OR UPDATE OR DELETE ON role_object_permissions
  FOR EACH ROW EXECUTE FUNCTION app.bump_role_access_version();
CREATE TRIGGER role_field_permissions_version AFTER INSERT OR UPDATE OR DELETE ON role_field_permissions
  FOR EACH ROW EXECUTE FUNCTION app.bump_role_access_version();

-- Automations, webhooks and alert backtests run with full record access, and schema management shows
-- per-field value counts and whether objects hold data, so a role that holds any of those permissions
-- must have full record access too: no denying object rule and no field rule. The app refuses such a
-- role with a clear error; this is the backstop. Deferred to commit, so one transaction can change a
-- role's permissions and its rules in either order.
CREATE OR REPLACE FUNCTION app.check_record_managers_unrestricted() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE rid uuid;
BEGIN
  IF TG_TABLE_NAME = 'roles' THEN
    rid := NEW.id;
  ELSE
    rid := NEW.role_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM roles r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = rid
      AND r.permissions && '{automations:manage,webhooks:manage,alerts:manage,schema:manage}'::text[]
      AND (EXISTS (SELECT 1 FROM role_object_permissions o WHERE o.tenant_id = r.tenant_id AND o.role_id = r.id
                     AND (o.can_read IS FALSE OR o.can_write IS FALSE OR o.can_archive IS FALSE))
           OR EXISTS (SELECT 1 FROM role_field_permissions f WHERE f.tenant_id = r.tenant_id AND f.role_id = r.id))
  ) THEN
    RAISE EXCEPTION 'a role that manages automations, webhooks, alerts or the schema must have unrestricted record access'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'roles_record_managers_unrestricted';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER roles_record_managers_unrestricted AFTER INSERT OR UPDATE OF permissions ON roles
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_record_managers_unrestricted();
CREATE CONSTRAINT TRIGGER role_object_permissions_managers AFTER INSERT OR UPDATE ON role_object_permissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_record_managers_unrestricted();
CREATE CONSTRAINT TRIGGER role_field_permissions_managers AFTER INSERT OR UPDATE ON role_field_permissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_record_managers_unrestricted();
