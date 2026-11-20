-- Audit chain order, event retries and delivery lease tokens.

-- 1. Audit chain order. `seq` is assigned at INSERT, but rows become visible at COMMIT, so a
-- slow transaction can commit a lower seq after a higher one was sealed. The chain therefore
-- gets its own order: chain_pos, assigned at seal time (1, 2, 3, … per tenant) by the guard
-- trigger below. The sealer only ever sets prev_hash/hash/sealed_at (the app role's column grants
-- are unchanged); the trigger fills in chain_pos as the tenant's highest position + 1, and the
-- insert guard refuses rows that arrive already sealed. So, for the app role, positions are
-- unique (the index) and only ever appended one past the end. The table owner can still switch
-- triggers off; verification walks the chain by chain_pos and reports any gap or break, and the
-- anchors in write-once storage catch a rewrite.
ALTER TABLE audit_log ADD COLUMN chain_pos bigint NULL;
CREATE UNIQUE INDEX audit_log_chain ON audit_log (tenant_id, chain_pos) WHERE chain_pos IS NOT NULL;
ALTER TABLE audit_anchors ADD COLUMN chain_pos bigint NULL;  -- the chain position the anchor seals

CREATE OR REPLACE FUNCTION app.audit_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
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

-- Rows are inserted unsealed; only the sealer (an UPDATE, through the guard above) seals them.
-- Without this, the app role could insert a row with its own hash and a far-off chain_pos and
-- break the chain for good (the guard only covers UPDATE and DELETE).
CREATE OR REPLACE FUNCTION app.audit_log_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.prev_hash IS NOT NULL OR NEW.hash IS NOT NULL OR NEW.sealed_at IS NOT NULL OR NEW.chain_pos IS NOT NULL THEN
    RAISE EXCEPTION 'audit_log rows are inserted unsealed (prev_hash, hash, sealed_at and chain_pos must be NULL)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_insert_guard BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_log_insert_guard();

-- Backfill rows sealed under the old scheme, in the order they were sealed (one seal batch shares
-- sealed_at and is sealed in seq order). RLS is forced on the owner too, so go tenant by tenant.
ALTER TABLE audit_log DISABLE TRIGGER audit_log_guard;
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT tenant_id FROM tenant_directory LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE audit_log a SET chain_pos = o.pos
      FROM (SELECT seq, row_number() OVER (ORDER BY sealed_at, seq) AS pos FROM audit_log WHERE tenant_id = t AND hash IS NOT NULL) o
      WHERE a.tenant_id = t AND a.seq = o.seq;
    UPDATE audit_anchors x SET chain_pos = a.chain_pos FROM audit_log a
      WHERE x.tenant_id = t AND a.tenant_id = t AND a.seq = x.seq;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
ALTER TABLE audit_log ENABLE TRIGGER audit_log_guard;

-- 2. Event retries. A failed event is retried with backoff and dead-lettered (dead_at) after the
-- last attempt, instead of being marked processed and silently dropped.
ALTER TABLE outbox_events
  ADD COLUMN attempts        int NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz NULL,
  ADD COLUMN last_error      text NULL,
  ADD COLUMN dead_at         timestamptz NULL;
CREATE INDEX outbox_due ON outbox_events (tenant_id, occurred_at, id) WHERE processed_at IS NULL AND dead_at IS NULL;
CREATE INDEX outbox_dead ON outbox_events (tenant_id, dead_at DESC) WHERE dead_at IS NOT NULL;

-- 3. Delivery leases carry a token, so a worker whose lease expired mid-send cannot record an
-- outcome over the worker that took the delivery over.
ALTER TABLE webhook_deliveries ADD COLUMN lease_token uuid NULL;
