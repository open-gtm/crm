-- Agent-first record page layouts (ADR 0017): a layout holds components as well as fields, people and
-- agents edit one shared draft per object, and every published version is kept with where it came from.

-- page_layouts stays the published layout, one row per object. A NULL layout is the default page: the
-- row stays so that version numbers keep counting up through a reset.
ALTER TABLE page_layouts ALTER COLUMN layout DROP NOT NULL;

-- Every published version, newest kept (core/layouts.ts trims old ones). `layout` is NULL for a reset to
-- the default page. `contributors` is who changed the draft that became this version, each with its surface.
CREATE TABLE page_layout_versions (
  tenant_id     uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  object_id     uuid NOT NULL,
  version       int NOT NULL,
  layout        jsonb NULL CHECK (layout IS NULL OR (jsonb_typeof(layout) = 'object' AND octet_length(layout::text) <= 65536)),
  summary       text NOT NULL CHECK (length(summary) <= 500),
  changes       jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(changes) = 'array'),
  contributors  jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(contributors) = 'array'),
  restored_from int NULL,
  actor_type    text NOT NULL,
  actor_id      uuid NULL,
  -- web, admin-mcp, cli, api, system; 'unknown' for versions published before this table existed.
  surface       text NOT NULL,
  -- The connected app or API key the change came through, by name, as it was called then.
  via           text NULL CHECK (length(via) <= 200),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, object_id, version),
  FOREIGN KEY (tenant_id, object_id) REFERENCES objects (tenant_id, id)
);
SELECT app.enable_tenant_rls('page_layout_versions');

-- The layouts that exist already become their object's first recorded version. Tenant by tenant: forced
-- row-level security binds the table owner too (as in migration 012).
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT tenant_id FROM tenant_directory LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO page_layout_versions (tenant_id, object_id, version, layout, summary, actor_type, actor_id, surface, created_at)
    SELECT tenant_id, object_id, version, layout, 'Published before layout history was kept', 'user', updated_by, 'unknown', updated_at FROM page_layouts;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- The one draft of an object's layout, shared by everyone who manages the schema, people and agents alike.
-- `revision` counts its changes: a write names the revision it read, so nobody overwrites a change they
-- haven't seen. `base_version` is the published version it started from (0: none).
CREATE TABLE page_layout_drafts (
  tenant_id    uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  object_id    uuid NOT NULL,
  layout       jsonb NOT NULL CHECK (jsonb_typeof(layout) = 'object' AND octet_length(layout::text) <= 65536),
  revision     int NOT NULL DEFAULT 1,
  base_version int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, object_id),
  FOREIGN KEY (tenant_id, object_id) REFERENCES objects (tenant_id, id)
);
CREATE TRIGGER page_layout_drafts_touch BEFORE UPDATE ON page_layout_drafts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
SELECT app.enable_tenant_rls('page_layout_drafts');

-- Each change to a draft: who, through what, what it did, and the draft before and after (so the newest
-- one can be undone). Removed when the draft is published (summarised in the version's contributors) or discarded.
CREATE TABLE page_layout_changes (
  tenant_id   uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id          uuid NOT NULL,
  object_id   uuid NOT NULL,
  revision    int NOT NULL,
  summary     text NOT NULL CHECK (length(summary) <= 500),
  changes     jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(changes) = 'array'),
  -- What the person asked for, in their words, when an agent passes it on.
  note        text NULL CHECK (length(note) <= 500),
  before      jsonb NOT NULL,
  after       jsonb NOT NULL,
  actor_type  text NOT NULL,
  actor_id    uuid NULL,
  surface     text NOT NULL,
  via         text NULL CHECK (length(via) <= 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- A person looked at a change an agent made and kept it.
  reviewed_at timestamptz NULL,
  reviewed_by uuid NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, object_id) REFERENCES page_layout_drafts (tenant_id, object_id) ON DELETE CASCADE
);
CREATE INDEX page_layout_changes_by_object ON page_layout_changes (tenant_id, object_id, revision);
SELECT app.enable_tenant_rls('page_layout_changes');
