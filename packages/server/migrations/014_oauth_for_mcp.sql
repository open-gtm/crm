-- OAuth 2.1 for the remote MCP servers (ADR 0010). The API is the authorization server; the MCP
-- process stays a resource server with no database credentials. API keys and sessions are unchanged.
--
--   oauth_clients     apps that may ask for access: dynamically registered ones (RFC 7591), and a cache
--                     of client ID metadata documents. Known before any workspace is, so no tenant.
--   oauth_codes       authorization codes: single use, 60 seconds, bound to the client, redirect URI,
--                     PKCE challenge, resource, scopes and the consenting session
--   oauth_grants      one per approved connection: member, client, scopes, resource (the token audience)
--   oauth_tokens      access and refresh tokens of a grant; refresh tokens rotate on every use
--   oauth_assertions  client assertion IDs (private_key_jwt) already used, so one can't be replayed
--
-- Every secret (code, access token, refresh token) is stored only as a SHA-256 hash. Each table has
-- forced RLS; the ones read before a tenant is known use narrow policies in the style of
-- api_keys.key_lookup and sessions.session_lookup.

-- Token endpoint events (issued, refreshed, revoked) are recorded on their own surface.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_surface_check,
  ADD CONSTRAINT audit_log_surface_check CHECK (surface IN ('api', 'cli', 'admin-mcp', 'ops-mcp', 'automation', 'system', 'web', 'oauth'));

-- An OAuth grant is a credential of its own for idempotency records.
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_credential_check,
  ADD CONSTRAINT idempotency_keys_credential_check CHECK (credential IN ('key', 'session', 'oauth'));

-- Sign-in can return to an authorization request, whose query (client ID URL, redirect URI, state,
-- PKCE challenge, resource) is longer than the earlier 512-character limit.
ALTER TABLE sign_in_flows DROP CONSTRAINT sign_in_flows_return_to_check,
  ADD CONSTRAINT sign_in_flows_return_to_check CHECK (length(return_to) <= 2048);

-- Whether members of this workspace may connect apps over OAuth, and which scopes may be granted.
-- Owners change these with PATCH /v1/workspace/sign-in. Switching off revokes every grant.
ALTER TABLE tenants ADD COLUMN oauth_apps boolean NOT NULL DEFAULT true,
  ADD COLUMN oauth_scopes text[] NOT NULL DEFAULT ARRAY['ops:read', 'ops:write', 'restricted:read', 'admin']
    CHECK (oauth_scopes <@ ARRAY['ops:read', 'ops:write', 'restricted:read', 'admin']);

CREATE TABLE oauth_clients (
  id            uuid PRIMARY KEY,
  -- Registered: an ID this server made (oac_…). Metadata document: the document's https URL.
  client_id     text NOT NULL UNIQUE CHECK (length(client_id) BETWEEN 1 AND 500),
  kind          text NOT NULL CHECK (kind IN ('registered', 'metadata_document')),
  client_name   text NOT NULL CHECK (length(client_name) BETWEEN 1 AND 200),
  client_uri    text NULL CHECK (length(client_uri) <= 500),
  redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 20),
  application_type text NOT NULL CHECK (application_type IN ('web', 'native')),
  token_endpoint_auth_method text NOT NULL CHECK (token_endpoint_auth_method IN ('none', 'private_key_jwt')),
  jwks_uri      text NULL CHECK (length(jwks_uri) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NULL,
  -- Registered: when an unused registration lapses (pushed back whenever tokens are issued for it).
  -- Metadata document: when the cached copy must be fetched again.
  expires_at    timestamptz NOT NULL,
  CHECK ((token_endpoint_auth_method = 'private_key_jwt') = (jwks_uri IS NOT NULL)),
  CHECK (kind = 'metadata_document' OR token_endpoint_auth_method = 'none')
);
CREATE INDEX oauth_clients_expiry ON oauth_clients (kind, expires_at);
ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_clients FORCE ROW LEVEL SECURITY;
-- A request sees (and writes) only the one client it names. Counting against the caps, making room
-- under them, and the worker's cleanup of lapsed ones say so explicitly. Clients hold no secrets.
CREATE POLICY client_lookup ON oauth_clients
  USING (client_id = current_setting('app.oauth_client', true))
  WITH CHECK (client_id = current_setting('app.oauth_client', true));
CREATE POLICY client_count ON oauth_clients FOR SELECT
  USING (current_setting('app.oauth_registry', true) = 'on');
-- DELETE with a WHERE clause also needs the rows to be readable, hence the matching SELECT policy.
CREATE POLICY client_prune ON oauth_clients FOR DELETE
  USING (current_setting('app.oauth_prune', true) = 'on' AND expires_at < now());
CREATE POLICY client_prune_read ON oauth_clients FOR SELECT
  USING (current_setting('app.oauth_prune', true) = 'on' AND expires_at < now());
