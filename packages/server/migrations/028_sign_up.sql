-- Self sign-up (ADR 0018): a person proves an email address and creates a workspace they own, when
-- the operator turned SIGN_UP on. Off by default; nothing here changes an invite-only server.
--
--   sign_in_flows       two more purposes. 'sign_up' is the emailed code; 'sign_up_verified' is the step
--                       after it, where the proven address names its workspace. Both are bound to the
--                       browser's pre-session cookie, single-use and short-lived, like every other flow.
--   workspace_sign_ups  one row per workspace created this way, so the caps on how many one address, one
--                       network address and the whole server may create hold across restarts and replicas.

ALTER TABLE sign_in_flows DROP CONSTRAINT sign_in_flows_purpose_check,
  ADD CONSTRAINT sign_in_flows_purpose_check CHECK (purpose IN ('email', 'oidc', 'choose', 'server_link', 'sign_up', 'sign_up_verified'));
-- The address a sign-up flow is for, as typed. Kept only for the flow's few minutes: no member exists yet to hold it.
ALTER TABLE sign_in_flows ADD COLUMN email text NULL CHECK (length(email) <= 254),
  ADD CONSTRAINT sign_in_flows_email_purpose_check CHECK ((email IS NOT NULL) = (purpose IN ('sign_up', 'sign_up_verified')));

CREATE TABLE workspace_sign_ups (
  tenant_id   uuid PRIMARY KEY REFERENCES tenant_directory (tenant_id) ON DELETE CASCADE,
  -- HMACs under a server key, never the address itself: of the canonical email, and of the client
  -- address (an IPv6 address by its /64). A copy of the table says nothing about who signed up.
  email_key   bytea NOT NULL CHECK (length(email_key) = 32),
  address_key bytea NULL CHECK (length(address_key) = 32),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_sign_ups_email ON workspace_sign_ups (email_key);
CREATE INDEX workspace_sign_ups_address ON workspace_sign_ups (address_key, created_at);
CREATE INDEX workspace_sign_ups_created ON workspace_sign_ups (created_at);
ALTER TABLE workspace_sign_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_sign_ups FORCE ROW LEVEL SECURITY;
-- It spans workspaces, so it has no tenant policy. Only the transaction that creates a workspace by
-- sign-up says it is counting sign-ups; every other transaction sees and writes nothing.
CREATE POLICY sign_up_count ON workspace_sign_ups
  USING (current_setting('app.sign_up_count', true) = 'on')
  WITH CHECK (current_setting('app.sign_up_count', true) = 'on');
