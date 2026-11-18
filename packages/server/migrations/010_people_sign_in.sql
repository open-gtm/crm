-- People sign-in and browser sessions (ADR 0009). API keys are unchanged.
--
--   sessions            one row per signed-in browser; found by the SHA-256 of its cookie token
--   member_credentials  a member's password hash, single sign-on link, lockout state and last sign-in
--   sign_in_identities  email -> (workspace, member) and OIDC subject -> (workspace, member), so a
--                       sign-in can find a person's memberships before any workspace is known
--   sign_in_flows       short-lived, single-use sign-in steps (email code and link, SSO, workspace
--                       choice, server-printed links). They span workspaces, so they have no tenant.
--
-- Every table has forced RLS. The cross-workspace lookups use narrow policies in the style of
-- api_keys.key_lookup: a request can read only the rows matching the hash or value it presents.

-- Browser sessions are a new audit surface.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_surface_check,
  ADD CONSTRAINT audit_log_surface_check CHECK (surface IN ('api', 'cli', 'admin-mcp', 'ops-mcp', 'automation', 'system', 'web'));

-- Idempotency records belong to a credential: an API key (as before) or a browser session.
ALTER TABLE idempotency_keys RENAME COLUMN key_id TO credential_id;
ALTER TABLE idempotency_keys ADD COLUMN credential text NOT NULL DEFAULT 'key' CHECK (credential IN ('key', 'session'));

-- Whether members of this workspace may sign in with a password, or with single sign-on (the server
-- settings must allow it too), and the email domains this workspace accepts through single sign-on
-- (empty: any the server accepts). Owners change these with PATCH /v1/workspace/sign-in.
ALTER TABLE tenants ADD COLUMN password_sign_in boolean NOT NULL DEFAULT true,
  ADD COLUMN sso_sign_in boolean NOT NULL DEFAULT true,
  ADD COLUMN sso_allowed_domains text[] NOT NULL DEFAULT '{}' CHECK (cardinality(sso_allowed_domains) <= 50);

-- The one form an email is matched in at sign-in: surrounding ASCII whitespace trimmed and only A-Z
-- folded (the "C" collation), never the database locale's case rules, which fold some non-ASCII
-- letters (the Kelvin sign to k) into ASCII ones. auth/identity.ts computes the same in JavaScript,
-- and a test compares the two on awkward inputs.
CREATE OR REPLACE FUNCTION app.canonical_email(email text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT lower(btrim(email, E' \t\n\r\f\x0B') COLLATE "C") $$;

CREATE TABLE sessions (
  tenant_id       uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id              uuid NOT NULL,
  user_id         uuid NOT NULL,
  token_hash      bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32), -- SHA-256 of the cookie token; the token is never stored
  method          text NOT NULL CHECK (method IN ('email_code', 'email_link', 'password', 'oidc', 'server_link')),
  signed_in_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  user_agent      text NULL CHECK (length(user_agent) <= 256),
  client_address  text NULL CHECK (length(client_address) <= 64),
  revoked_at      timestamptz NULL,
  revoked_reason  text NULL CHECK (revoked_reason IN ('signed_out', 'revoked', 'revoked_by_admin', 'other_sessions_revoked',
                                                      'member_disabled', 'password_changed')),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX sessions_user ON sessions (tenant_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry ON sessions (tenant_id, expires_at);
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
-- As on api_keys: the isolation policy must not raise when the tenant is unset, because permissive
-- policies are OR-ed with session_lookup, which lets a request read the one row whose token hash it presents.
CREATE POLICY tenant_isolation ON sessions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = app.tenant_id());
CREATE POLICY session_lookup ON sessions FOR SELECT
  USING (token_hash = decode(nullif(current_setting('app.session_lookup', true), ''), 'hex'));

CREATE TABLE member_credentials (
  tenant_id           uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  user_id             uuid NOT NULL,
  -- Self-describing: $argon2id$v=19$m=…,t=…,p=…$salt$hash (or $scrypt$… where argon2 is unavailable).
  password_hash       text NULL CHECK (password_hash ~ '^\$(argon2id|scrypt)\$'),
  password_set_at     timestamptz NULL,
  password_failures   int NOT NULL DEFAULT 0,
  password_locked_until timestamptz NULL,
  oidc_issuer         text NULL CHECK (length(oidc_issuer) <= 500),
  oidc_subject        text NULL CHECK (length(oidc_subject) <= 255),
  oidc_linked_at      timestamptz NULL,
  last_sign_in_at     timestamptz NULL,
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CHECK ((oidc_issuer IS NULL) = (oidc_subject IS NULL))
);
SELECT app.enable_tenant_rls('member_credentials');

CREATE TABLE sign_in_identities (
  tenant_id uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  user_id   uuid NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('email', 'oidc')),
  -- email: app.canonical_email of the address. oidc: issuer, a newline, then the subject.
  value     text NOT NULL CHECK (length(value) BETWEEN 1 AND 800),
  -- email only: the address exactly as stored, so a lookup can put the typed spelling first.
  address   text NULL CHECK (length(address) <= 800),
  PRIMARY KEY (tenant_id, user_id, kind),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX sign_in_identities_lookup ON sign_in_identities (kind, value);
ALTER TABLE sign_in_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE sign_in_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sign_in_identities
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = app.tenant_id());
-- Read-only, and only the rows for the one identity being signed in. Status, names and roles are
-- read afterwards, workspace by workspace, under the normal isolation policy.
CREATE POLICY identity_lookup ON sign_in_identities FOR SELECT
  USING (kind = current_setting('app.identity_kind', true) AND value = current_setting('app.identity_lookup', true));

