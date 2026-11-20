-- Record merges (core/merge.ts): one row per merge, so a merged record's ID still says where it went,
-- and so a later unmerge has what it needs: which survivor fields came from which record, the
-- survivor's values before the merge (encrypted with the workspace key, like restricted values), and
-- every reference that was moved. Also single-use confirm tokens, and the one path that may move a
-- reference on a protected row. Changes no existing data.

CREATE TABLE merges (
  tenant_id       uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id              uuid NOT NULL,
  object_id       uuid NOT NULL,
  survivor_id     uuid NOT NULL,
  merged_ids      uuid[] NOT NULL CHECK (cardinality(merged_ids) BETWEEN 1 AND 10),
  field_sources   jsonb NOT NULL DEFAULT '{}',   -- field api_name -> the record (UUID) its value came from
  survivor_before text NULL,                     -- encrypted JSON of the survivor's previous values for those fields
  repointed       jsonb NOT NULL DEFAULT '[]',   -- per table and column: the rows moved, archived, deleted or cleared
  merged_by       uuid NULL,
  merged_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, object_id) REFERENCES objects (tenant_id, id),
  FOREIGN KEY (tenant_id, survivor_id) REFERENCES record_registry (tenant_id, id),
  CHECK (NOT survivor_id = ANY (merged_ids))
);
CREATE INDEX merges_merged ON merges USING gin (merged_ids);
CREATE INDEX merges_survivor ON merges (tenant_id, survivor_id);
SELECT app.enable_tenant_rls('merges');

-- History: a merge row is never changed after it is written.
CREATE OR REPLACE FUNCTION app.merges_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'merges are append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER merges_append_only BEFORE UPDATE ON merges FOR EACH ROW EXECUTE FUNCTION app.merges_append_only();

-- Confirm tokens (bulk changes and merges) are single-use: a run stores the token's hash here, so the
-- same token can't apply again before it expires. The worker's retention pass drops expired rows.
CREATE TABLE confirm_tokens (
  tenant_id  uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  token_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, token_hash)
);
CREATE INDEX confirm_tokens_expiry ON confirm_tokens (expires_at);
SELECT app.enable_tenant_rls('confirm_tokens');

