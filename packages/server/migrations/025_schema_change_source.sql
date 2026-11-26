-- Where a schema change came from, beyond its surface: the connected app or API key it came through, by
-- name as it was called then, and the schema pack that made it. Shown in the schema history and beside
-- each field (who last changed it, and through what).
ALTER TABLE schema_changes ADD COLUMN via text NULL CHECK (length(via) <= 200);
ALTER TABLE schema_changes ADD COLUMN pack text NULL CHECK (length(pack) <= 63);
-- The newest change of each field and object, without reading the whole history.
CREATE INDEX schema_changes_by_field ON schema_changes (tenant_id, field_id, version DESC) WHERE field_id IS NOT NULL;
CREATE INDEX schema_changes_by_object ON schema_changes (tenant_id, object_id, version DESC) WHERE object_id IS NOT NULL;
