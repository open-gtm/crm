-- M5: event processing, webhooks and automations.
-- The outbox table (001) doubles as the event history: processed rows are kept for 90 days.

CREATE INDEX outbox_pending_by_tenant ON outbox_events (tenant_id, occurred_at, id) WHERE processed_at IS NULL;
CREATE INDEX outbox_by_record ON outbox_events (tenant_id, record_id, occurred_at DESC) WHERE record_id IS NOT NULL;
CREATE INDEX outbox_by_time ON outbox_events (tenant_id, occurred_at DESC);
ALTER TABLE outbox_events ADD COLUMN automation_id uuid NULL;  -- set when an automation caused the event

-- Webhook endpoints. Secrets are encrypted with the tenant's data key; the previous secret stays
-- valid (both signatures are sent) until previous_expires_at, so receivers can rotate without downtime.
CREATE TABLE webhooks (
  tenant_id            uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id                   uuid NOT NULL,
  url                  text NOT NULL CHECK (length(url) <= 2000),
  description          text NULL CHECK (length(description) <= 2000),
  events               text[] NOT NULL DEFAULT '{}',   -- subscriptions, e.g. {deal.*, contact.created}; empty = automations only
  include_restricted   boolean NOT NULL DEFAULT false,
  secret               text NOT NULL,                  -- encrypted
  previous_secret      text NULL,                      -- encrypted
  previous_expires_at  timestamptz NULL,
  enabled              boolean NOT NULL DEFAULT true,
  consecutive_failures int NOT NULL DEFAULT 0,
  circuit_open_until   timestamptz NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  archived_at          timestamptz NULL,
  PRIMARY KEY (tenant_id, id)
);
SELECT app.enable_tenant_rls('webhooks');
CREATE TRIGGER webhooks_touch BEFORE UPDATE ON webhooks FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Automations: "when <trigger> and <condition>, do <actions>", stored as validated structured data.
CREATE TABLE automations (
  tenant_id   uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id          uuid NOT NULL,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text NULL CHECK (length(description) <= 2000),
  enabled     boolean NOT NULL DEFAULT true,
  trigger     jsonb NOT NULL,
  condition   jsonb NULL,
  actions     jsonb NOT NULL,
  hourly_cap  int NOT NULL DEFAULT 100 CHECK (hourly_cap BETWEEN 1 AND 10000),
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX automations_by_event ON automations (tenant_id, ((trigger->>'event'))) WHERE enabled AND archived_at IS NULL;
SELECT app.enable_tenant_rls('automations');
CREATE TRIGGER automations_touch BEFORE UPDATE ON automations FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- One row per automation evaluation that matched (or was skipped by a guard). Unique per event,
-- so reprocessing an event never runs an automation twice.
CREATE TABLE automation_runs (
  tenant_id     uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id            uuid NOT NULL,
  automation_id uuid NOT NULL,
  event_id      uuid NOT NULL,
  record_id     uuid NULL,
  status        text NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped')),
  reason        text NULL,
  depth         int NOT NULL,
  results       jsonb NOT NULL DEFAULT '[]',
  started_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at   timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, automation_id, event_id),
  FOREIGN KEY (tenant_id, automation_id) REFERENCES automations (tenant_id, id)
);
CREATE INDEX automation_runs_recent ON automation_runs (tenant_id, automation_id, started_at DESC);
SELECT app.enable_tenant_rls('automation_runs');

-- Webhook deliveries: the queue and the customer-visible delivery log in one table.
-- `consumer` says why the delivery exists: 'subscription', an automation ID, or 'replay:<id>'.
CREATE TABLE webhook_deliveries (
  tenant_id         uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id                uuid NOT NULL,
  webhook_id        uuid NOT NULL,
  event_id          uuid NULL,
  consumer          text NOT NULL,
  event_type        text NOT NULL,
  payload           jsonb NOT NULL,      -- restricted values are never stored here
  restricted_values text NULL,           -- encrypted {field: value}, merged into the record at send time
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'succeeded', 'dead')),
  attempts          int NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  locked_until      timestamptz NULL,
  last_attempt_at   timestamptz NULL,
  last_status_code  int NULL,
  last_error        text NULL,
  last_duration_ms  int NULL,
  replay_of         uuid NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  delivered_at      timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, event_id, webhook_id, consumer),
  FOREIGN KEY (tenant_id, webhook_id) REFERENCES webhooks (tenant_id, id)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (tenant_id, next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX webhook_deliveries_log ON webhook_deliveries (tenant_id, webhook_id, created_at DESC);
SELECT app.enable_tenant_rls('webhook_deliveries');
