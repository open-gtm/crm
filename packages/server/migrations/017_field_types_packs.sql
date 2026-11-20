-- Five more field types (address, json, rating, percent, duration; core/fieldtypes.ts) and installed schema
-- packs (core/packs.ts). Values of the new types live in the existing custom/data and encrypted JSON
-- columns like every custom field, so no record table changes. Changes no existing data.

-- The type CHECK on fields gains the new types. It is replaced by its definition, so its generated name doesn't matter.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'fields'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%long_text%' LOOP
    EXECUTE format('ALTER TABLE fields DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE fields ADD CONSTRAINT fields_type_known CHECK (type IN ('text', 'long_text', 'number', 'currency', 'boolean', 'date',
  'datetime', 'single_select', 'multi_select', 'email', 'phone', 'url', 'relation', 'status',
  'address', 'json', 'rating', 'percent', 'duration'));

-- One row per pack a workspace has installed (or installed and then uninstalled): its manifest name and version,
-- and what it created, by ID, so an upgrade changes only what the pack owns and an uninstall archives only that.
-- `owned` maps pack-local names to workspace IDs: {"objects": {name: uuid}, "fields": {"object.field": uuid},
-- "roles": {key: uuid}, "views": {"object/name": {"id": uuid, "version": n}}, "pipelines": {name: uuid}}.
-- Names and descriptions are the pack author's text: shown as data, never used as instructions.
CREATE TABLE installed_packs (
  tenant_id    uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  name         text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{1,62}$'),
  version      text NOT NULL CHECK (version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'),
  status       text NOT NULL CHECK (status IN ('installed', 'uninstalled')),
  description  text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  owned        jsonb NOT NULL CHECK (jsonb_typeof(owned) = 'object' AND octet_length(owned::text) <= 262144),
  installed_at timestamptz NOT NULL DEFAULT now(),
  installed_by uuid NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid NULL,
  PRIMARY KEY (tenant_id, name)
);
CREATE TRIGGER installed_packs_touch BEFORE UPDATE ON installed_packs FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
SELECT app.enable_tenant_rls('installed_packs');