-- A merge moves references to the survivor, including on converted leads (read-only) and on history
-- activities (immutable), and bumps the version of records whose related records moved. Those rows
-- change only through app.merge_move, which runs as its owner (SECURITY DEFINER) with fixed, checked
-- arguments; the triggers below relax their rules only inside it, for the reference columns alone.
-- Nothing the app role can SET turns that on: the test is who is running, not a setting.
CREATE OR REPLACE FUNCTION app.repoint_only(n jsonb, o jsonb, cols text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (n - cols - ARRAY['updated_at', 'updated_by', 'version']) = (o - cols - ARRAY['updated_at', 'updated_by', 'version'])
$$;

CREATE OR REPLACE FUNCTION app.merge_move(p_table text, p_survivor uuid, p_dups uuid[], p_touch uuid[], p_actor uuid)
RETURNS TABLE (row_id uuid, col text, ref uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  t   uuid := app.tenant_id();
  obj uuid;
  tbl text;
  n   int;
BEGIN
  IF p_table NOT IN ('leads', 'activities') OR p_survivor IS NULL OR cardinality(p_dups) NOT BETWEEN 1 AND 10 OR p_survivor = ANY (p_dups) THEN
    RAISE EXCEPTION 'merge_move: invalid arguments' USING ERRCODE = 'check_violation';
  END IF;
  -- The survivor and the duplicates are records of one mergeable object; the duplicates are archived (the
  -- merge archives them first) and the survivor is not.
  SELECT r.object_id INTO obj FROM record_registry r WHERE r.tenant_id = t AND r.id = p_survivor;
  SELECT coalesce(o.table_name, 'records') INTO tbl FROM objects o WHERE o.tenant_id = t AND o.id = obj;
  IF tbl IS NULL OR tbl NOT IN ('contacts', 'accounts', 'leads', 'records')
     OR (SELECT count(*) FROM record_registry r WHERE r.tenant_id = t AND r.id = ANY (p_dups) AND r.object_id = obj) <> cardinality(p_dups) THEN
    RAISE EXCEPTION 'merge_move: not records of one mergeable object' USING ERRCODE = 'check_violation';
  END IF;
  EXECUTE format('SELECT count(*) FILTER (WHERE id = $2 AND archived_at IS NULL) + count(*) FILTER (WHERE id = ANY ($3) AND archived_at IS NOT NULL) '
    || 'FROM %I WHERE tenant_id = $1 AND (id = $2 OR id = ANY ($3))', tbl) INTO n USING t, p_survivor, p_dups;
  IF n <> 1 + cardinality(p_dups) THEN
    RAISE EXCEPTION 'merge_move: the duplicates must be archived and the survivor not' USING ERRCODE = 'check_violation';
  END IF;

  IF p_table = 'leads' THEN
    RETURN QUERY
      WITH prev AS (SELECT l.id, l.contact_id, l.account_id FROM leads l
                   WHERE l.tenant_id = t AND (l.contact_id = ANY (p_dups) OR l.account_id = ANY (p_dups)) FOR UPDATE)
      UPDATE leads l SET contact_id = CASE WHEN prev.contact_id = ANY (p_dups) THEN p_survivor ELSE l.contact_id END,
                         account_id = CASE WHEN prev.account_id = ANY (p_dups) THEN p_survivor ELSE l.account_id END,
                         version = l.version + 1, updated_by = p_actor
      FROM prev WHERE l.tenant_id = t AND l.id = prev.id
      RETURNING l.id, CASE WHEN prev.contact_id = ANY (p_dups) THEN 'contact_id' ELSE 'account_id' END,
                CASE WHEN prev.contact_id = ANY (p_dups) THEN prev.contact_id ELSE prev.account_id END;
    -- Records whose relation (a record link) now points at the survivor: a version bump, nothing else.
    RETURN QUERY
      UPDATE leads l SET version = l.version + 1, updated_by = p_actor
      WHERE l.tenant_id = t AND l.id = ANY (p_touch)
        AND (l.id = p_survivor OR EXISTS (SELECT 1 FROM record_links k WHERE k.tenant_id = t AND k.from_id = l.id AND k.to_id = p_survivor))
      RETURNING l.id, NULL::text, NULL::uuid;
  ELSE
    RETURN QUERY
      WITH prev AS (SELECT a.id, a.actor_contact_id FROM activities a WHERE a.tenant_id = t AND a.actor_contact_id = ANY (p_dups) FOR UPDATE)
      UPDATE activities a SET actor_contact_id = p_survivor, version = a.version + 1, updated_by = p_actor
      FROM prev WHERE a.tenant_id = t AND a.id = prev.id
      RETURNING a.id, 'actor_contact_id', prev.actor_contact_id;
    RETURN QUERY
      UPDATE activities a SET version = a.version + 1, updated_by = p_actor
      WHERE a.tenant_id = t AND a.id = ANY (p_touch)
        AND (EXISTS (SELECT 1 FROM activity_associations x WHERE x.tenant_id = t AND x.activity_id = a.id AND x.record_id = p_survivor)
          OR EXISTS (SELECT 1 FROM record_links k WHERE k.tenant_id = t AND k.from_id = a.id AND k.to_id = p_survivor))
      RETURNING a.id, NULL::text, NULL::uuid;
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.merge_move(text, uuid, uuid[], uuid[], uuid) FROM PUBLIC;

-- True only inside app.merge_move: the current role is that function's owner, entered from another
-- session role. Neither a setting nor the app role's own statements can make it true.
CREATE OR REPLACE FUNCTION app.merge_moving() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_user <> session_user
     AND current_user = (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'app.merge_move(text, uuid, uuid[], uuid[], uuid)'::regprocedure)
$$;

CREATE OR REPLACE FUNCTION app.leads_converted_readonly() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status_category = 'converted' AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at THEN
    IF app.merge_moving() AND app.repoint_only(to_jsonb(NEW), to_jsonb(OLD), ARRAY['contact_id', 'account_id']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a converted lead is read-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.activities_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.merge_moving() AND app.repoint_only(to_jsonb(NEW), to_jsonb(OLD), ARRAY['actor_contact_id']) THEN
    RETURN NEW;
  END IF;
  IF NEW.archived_at IS DISTINCT FROM OLD.archived_at AND
     (NEW.subject, NEW.body, NEW.payload, NEW.occurred_at) IS NOT DISTINCT FROM (OLD.subject, OLD.body, OLD.payload, OLD.occurred_at) THEN
    RETURN NEW; -- archiving is allowed
  END IF;
  IF NOT EXISTS (SELECT 1 FROM activity_types t WHERE t.tenant_id = OLD.tenant_id AND t.key = OLD.type_key AND t.editable) THEN
    RAISE EXCEPTION 'activities of type % cannot be edited', OLD.type_key USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.type_key, NEW.actor_type, NEW.actor_contact_id, NEW.actor_user_id, NEW.occurred_at)
     IS DISTINCT FROM (OLD.type_key, OLD.actor_type, OLD.actor_contact_id, OLD.actor_user_id, OLD.occurred_at) THEN
    RAISE EXCEPTION 'only the text of a note can be edited' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
