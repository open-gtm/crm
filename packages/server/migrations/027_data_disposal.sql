-- Data disposal (ADR 0020): deleting a whole workspace, and erasing a person's records for good.
-- Until now nothing was ever deleted: records are archived, and the audit log is append-only.

-- ----------------------------------------------------------------------------------------------
-- 1. Deleting a workspace
--
-- A deletion an owner asks for waits out a grace period. The time it is due is kept in the tenant
-- directory, which has no row-level security, so the worker can find due workspaces without entering
-- each one; who asked, and when, is workspace data and stays in `tenants`.
ALTER TABLE tenant_directory ADD COLUMN delete_after timestamptz NULL;
CREATE INDEX tenant_directory_delete_after ON tenant_directory (delete_after) WHERE delete_after IS NOT NULL;
ALTER TABLE tenants
  ADD COLUMN deletion_requested_at timestamptz NULL,
  ADD COLUMN deletion_requested_by uuid NULL,
  ADD CONSTRAINT tenants_deletion_request CHECK ((deletion_requested_at IS NULL) = (deletion_requested_by IS NULL));

-- What is left of a deleted workspace: that it existed, when it went, who asked, how many rows each
-- table held and where its audit chain ended. No name, no member, no record. It has no tenant_id
-- column: the workspace it describes is gone. The app role reads it and can never write it
-- (db/migrate.ts revokes that); rows are written only by app.purge_tenant below.
CREATE TABLE deleted_workspaces (
  workspace_id      uuid PRIMARY KEY,             -- the tenant ID the workspace had
  created_at        timestamptz NOT NULL,
  deleted_at        timestamptz NOT NULL DEFAULT now(),
  requested_at      timestamptz NOT NULL,
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('owner', 'operator')),
  requested_by      uuid NULL,                    -- the owner's user ID; NULL for the operator's command
  audit_rows        bigint NOT NULL,
  audit_chain_pos   bigint NULL,                  -- the last sealed position of its audit chain
  audit_head_hash   bytea NULL,                   -- and that row's hash: what its last anchor holds
  rows_deleted      jsonb NOT NULL,               -- {table: rows}
  CHECK ((requested_by_type = 'owner') = (requested_by IS NOT NULL))
);