-- Kept in step with users.email and disabled_at by trigger, so every way a member is added, changed,
-- disabled or enabled is covered. Disabled members have no email identity: they can't sign in, and
-- can't fill the bounded lookup ahead of members who can.
CREATE OR REPLACE FUNCTION app.sync_email_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.disabled_at IS NULL THEN
    INSERT INTO sign_in_identities (tenant_id, user_id, kind, value, address)
    VALUES (NEW.tenant_id, NEW.id, 'email', app.canonical_email(NEW.email::text), NEW.email::text)
    ON CONFLICT (tenant_id, user_id, kind) DO UPDATE SET value = EXCLUDED.value, address = EXCLUDED.address;
  ELSE
    DELETE FROM sign_in_identities WHERE tenant_id = NEW.tenant_id AND user_id = NEW.id AND kind = 'email';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_email_identity AFTER INSERT OR UPDATE OF email, disabled_at ON users
  FOR EACH ROW EXECUTE FUNCTION app.sync_email_identity();

-- Kept in step with member_credentials' OIDC link.
CREATE OR REPLACE FUNCTION app.sync_oidc_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.oidc_subject IS NULL THEN
    DELETE FROM sign_in_identities WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id AND kind = 'oidc';
  ELSE
    INSERT INTO sign_in_identities (tenant_id, user_id, kind, value)
    VALUES (NEW.tenant_id, NEW.user_id, 'oidc', NEW.oidc_issuer || E'\n' || NEW.oidc_subject)
    ON CONFLICT (tenant_id, user_id, kind) DO UPDATE SET value = EXCLUDED.value;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_credentials_oidc_identity AFTER INSERT OR UPDATE OF oidc_issuer, oidc_subject ON member_credentials
  FOR EACH ROW EXECUTE FUNCTION app.sync_oidc_identity();

-- Existing members, tenant by tenant (FORCE ROW LEVEL SECURITY binds the owner too).
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT tenant_id FROM tenant_directory LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO sign_in_identities (tenant_id, user_id, kind, value, address)
    SELECT tenant_id, id, 'email', app.canonical_email(email::text), email::text FROM users WHERE disabled_at IS NULL ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

CREATE TABLE sign_in_flows (
  id           uuid PRIMARY KEY,
  -- SHA-256 of the pre-session cookie the flow is bound to. NULL only for server-printed links.
  browser_hash bytea NULL CHECK (length(browser_hash) = 32),
  -- SHA-256 of an emailed or printed link token.
  link_hash    bytea NULL UNIQUE CHECK (length(link_hash) = 32),
  purpose      text NOT NULL CHECK (purpose IN ('email', 'oidc', 'choose', 'server_link')),
  -- HMAC of the emailed code under a server key, so a copy of the table can't be brute-forced offline.
  code_hash    bytea NULL CHECK (length(code_hash) = 32),
  attempts     int NOT NULL DEFAULT 0,
  -- Members the proven identity matched: [{"t": tenant, "u": user}]. Empty until (and unless) one matches.
  candidates   jsonb NOT NULL DEFAULT '[]',
  -- How the identity was proven, for a workspace choice step.
  method       text NULL CHECK (method IN ('email_code', 'email_link', 'password', 'oidc', 'server_link')),
  -- The workspace the person named when starting (SSO), so only that one is looked up.
  workspace_id uuid NULL,
  -- True when the identity matched more memberships than are looked up: the choice then says how to name the workspace.
  more_workspaces boolean NOT NULL DEFAULT false,
  return_to    text NULL CHECK (length(return_to) <= 512),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz NULL,
  CHECK (browser_hash IS NOT NULL OR (purpose = 'server_link' AND link_hash IS NOT NULL))
);
CREATE INDEX sign_in_flows_browser ON sign_in_flows (browser_hash);
CREATE INDEX sign_in_flows_expiry ON sign_in_flows (expires_at);
ALTER TABLE sign_in_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE sign_in_flows FORCE ROW LEVEL SECURITY;
-- A request sees only the flows of the browser cookie or link token it presents. The worker's
-- cleanup may also see (to delete) flows that have already expired.
CREATE POLICY flow_lookup ON sign_in_flows
  USING (browser_hash = decode(nullif(current_setting('app.flow_browser', true), ''), 'hex')
         OR link_hash = decode(nullif(current_setting('app.flow_link', true), ''), 'hex')
         OR (current_setting('app.flow_prune', true) = 'on' AND expires_at < now()))
  WITH CHECK (browser_hash = decode(nullif(current_setting('app.flow_browser', true), ''), 'hex')
              OR link_hash = decode(nullif(current_setting('app.flow_link', true), ''), 'hex'));
