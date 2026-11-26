-- The connected app or API key an event's change came through, by name as it was called then, beside the
-- surface: "through MCP" becomes "through Claude Desktop". Shown to the member it acted for and to those
-- who read the audit log. NULL for changes made in the browser, by automations, and from before this column.
ALTER TABLE outbox_events ADD COLUMN via text NULL CHECK (length(via) <= 200);
-- Runs across every automation in a time window (the admin's "automation runs" summary).
CREATE INDEX automation_runs_by_time ON automation_runs (tenant_id, started_at DESC);
