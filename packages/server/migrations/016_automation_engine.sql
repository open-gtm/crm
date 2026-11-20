-- Step 5: automations that run on a schedule or on request, new actions (find, upsert, HTTP request,
-- email), and the limits and switches around them. Changes no existing data: existing automations keep
-- their event triggers and actions, existing runs keep their rows.

-- Pause is separate from enabled: an admin's switch (or the automatic pause after repeated failures)
-- that resume clears, without touching what the automation is set to do.
ALTER TABLE automations
  ADD COLUMN paused_at            timestamptz NULL,
  ADD COLUMN paused_reason        text NULL CHECK (length(paused_reason) <= 500),
  ADD COLUMN consecutive_failures int NOT NULL DEFAULT 0,
  ADD COLUMN run_roles            text[] NOT NULL DEFAULT '{}' CHECK (cardinality(run_roles) <= 20), -- roles that may run it on request
  ADD COLUMN next_run_at          timestamptz NULL,  -- schedule triggers: the next tick, materialized like alert deadlines
  ADD COLUMN secrets              text NULL;         -- encrypted {step: {header: value}} for http_request secret headers (write-only)
CREATE INDEX automations_due ON automations (tenant_id, next_run_at) WHERE next_run_at IS NOT NULL AND archived_at IS NULL;

-- Runs now come from events, schedule ticks and requests. Queued runs (schedule, manual, and event
-- automations that call out) are leased by the worker and record their progress step by step, so a
-- run picked up again after a worker stops resumes after the last step that finished.
ALTER TABLE automation_runs
  ALTER COLUMN event_id DROP NOT NULL,
  ADD COLUMN trigger_kind  text NOT NULL DEFAULT 'event' CHECK (trigger_kind IN ('event', 'schedule', 'manual')),
  ADD COLUMN scheduled_for timestamptz NULL,
  ADD COLUMN requested_by  text NULL,              -- manual runs: public ID of who asked (usr_…, svc_…)
  ADD COLUMN input         jsonb NULL,             -- manual runs: the record asked for
  ADD COLUMN attempts      int NOT NULL DEFAULT 0,
  ADD COLUMN lease_token   uuid NULL,
  ADD COLUMN locked_until  timestamptz NULL,
  ADD COLUMN progress      jsonb NULL,             -- steps done and their outputs; cleared when the run ends
  ADD COLUMN usage         jsonb NOT NULL DEFAULT '{}';
ALTER TABLE automation_runs DROP CONSTRAINT automation_runs_status_check;
ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_status_check
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped'));
ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_event_kind CHECK ((trigger_kind = 'event') = (event_id IS NOT NULL));
-- One run per schedule tick: enqueueing a tick twice is a no-op.
CREATE UNIQUE INDEX automation_runs_tick ON automation_runs (tenant_id, automation_id, scheduled_for) WHERE scheduled_for IS NOT NULL;
CREATE INDEX automation_runs_open ON automation_runs (tenant_id, started_at) WHERE status IN ('queued', 'running');

-- Workspace-wide switches: pause every automation, allow email to addresses that are not members, and
-- the time zone schedules use when they don't name one. One row per workspace, created on first change.
CREATE TABLE automation_settings (
  tenant_id      uuid PRIMARY KEY REFERENCES tenant_directory (tenant_id),
  paused_at      timestamptz NULL,
  paused_reason  text NULL CHECK (length(paused_reason) <= 500),
  external_email boolean NOT NULL DEFAULT false,
  timezone       text NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('automation_settings');
CREATE TRIGGER automation_settings_touch BEFORE UPDATE ON automation_settings FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Fixed-window counters for the hourly caps (actions, HTTP calls, emails per workspace and per automation,
-- emails per recipient per day). Durable, so several workers share one count. Old windows are pruned.
CREATE TABLE automation_usage (
  tenant_id    uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  bucket       text NOT NULL CHECK (length(bucket) <= 100),
  window_start timestamptz NOT NULL,
  n            int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, bucket, window_start)
);
SELECT app.enable_tenant_rls('automation_usage');

-- Addresses automations must not email. Only a keyed hash is kept, never the address.
CREATE TABLE email_suppressions (
  tenant_id    uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  address_hash bytea NOT NULL,
  reason       text NULL CHECK (length(reason) <= 200),
  created_by   text NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, address_hash)
);
SELECT app.enable_tenant_rls('email_suppressions');
