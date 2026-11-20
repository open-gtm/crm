-- M6: alert rules, materialized deadlines, notifications, delivery and preferences.

-- An alert rule watches one object. Event rules fire on matching changes; time rules fire when a
-- deadline computed from the record passes ("no activity for 14 days", "due_at has passed").
CREATE TABLE alert_rules (
  tenant_id      uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id             uuid NOT NULL,
  scope          text NOT NULL CHECK (scope IN ('workspace', 'personal')),
  owner_user_id  uuid NULL,                 -- personal rules: the user who is notified
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description    text NULL CHECK (length(description) <= 2000),
  object         text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('event', 'time')),
  trigger        jsonb NOT NULL,
  condition      jsonb NULL,
  severity       text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  recipients     jsonb NOT NULL DEFAULT '{"record_owner": true, "users": []}',
  webhooks       uuid[] NOT NULL DEFAULT '{}',
  cooldown_hours int NULL CHECK (cooldown_hours BETWEEN 1 AND 8760),
  enabled        boolean NOT NULL DEFAULT true,
  backfill_cursor uuid NULL,                -- time rules: next record to backfill deadlines from
  backfilled_at  timestamptz NULL,
  version        int NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK ((scope = 'personal') = (owner_user_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX alert_rules_active ON alert_rules (tenant_id, object) WHERE enabled AND archived_at IS NULL;
SELECT app.enable_tenant_rls('alert_rules');
CREATE TRIGGER alert_rules_touch BEFORE UPDATE ON alert_rules FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- One row per (time rule, record): when the rule should next be checked for that record.
-- The scheduler reads only due rows (indexed), never scanning records.
CREATE TABLE rule_deadlines (
  tenant_id uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  rule_id   uuid NOT NULL,
  record_id uuid NOT NULL,
  due_at    timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, rule_id, record_id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES alert_rules (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX rule_deadlines_due ON rule_deadlines (tenant_id, due_at);
SELECT app.enable_tenant_rls('rule_deadlines');

CREATE TABLE notifications (
  tenant_id     uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id            uuid NOT NULL,
  rule_id       uuid NULL,                  -- set for alert rules
  automation_id uuid NULL,                  -- set for an automation's notify action
  record_id     uuid NULL,
  object        text NOT NULL,
  user_id       uuid NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title         text NOT NULL,
  body          text NULL,
  state         text NOT NULL DEFAULT 'unread' CHECK (state IN ('unread', 'acknowledged', 'snoozed', 'resolved')),
  snoozed_until timestamptz NULL,
  fire_count    int NOT NULL DEFAULT 1,
  first_fired_at timestamptz NOT NULL DEFAULT now(),
  last_fired_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz NULL,
  resolved_at   timestamptz NULL,
  resolved_by   uuid NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK ((rule_id IS NULL) <> (automation_id IS NULL)),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES alert_rules (tenant_id, id),
  FOREIGN KEY (tenant_id, automation_id) REFERENCES automations (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
-- Dedupe: at most one open notification per rule (or automation), record and recipient.
CREATE UNIQUE INDEX notifications_open ON notifications (tenant_id, rule_id, record_id, user_id) WHERE state <> 'resolved' AND rule_id IS NOT NULL;
CREATE UNIQUE INDEX notifications_open_auto ON notifications (tenant_id, automation_id, record_id, user_id) WHERE state <> 'resolved' AND automation_id IS NOT NULL;
CREATE INDEX notifications_inbox ON notifications (tenant_id, user_id, state, last_fired_at DESC);
CREATE INDEX notifications_snoozed ON notifications (tenant_id, snoozed_until) WHERE state = 'snoozed';
SELECT app.enable_tenant_rls('notifications');

-- Per-notification delivery log for user channels (email). Webhook channel deliveries use
-- webhook_deliveries, through the alert.fired event.
CREATE TABLE notification_deliveries (
  tenant_id       uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id              uuid NOT NULL,
  notification_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('email')),
  mode            text NOT NULL CHECK (mode IN ('immediate', 'digest')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, notification_id) REFERENCES notifications (tenant_id, id)
);
CREATE INDEX notification_deliveries_due ON notification_deliveries (tenant_id, next_attempt_at) WHERE status = 'pending';
CREATE INDEX notification_deliveries_by_notification ON notification_deliveries (tenant_id, notification_id);
SELECT app.enable_tenant_rls('notification_deliveries');

CREATE TABLE notification_preferences (
  tenant_id   uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  user_id     uuid NOT NULL,
  prefs       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
SELECT app.enable_tenant_rls('notification_preferences');
CREATE TRIGGER notification_preferences_touch BEFORE UPDATE ON notification_preferences FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
