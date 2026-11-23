-- The owner of a custom object's records, as a field and as a reference to a member.
--
-- An owned custom object kept each record's owner in records.owner_id, but had no `owner` field: the
-- owner could not be set, filtered, sorted or shown in a view, as it can on contacts or deals. And
-- unlike the standard tables' owner_id (003), the column had no foreign key to users.

-- 1. The field. Each owned custom object gets the `owner` field that createObject (core/schema.ts) now
--    adds to new ones: a relation to a member, kept in records.owner_id. An object that already has a
--    custom field named "owner" keeps that field and gains none (field names are unique per object).
--    Each field added is a schema change like any other: its own schema_version and schema_changes
--    row. Tenant by tenant: FORCE ROW LEVEL SECURITY binds the table owner too.
DO $$
DECLARE
  t uuid;
  o record;
  fid uuid;
  v bigint;
BEGIN
  FOR t IN SELECT tenant_id FROM tenant_directory LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    FOR o IN
      SELECT ob.id FROM objects ob
      WHERE ob.owned AND NOT ob.is_system
        AND NOT EXISTS (SELECT 1 FROM fields f WHERE f.object_id = ob.id
                        AND (f.storage_key = 'sys_owner_id' OR (f.api_name = 'owner' AND f.archived_at IS NULL)))
      ORDER BY ob.created_at, ob.id
    LOOP
      fid := gen_random_uuid();
      INSERT INTO fields (tenant_id, id, object_id, api_name, storage_key, label, description, type, is_system, column_name, options, position)
      VALUES (t, fid, o.id, 'owner', 'sys_owner_id', 'Owner', 'The user who owns this record.', 'relation', true, 'owner_id',
              '{"to": "user", "cardinality": "many_to_one"}',
              (SELECT coalesce(max(position), -1) + 1 FROM fields WHERE object_id = o.id));
      UPDATE tenants SET schema_version = schema_version + 1 RETURNING schema_version INTO v;
      INSERT INTO schema_changes (tenant_id, version, actor_type, actor_id, surface, change_type, object_id, field_id, after)
      VALUES (t, v, 'system', NULL, 'system', 'field_added', o.id, fid,
              '{"api_name": "owner", "type": "relation", "required": false, "sensitivity": "standard", "options": {"to": "user", "cardinality": "many_to_one"}}');
    END LOOP;
    -- An owner that is no member of the workspace would fail the key below. None is expected: the
    -- server only ever wrote a member's ID here. Such a value names no one, so it is cleared.
    UPDATE records r SET owner_id = NULL
    WHERE r.owner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = r.owner_id);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- 2. The reference. Validating a new foreign key runs a query that RLS would limit to one tenant (or
--    fail without one), so RLS is relaxed for the owner only while the key is added (as in 006). This
--    is all one transaction: no other session ever sees these tables unforced.
ALTER TABLE records NO FORCE ROW LEVEL SECURITY;
ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
ALTER TABLE records ADD CONSTRAINT records_owner_fkey FOREIGN KEY (tenant_id, owner_id) REFERENCES users (tenant_id, id);
ALTER TABLE records FORCE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

-- "Mine" lists and filters by owner, per object (as accounts_owner and its like do for standard objects).
CREATE INDEX records_owner ON records (tenant_id, object_id, owner_id) WHERE owner_id IS NOT NULL;
