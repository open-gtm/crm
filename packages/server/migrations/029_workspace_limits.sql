-- Per-workspace limits and usage (ADR 0019). Changes no existing data; counts what is already there.

-- A limit the operator set for one workspace, in place of the server's default (an environment setting).
-- A row with a NULL value means "unlimited"; no row means "the server's default". The app role can only
-- read this table (db/migrate.ts revokes the rest), so nothing reachable through the API, the MCP servers
-- or a workspace role can change a limit: the `limits` command writes it, connected as the migrator.
CREATE TABLE tenant_limits (
  tenant_id  uuid NOT NULL REFERENCES tenant_directory (tenant_id) ON DELETE CASCADE,
  key        text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  value      bigint NULL CHECK (value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
SELECT app.enable_tenant_rls('tenant_limits');

-- How many records a workspace holds, archived ones included (every row of record_registry), kept as a
-- sum so that neither reading it nor adding to it takes a lock other writers wait on. Each transaction
-- that adds or removes records has one row here, keyed by its transaction ID; the row with txid 0 is the
-- total of the rows already folded together (core/limits.ts `compactRecordCount`). The count is the sum.
CREATE TABLE record_counts (
  tenant_id uuid NOT NULL REFERENCES tenant_directory (tenant_id) ON DELETE CASCADE,
  txid      bigint NOT NULL,
  delta     bigint NOT NULL,
  PRIMARY KEY (tenant_id, txid)
);
SELECT app.enable_tenant_rls('record_counts');

-- Every record of every object passes through record_registry, so counting there covers every way a
-- record is made or removed: the API, imports, automations, quotes and orders, and whatever is added later.
CREATE OR REPLACE FUNCTION app.count_record() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW.tenant_id ELSE OLD.tenant_id END;
  d bigint := CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE -1 END;
BEGIN
  -- A workspace being deleted takes its records with it; there is nothing left to count for.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM tenant_directory WHERE tenant_id = t) THEN
    RETURN NULL;
  END IF;
  INSERT INTO record_counts (tenant_id, txid, delta) VALUES (t, pg_current_xact_id()::text::bigint, d)
  ON CONFLICT (tenant_id, txid) DO UPDATE SET delta = record_counts.delta + EXCLUDED.delta;
  RETURN NULL;
END $$;

CREATE TRIGGER record_registry_count AFTER INSERT OR DELETE ON record_registry
  FOR EACH ROW EXECUTE FUNCTION app.count_record();

-- The records that exist now.
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT tenant_id FROM tenant_directory LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO record_counts (tenant_id, txid, delta) SELECT t, 0, count(*) FROM record_registry;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