-- Deletes every row a workspace has, in every table, and leaves its tombstone. The tables are read
-- from the catalog: every table with a foreign key to tenant_directory, which every tenant table has
-- (a test fails for one that doesn't). They go in one statement, so foreign keys between them are
-- checked once, against the end state, whatever the order (deals and leads refer to each other).
--
-- It runs as its owner (SECURITY DEFINER) because the app role may not delete audit rows, roles or
-- history, and must not be able to: this is the one path, it takes a whole workspace or nothing, and
-- it always leaves the tombstone the app role can't change. The audit log must be sealed first, so
-- the tombstone holds the true end of the chain.
CREATE OR REPLACE FUNCTION app.purge_tenant(p_tenant uuid, p_by_type text, p_by uuid, p_requested_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  created   timestamptz;
  n_audit   bigint;
  head_pos  bigint;
  head_hash bytea;
  tbl       text;
  i         int := 0;
  ctes      text := '';
  counts    text := '';
  deleted   jsonb;
BEGIN
  IF p_tenant IS NULL OR p_requested_at IS NULL OR p_by_type IS NULL OR p_by_type NOT IN ('owner', 'operator')
     OR (p_by_type = 'owner') <> (p_by IS NOT NULL) THEN
    RAISE EXCEPTION 'purge_tenant: invalid arguments' USING ERRCODE = 'check_violation';
  END IF;
  -- Waits for requests still writing to the workspace (their rows hold a key-share lock on this one).
  SELECT d.created_at INTO created FROM tenant_directory d WHERE d.tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purge_tenant: no such workspace' USING ERRCODE = 'no_data_found';
  END IF;
  -- Row-level security is forced on the owner too, so the function enters the workspace like any caller.
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  PERFORM set_config('app.purging', 'on', true);

  SELECT count(*), count(*) FILTER (WHERE a.hash IS NULL) INTO n_audit, i FROM audit_log a WHERE a.tenant_id = p_tenant;
  IF i > 0 THEN
    RAISE EXCEPTION 'purge_tenant: the audit log has unsealed rows; seal it first' USING ERRCODE = 'check_violation';
  END IF;
  SELECT a.chain_pos, a.hash INTO head_pos, head_hash FROM audit_log a
    WHERE a.tenant_id = p_tenant AND a.chain_pos IS NOT NULL ORDER BY a.chain_pos DESC LIMIT 1;

  i := 0;
  FOR tbl IN
    SELECT DISTINCT c.relname FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE k.contype = 'f' AND k.confrelid = 'public.tenant_directory'::regclass AND n.nspname = 'public'
    ORDER BY c.relname
  LOOP
    i := i + 1;
    ctes := ctes || format('d%s AS (DELETE FROM public.%I WHERE tenant_id = $1 RETURNING 1), ', i, tbl);
    counts := counts || format('SELECT %L::text AS t, (SELECT count(*) FROM d%s) AS n UNION ALL ', tbl, i);
  END LOOP;
  EXECUTE 'WITH ' || ctes || 'dir AS (DELETE FROM public.tenant_directory WHERE tenant_id = $1 RETURNING 1) '
       || 'SELECT jsonb_object_agg(s.t, s.n) FROM (' || counts || 'SELECT ''tenant_directory'', (SELECT count(*) FROM dir)) s'
    INTO deleted USING p_tenant;

  INSERT INTO deleted_workspaces (workspace_id, created_at, requested_at, requested_by_type, requested_by, audit_rows, audit_chain_pos, audit_head_hash, rows_deleted)
    VALUES (p_tenant, created, p_requested_at, p_by_type, p_by, n_audit, head_pos, head_hash, deleted);
  PERFORM set_config('app.purging', '', true);
  RETURN deleted;
END $$;
REVOKE ALL ON FUNCTION app.purge_tenant(uuid, text, uuid, timestamptz) FROM PUBLIC;

-- True only inside app.purge_tenant: the current role is that function's owner, entered from another
-- session role, and the function has said it is purging. The app role can set the setting but not
-- become the owner, so neither a setting nor its own statements make this true (as app.merge_moving).
CREATE OR REPLACE FUNCTION app.purging() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_user <> session_user
     AND current_setting('app.purging', true) = 'on'
     AND current_user = (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'app.purge_tenant(uuid, text, uuid, timestamptz)'::regprocedure)
$$;

-- Row-level security is on for the tombstones like every other table, with two policies: anyone may
-- read them (they hold nothing of a customer's, and the workspace they name is gone), and a row can be
-- inserted only by the purge. With the grants (db/migrate.ts) that leaves no way to change or remove one.
ALTER TABLE deleted_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE deleted_workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY tombstones_readable ON deleted_workspaces FOR SELECT USING (true);
CREATE POLICY tombstones_written_by_purge ON deleted_workspaces FOR INSERT WITH CHECK (app.purging());

-- Triggers that fire before a row is deleted stand aside for a purge: the ones that refuse the delete
-- (audit rows, order lines, the lines of a sent quote), and the one that deletes the row's registry
-- entry itself, which the purge's own statement is deleting too. A test fails for a new one that doesn't.
CREATE OR REPLACE FUNCTION app.audit_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND app.purging() THEN
    RETURN OLD;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'audit_log is append-only';
  END IF;
  -- The only permitted update is sealing an unsealed row, once. chain_pos is never set directly.
  IF OLD.hash IS NOT NULL
     OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.actor_type IS DISTINCT FROM OLD.actor_type OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR NEW.key_id IS DISTINCT FROM OLD.key_id OR NEW.surface IS DISTINCT FROM OLD.surface
     OR NEW.action IS DISTINCT FROM OLD.action OR NEW.object_type IS DISTINCT FROM OLD.object_type
     OR NEW.record_id IS DISTINCT FROM OLD.record_id OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.details IS DISTINCT FROM OLD.details OR NEW.chain_pos IS DISTINCT FROM OLD.chain_pos THEN
    RAISE EXCEPTION 'audit_log rows are immutable once written';
  END IF;
  IF NEW.hash IS NOT NULL THEN
    IF NEW.prev_hash IS NULL THEN
      RAISE EXCEPTION 'a sealed audit row needs prev_hash';
    END IF;
    -- The sealer holds a per-tenant advisory lock; the unique index catches a second sealer anyway.
    NEW.chain_pos := coalesce((SELECT max(chain_pos) FROM audit_log WHERE tenant_id = NEW.tenant_id), 0) + 1;
  END IF;
  RETURN NEW;
END $$;

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
  IF app.purging() THEN
    RETURN OLD;
  END IF;
  DELETE FROM record_registry WHERE tenant_id = OLD.tenant_id AND id = OLD.id;
  RETURN OLD;
END $$;

CREATE OR REPLACE FUNCTION app.quote_lines_draft_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE q uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.quote_id ELSE NEW.quote_id END;
        t uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
BEGIN
  IF TG_OP = 'DELETE' AND app.purging() THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM quotes WHERE tenant_id = t AND id = q AND status_category <> 'draft') THEN
    RAISE EXCEPTION 'the lines of a quote that has been sent cannot be changed' USING ERRCODE = 'check_violation', CONSTRAINT = 'quote_lines_draft_only';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.order_lines_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND app.purging() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'the lines of an order cannot be changed' USING ERRCODE = 'check_violation', CONSTRAINT = 'order_lines_immutable';
END $$;

-- ----------------------------------------------------------------------------------------------
-- 2. Erasing a person's records
--
-- An erased record keeps its row, so what refers to it (a deal, an order) still does; its values are
-- gone and it says when. Contacts have had the column since the first migration; leads and custom
-- records get it here.
ALTER TABLE leads ADD COLUMN anonymized_at timestamptz NULL;
ALTER TABLE records ADD COLUMN anonymized_at timestamptz NULL;

-- A converted lead is read-only, and stays so, except for the one change that erases it.
CREATE OR REPLACE FUNCTION app.leads_converted_readonly() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.anonymized_at IS NULL AND NEW.anonymized_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.status_category = 'converted' AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at THEN
    IF app.merge_moving() AND app.repoint_only(to_jsonb(NEW), to_jsonb(OLD), ARRAY['contact_id', 'account_id']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a converted lead is read-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Activities are history and stay immutable, except that erasure may blank one: its subject becomes
-- '[erased]' and its body and payload go, while what it was, when, and who did it stay as they were.
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
  IF NEW.subject = '[erased]' AND NEW.body IS NULL AND NEW.payload = '{}'::jsonb
     AND (NEW.type_key, NEW.actor_type, NEW.actor_contact_id, NEW.actor_user_id, NEW.occurred_at)
         IS NOT DISTINCT FROM (OLD.type_key, OLD.actor_type, OLD.actor_contact_id, OLD.actor_user_id, OLD.occurred_at) THEN
    RETURN NEW; -- erasure
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

-- A merge keeps the survivor's previous values (encrypted) so it could be undone. Erasing a record of
-- that merge drops them: the one change a merge row ever takes, made only by this function, which
-- runs as its owner because the app role may not update merges.
CREATE OR REPLACE FUNCTION app.erase_merge_values(p_records uuid[]) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n int;
BEGIN
  IF p_records IS NULL OR cardinality(p_records) NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'erase_merge_values: invalid arguments' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE merges m SET survivor_before = NULL
    WHERE m.tenant_id = app.tenant_id() AND m.survivor_before IS NOT NULL
      AND (m.survivor_id = ANY (p_records) OR m.merged_ids && p_records);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.erase_merge_values(uuid[]) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.merges_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Inside app.erase_merge_values (the current role is its owner, entered from another session role),
  -- and nothing but the kept values going.
  IF current_user <> session_user
     AND current_user = (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'app.erase_merge_values(uuid[])'::regprocedure)
     AND NEW.survivor_before IS NULL AND (to_jsonb(NEW) - 'survivor_before') = (to_jsonb(OLD) - 'survivor_before') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'merges are append-only' USING ERRCODE = 'check_violation';
END $$;
