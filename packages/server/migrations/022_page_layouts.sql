-- How an object's record page is arranged: named sections, each an ordered list of fields. One layout
-- per object, set by someone who manages the schema and used by everyone who opens a record of it.
-- Fields are kept by ID, so renaming a field keeps its place. An object without a row shows the default page.

CREATE TABLE page_layouts (
  tenant_id  uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  object_id  uuid NOT NULL,
  -- {"sections": [{"title": "…", "fields": ["<field id>", …]}, …]}
  layout     jsonb NOT NULL CHECK (jsonb_typeof(layout) = 'object' AND octet_length(layout::text) <= 65536),
  version    int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL,
  PRIMARY KEY (tenant_id, object_id),
  FOREIGN KEY (tenant_id, object_id) REFERENCES objects (tenant_id, id)
);
CREATE TRIGGER page_layouts_touch BEFORE UPDATE ON page_layouts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
SELECT app.enable_tenant_rls('page_layouts');
