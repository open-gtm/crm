-- Metadata engine: object and field definitions, schema history, custom records,
-- the record registry (one row per record of any type), and tenant data keys.

CREATE TABLE objects (
  tenant_id     uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id            uuid NOT NULL,
  api_name      text NOT NULL CHECK (api_name ~ '^[a-z][a-z0-9_]{1,62}$'),
  label         text NOT NULL,
  plural_label  text NOT NULL,
  description   text NOT NULL DEFAULT '',
  id_prefix     text NOT NULL CHECK (id_prefix ~ '^[a-z]{2,8}$'),
  module        text NULL,             -- null for custom objects
  is_system     boolean NOT NULL DEFAULT false,
  table_name    text NULL,             -- set for standard objects only; custom objects live in records
  display_field text NULL,             -- field api_name used as the record's title
  owned         boolean NOT NULL DEFAULT false,
  hidden        boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, api_name),
  UNIQUE (tenant_id, id_prefix),
  CHECK (is_system = (table_name IS NOT NULL))
);
SELECT app.enable_tenant_rls('objects');

CREATE TABLE fields (
  tenant_id     uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id            uuid NOT NULL,
  object_id     uuid NOT NULL,
  api_name      text NOT NULL CHECK (api_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  storage_key   text NOT NULL,         -- key inside custom/data JSON; never changes, so renames are free
  label         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  type          text NOT NULL CHECK (type IN ('text', 'long_text', 'number', 'currency', 'boolean', 'date',
                                              'datetime', 'single_select', 'multi_select', 'email', 'phone',
                                              'url', 'relation', 'status')),
  is_system     boolean NOT NULL DEFAULT false,
  column_name   text NULL,             -- typed column for core fields of standard objects
  read_only     boolean NOT NULL DEFAULT false,
  required      boolean NOT NULL DEFAULT false,
  is_unique     boolean NOT NULL DEFAULT false,
  default_value jsonb NULL,
  validation    jsonb NOT NULL DEFAULT '{}',
  options       jsonb NOT NULL DEFAULT '{}',
  sensitivity   text NOT NULL DEFAULT 'standard' CHECK (sensitivity IN ('standard', 'confidential', 'restricted')),
  hidden        boolean NOT NULL DEFAULT false,
  position      int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, object_id) REFERENCES objects (tenant_id, id),
  UNIQUE (tenant_id, object_id, storage_key)
);
CREATE UNIQUE INDEX fields_active_api_name ON fields (tenant_id, object_id, api_name) WHERE archived_at IS NULL;
SELECT app.enable_tenant_rls('fields');

CREATE TABLE schema_changes (
  tenant_id   uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  version     bigint NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  actor_type  text NOT NULL,
  actor_id    uuid NULL,
  surface     text NOT NULL,
  change_type text NOT NULL,
  object_id   uuid NULL,
  field_id    uuid NULL,
  before      jsonb NULL,
  after       jsonb NULL,
  PRIMARY KEY (tenant_id, version)
);
SELECT app.enable_tenant_rls('schema_changes');

-- Every record of every object type, so "link to any record" has real foreign keys.
CREATE TABLE record_registry (
  tenant_id uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id        uuid NOT NULL,
  object_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, object_id) REFERENCES objects (tenant_id, id)
);
SELECT app.enable_tenant_rls('record_registry');

-- Registers a row of a standard table. TG_ARGV[0] is the object's api_name.
CREATE OR REPLACE FUNCTION app.register_record() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE oid uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT o.id INTO oid FROM objects o WHERE o.tenant_id = NEW.tenant_id AND o.api_name = TG_ARGV[0];
    IF oid IS NULL THEN
      RAISE EXCEPTION 'object % is not registered for this tenant', TG_ARGV[0];
    END IF;
    INSERT INTO record_registry (tenant_id, id, object_id) VALUES (NEW.tenant_id, NEW.id, oid);
    RETURN NEW;
  END IF;
  DELETE FROM record_registry WHERE tenant_id = OLD.tenant_id AND id = OLD.id;
  RETURN OLD;
END $$;

-- Custom object records.
CREATE TABLE records (
  tenant_id   uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id          uuid NOT NULL,
  object_id   uuid NOT NULL,
  owner_id    uuid NULL,
  data        jsonb NOT NULL DEFAULT '{}',
  encrypted   jsonb NOT NULL DEFAULT '{}',
  search_text text NOT NULL DEFAULT '',
  external_ids jsonb NOT NULL DEFAULT '{}',
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid NULL,
  archived_at timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, object_id) REFERENCES objects (tenant_id, id),
  FOREIGN KEY (tenant_id, id) REFERENCES record_registry (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX records_object_updated ON records (tenant_id, object_id, updated_at DESC);
CREATE INDEX records_data ON records USING gin (data jsonb_path_ops);
CREATE INDEX records_search ON records USING gin (search_text gin_trgm_ops);
SELECT app.enable_tenant_rls('records');

-- Values of custom relation fields, on any object.
CREATE TABLE record_links (
  tenant_id         uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  field_id          uuid NOT NULL,
  from_id           uuid NOT NULL,
  to_id             uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NULL,
  PRIMARY KEY (tenant_id, field_id, from_id, to_id),
  FOREIGN KEY (tenant_id, field_id) REFERENCES fields (tenant_id, id),
  FOREIGN KEY (tenant_id, from_id) REFERENCES record_registry (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, to_id) REFERENCES record_registry (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX record_links_to ON record_links (tenant_id, to_id);
SELECT app.enable_tenant_rls('record_links');

-- Tenant data keys (DEKs), wrapped by the KeyProvider's key. Never stored unwrapped.
CREATE TABLE tenant_keys (
  tenant_id   uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  version     int NOT NULL,
  provider    text NOT NULL,
  wrapped_key bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz NULL,
  PRIMARY KEY (tenant_id, version)
);
SELECT app.enable_tenant_rls('tenant_keys');
