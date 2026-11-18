-- A cache key for a workspace's schema that is never reused (core/schema.ts loadSchema).
--
-- schema_version stays what it is: a per-workspace counter that moves by one with every schema change,
-- quoted in If-Match, schema files and schema_changes. It can't key a cache: a transaction that bumps
-- it and rolls back hands the same number to the next change, so a process that read the rolled-back
-- schema would serve it under that number. schema_token comes from a sequence, which never hands out
-- a value twice, even when a transaction rolls back (as role_access_version_seq does for roles, 008).
CREATE SEQUENCE schema_token_seq;
-- A volatile default: each existing workspace gets its own value when the column is added.
ALTER TABLE tenants ADD COLUMN schema_token bigint NOT NULL DEFAULT nextval('schema_token_seq');

-- Any change to what loadSchema reads from this row, however it is made, moves the token, so no process
-- keeps serving the old schema. Changes to objects and fields go through the schema_version bump.
CREATE OR REPLACE FUNCTION app.bump_schema_token() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.schema_version IS DISTINCT FROM OLD.schema_version OR NEW.modules IS DISTINCT FROM OLD.modules
     OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    NEW.schema_token := nextval('schema_token_seq');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tenants_schema_token BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION app.bump_schema_token();