-- Under pressure the registry makes room (oauth/clients.ts): any cached document, or a registration
-- never used for a token. A registration that has issued tokens is never evicted.
CREATE POLICY client_evict ON oauth_clients FOR DELETE
  USING (current_setting('app.oauth_registry', true) = 'on' AND (kind = 'metadata_document' OR last_used_at IS NULL));

CREATE TABLE oauth_codes (
  tenant_id     uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id            uuid NOT NULL,
  code_hash     bytea NOT NULL UNIQUE CHECK (length(code_hash) = 32), -- SHA-256 of the code; the code is never stored
  user_id       uuid NOT NULL,
  session_id    uuid NOT NULL,
  client_id     text NOT NULL CHECK (length(client_id) <= 500),
  client_name   text NOT NULL CHECK (length(client_name) <= 200),
  client_kind   text NOT NULL CHECK (client_kind IN ('registered', 'metadata_document')),
  redirect_uri  text NOT NULL CHECK (length(redirect_uri) <= 2000),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  resource      text NOT NULL CHECK (length(resource) <= 500),
  scopes        text[] NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz NULL,
  -- The grant the code was exchanged for, so a second use can revoke it.
  grant_id      uuid NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX oauth_codes_expiry ON oauth_codes (tenant_id, expires_at);
ALTER TABLE oauth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_codes
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = app.tenant_id());
CREATE POLICY code_lookup ON oauth_codes FOR SELECT
  USING (code_hash = decode(nullif(current_setting('app.oauth_code_lookup', true), ''), 'hex'));

CREATE TABLE oauth_grants (
  tenant_id     uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id            uuid NOT NULL,
  user_id       uuid NOT NULL,
  -- The session the member approved from (it may have ended since).
  session_id    uuid NULL,
  -- A copy of what the member saw: the client can lapse or change, the record of the consent doesn't.
  client_id     text NOT NULL CHECK (length(client_id) <= 500),
  client_name   text NOT NULL CHECK (length(client_name) <= 200),
  client_kind   text NOT NULL CHECK (client_kind IN ('registered', 'metadata_document')),
  redirect_uri  text NOT NULL CHECK (length(redirect_uri) <= 2000),
  scopes        text[] NOT NULL CHECK (scopes <@ ARRAY['ops:read', 'ops:write', 'restricted:read', 'admin'] AND cardinality(scopes) >= 1),
  resource      text NOT NULL CHECK (length(resource) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NULL,
  -- The longest a grant lives, however often its refresh token rotates; then the member connects again.
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz NULL,
  revoked_reason text NULL CHECK (revoked_reason IN ('revoked', 'revoked_by_admin', 'member_disabled', 'signed_out_everywhere', 'replaced',
                                                     'refresh_reuse', 'code_reuse', 'workspace_disabled')),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX oauth_grants_user ON oauth_grants (tenant_id, user_id) WHERE revoked_at IS NULL;
SELECT app.enable_tenant_rls('oauth_grants');

CREATE TABLE oauth_tokens (
  tenant_id     uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id            uuid NOT NULL,
  grant_id      uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('access', 'refresh')),
  token_hash    bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32), -- SHA-256 of the token; the token is never stored
  -- Access tokens only: narrower than the grant when the refresh request asked for fewer scopes. NULL: the grant's.
  scopes        text[] NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  -- Refresh tokens: when it was exchanged for the next one. Presenting it again after that revokes the grant.
  used_at       timestamptz NULL,
  revoked_at    timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, grant_id) REFERENCES oauth_grants (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens (tenant_id, grant_id);
CREATE INDEX oauth_tokens_expiry ON oauth_tokens (tenant_id, expires_at);
ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_tokens
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = app.tenant_id());
CREATE POLICY token_lookup ON oauth_tokens FOR SELECT
  USING (token_hash = decode(nullif(current_setting('app.oauth_token_lookup', true), ''), 'hex'));

CREATE TABLE oauth_assertions (
  -- SHA-256 of the client ID and the assertion's jti.
  jti_hash   bytea PRIMARY KEY CHECK (length(jti_hash) = 32),
  expires_at timestamptz NOT NULL
);
ALTER TABLE oauth_assertions ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_assertions FORCE ROW LEVEL SECURITY;
CREATE POLICY assertion_lookup ON oauth_assertions
  USING (jti_hash = decode(nullif(current_setting('app.oauth_jti', true), ''), 'hex'))
  WITH CHECK (jti_hash = decode(nullif(current_setting('app.oauth_jti', true), ''), 'hex'));
CREATE POLICY assertion_prune ON oauth_assertions FOR DELETE
  USING (current_setting('app.oauth_prune', true) = 'on' AND expires_at < now());
CREATE POLICY assertion_prune_read ON oauth_assertions FOR SELECT
  USING (current_setting('app.oauth_prune', true) = 'on' AND expires_at < now());
