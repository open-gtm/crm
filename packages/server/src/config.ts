import { z } from "zod";
import { ConfigError } from "./lib/errors.js";

/** WEB_UI as config() reads it: on unless "false" or "0", in any case and with spaces trimmed (like TRUST_PROXY's "true"/"1"). */
export const webUiOn = (raw: string | undefined): boolean => !["false", "0"].includes((raw ?? "true").trim().toLowerCase());

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  DATABASE_URL: z.string().optional(),
  MIGRATOR_DATABASE_URL: z.string().optional(),
  HLCRM_MASTER_KEY: z.string().optional(),
  API_PORT: z.coerce.number().int().default(8787),
  MCP_PORT: z.coerce.number().int().default(8788),
  HLCRM_API_URL: z.string().default("http://localhost:8787"),
  BLOB_DIR: z.string().default("./data/blobs"),
  AUDIT_SEAL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  AUDIT_ANCHOR_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  /** Lets webhooks target http:// URLs and private addresses (for internal self-hosted targets). Metadata IPs stay blocked. */
  WEBHOOK_ALLOW_INSECURE_TARGETS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** smtp(s)://user:pass@host:port. Leave unset to turn email off (notifications still reach the inbox and webhooks). */
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default("hl-crm-db <alerts@localhost>"),
  ALERT_SCHEDULER_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /** Per-workspace hourly caps on what automations do: action steps run, HTTP requests sent, emails sent. */
  AUTOMATION_ACTIONS_PER_HOUR: z.coerce.number().int().min(1).default(5_000),
  AUTOMATION_HTTP_PER_HOUR: z.coerce.number().int().min(0).default(500),
  AUTOMATION_EMAILS_PER_HOUR: z.coerce.number().int().min(0).default(200),
  /** Emails one automation may send in an hour, and one address may get from a workspace's automations in a day. */
  AUTOMATION_EMAILS_PER_AUTOMATION_HOUR: z.coerce.number().int().min(0).default(50),
  AUTOMATION_EMAILS_PER_RECIPIENT_DAY: z.coerce.number().int().min(0).default(5),
  /** When true, the API trusts X-Forwarded-For for client addresses. Only enable behind a reverse proxy you control. "true"/"1" = on. */
  TRUST_PROXY: z.string().default("false").transform((v) => ["true", "1"].includes(v.trim().toLowerCase())),
  EVENT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  /**
   * The externally visible origin of the API, e.g. https://crm.example.com. People sign-in is off
   * until it is set: links in email, cookies, the SSO redirect URI and Origin checks are built from it.
   */
  PUBLIC_URL: z.string().optional(),
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(5).max(43_200).default(720),
  SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce.number().int().min(1).max(2_160).default(168),
  /** Whether members may sign in with a password at all. Each workspace's owner can also turn it off. */
  PASSWORD_SIGN_IN: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  /**
   * How hard to guess a new password must be, as zxcvbn rates it: 0 (the estimate is off) to 4. The default,
   * 3, is about 10^8 guesses or more. 4 (about 10^10) also refuses a word with a year and punctuation, and
   * short phrases. Below 3 is weaker than recommended for a password used on its own.
   */
  PASSWORD_MIN_STRENGTH: z.coerce.number().int().min(0).max(4).default(3),
  /** Check new passwords against Have I Been Pwned (only the first 5 hex characters of the SHA-1 leave the server). */
  PASSWORD_BREACH_CHECK: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** Single sign-on through one OpenID Connect provider. Off unless issuer, client ID and secret are all set. */
  OIDC_ISSUER: z.string().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_DISPLAY_NAME: z.string().max(60).default("single sign-on"),
  /** Comma-separated email domains allowed through SSO (e.g. example.com). Empty allows any verified email of an existing member. */
  OIDC_ALLOWED_DOMAINS: z.string().default(""),
  /** Lets the identity provider be on http:// or a private address (an internal provider, tests). Metadata IPs stay blocked. */
  OIDC_ALLOW_INSECURE_ISSUER: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /**
   * The origin MCP clients reach the MCP server at, e.g. https://mcp.example.com (it may equal PUBLIC_URL
   * behind one reverse proxy). Setting it turns on OAuth for the remote MCP servers (ADR 0010): their
   * resource URLs are <MCP_PUBLIC_URL>/mcp/ops and /mcp/admin. Needs PUBLIC_URL and MCP_SERVICE_SECRET.
   */
  MCP_PUBLIC_URL: z.string().optional(),
  /**
   * A random secret both the API and the MCP process hold (at least 32 characters). The MCP process
   * sends it with every call it makes for an OAuth access token; without it the API refuses such tokens.
   */
  MCP_SERVICE_SECRET: z.string().optional(),
  OAUTH_ACCESS_TOKEN_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  /** A refresh token unused for this long expires. Each use rotates it. */
  OAUTH_REFRESH_TOKEN_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** The longest an approved connection lasts, however often it refreshes; then the member approves again. */
  OAUTH_GRANT_MAX_DAYS: z.coerce.number().int().min(1).max(730).default(180),
  /** Serve the web UI from this process when its built files are present (packages/web). "false"/"0" (any case): API only. */
  WEB_UI: z.string().default("true").transform(webUiOn),
  /** Where the built UI is. Default: web/ next to the server (the Docker image), else packages/web/dist in the source tree. */
  WEB_UI_DIR: z.string().optional(),
});

export type Config = z.infer<typeof Env>;

let cached: Config | undefined;

/** Forgets the parsed settings, so the next config() reads the environment again. For tests. */
export function resetConfig(): void {
  cached = undefined;
}

export function config(): Config {
  if (!cached) {
    const parsed = Env.safeParse(process.env);
    if (!parsed.success) {
      throw new ConfigError(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    cached = parsed.data;
  }
  return cached;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const UNSET_HINT = "the server won't start until it is fixed (or unset, which turns people sign-in off)";

/**
 * The public origin people sign in at, or null when people sign-in is off (PUBLIC_URL unset).
 * Throws for anything but a bare origin, and for plain http anywhere but localhost: a session
 * cookie must never cross the network unencrypted. `local` marks http on localhost, where the
 * cookies can't use the Secure attribute or the __Host- prefix. assertStartupConfig calls this, so
 * a set but invalid PUBLIC_URL stops the server from starting rather than quietly turning sign-in off.
 */
export function publicOrigin(): { origin: string; local: boolean } | null {
  const raw = config().PUBLIC_URL?.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`PUBLIC_URL is not a valid URL; ${UNSET_HINT}`);
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) {
    throw new ConfigError(`PUBLIC_URL must be an origin only, e.g. https://crm.example.com (no path, query or credentials); ${UNSET_HINT}`);
  }
  if (u.protocol === "https:") return { origin: u.origin, local: false };
  if (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname)) return { origin: u.origin, local: true };
  throw new ConfigError(`PUBLIC_URL must use https:// (plain http is allowed only for localhost); ${UNSET_HINT}`);
}

/**
 * OAuth for the remote MCP servers (ADR 0010), or null when it is off (MCP_PUBLIC_URL unset). The
 * issuer is the public origin; the two resources are the MCP endpoints as clients see them. Throws
 * when MCP_PUBLIC_URL is set but invalid, or the settings it needs are missing, so a half-configured
 * server refuses to start rather than quietly accepting tokens it can't protect.
 */
export function oauthSettings(): { issuer: string; resources: { ops: string; admin: string }; mcpOrigin: string; serviceSecret: string } | null {
  const raw = config().MCP_PUBLIC_URL?.trim();
  if (!raw) return null;
  const hint = "it turns on OAuth for MCP; fix it or unset it";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`MCP_PUBLIC_URL is not a valid URL; ${hint}`);
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) {
    throw new ConfigError(`MCP_PUBLIC_URL must be an origin only, e.g. https://mcp.example.com; ${hint}`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname))) {
    throw new ConfigError(`MCP_PUBLIC_URL must use https:// (plain http is allowed only for localhost); ${hint}`);
  }
  const pub = publicOrigin();
  if (!pub) throw new ConfigError(`OAuth for MCP needs PUBLIC_URL (people sign in there to approve a connection); ${hint}`);
  const secret = config().MCP_SERVICE_SECRET?.trim() ?? "";
  if (!randomEnough(secret)) {
    throw new ConfigError("OAuth for MCP needs MCP_SERVICE_SECRET, a random value shared by the API and MCP processes: at least 32 characters with at least 16 different "
      + `ones (or 64 hex digits). Generate one with \`openssl rand -base64 32 | tr '+/' '-_' | tr -d '='\` or \`openssl rand -hex 32\`, or run \`sh scripts/init-env.sh\`; ${hint}`);
  }
  return { issuer: pub.origin, mcpOrigin: u.origin, resources: { ops: `${u.origin}/mcp/ops`, admin: `${u.origin}/mcp/admin` }, serviceSecret: secret };
}

/**
 * Whether a shared secret looks random: at least 32 characters, not a placeholder, not a shorter
 * string repeated, and with at least 16 different characters (a random 32-character base62 string has
 * about 25), or 64 or more hex digits with at least 10 different ones (hex has only 16).
 */
export function randomEnough(secret: string): boolean {
  if (secret.length < 32 || isPlaceholderPassword(secret)) return false;
  for (let p = 1; p <= secret.length / 2; p++) if (secret.slice(p) === secret.slice(0, -p)) return false;
  const distinct = new Set(secret).size;
  return distinct >= 16 || (/^[0-9a-f]{64,}$/i.test(secret) && distinct >= 10);
}

/** Decodes the 32-byte master key used to wrap tenant data keys. */
export function masterKey(): Buffer {
  const raw = config().HLCRM_MASTER_KEY;
  if (!raw) throw new ConfigError("HLCRM_MASTER_KEY is required (32 random bytes, base64). Run `sh scripts/init-env.sh`.");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new ConfigError("HLCRM_MASTER_KEY must decode to exactly 32 bytes");
  if (key.every((b) => b === key[0])) throw new ConfigError("HLCRM_MASTER_KEY is a placeholder (all bytes identical). Generate one with `openssl rand -base64 32`.");
  return key;
}

const PLACEHOLDER_PASSWORD = /^(change[-_ ]?me|changeme|password|passw0rd|postgres|secret|example|placeholder|test|admin|hlcrm|todo|x+|\*+|0+|1234.*|your[-_ ].*|<.*>|.*change[-_ ]?me.*)$/i;

/** True when a password is empty or an obvious placeholder (e.g. `change-me`). */
export function isPlaceholderPassword(pw: string): boolean {
  return pw.trim() === "" || PLACEHOLDER_PASSWORD.test(pw.trim());
}

function assertDbUrl(name: string, url: string | undefined, required: boolean): void {
  if (!url) {
    if (required) throw new ConfigError(`${name} is required`);
    return;
  }
  let pw: string;
  try {
    pw = decodeURIComponent(new URL(url).password);
  } catch {
    throw new ConfigError(`${name} is not a valid URL`);
  }
  if (isPlaceholderPassword(pw)) {
    throw new ConfigError(`${name} has an empty or placeholder password. Set a strong random password (run \`sh scripts/init-env.sh\`).`);
  }
}

/**
 * Validates the settings each role needs, eagerly, before the process does any work.
 * Refuses empty or placeholder database passwords and a missing or placeholder master key.
 */
export function assertStartupConfig(role: "api" | "worker" | "cli" | "migrate" | "mcp"): void {
  const c = config();
  if (role === "migrate") {
    assertDbUrl("MIGRATOR_DATABASE_URL", c.MIGRATOR_DATABASE_URL, true);
    assertDbUrl("DATABASE_URL", c.DATABASE_URL, false);
    return;
  }
  if (role === "mcp") {
    oauthSettings();
    return;
  }
  assertDbUrl("DATABASE_URL", c.DATABASE_URL, true);
  masterKey();
  publicOrigin();
  if ([c.OIDC_ISSUER, c.OIDC_CLIENT_ID, c.OIDC_CLIENT_SECRET].some(Boolean) && ![c.OIDC_ISSUER, c.OIDC_CLIENT_ID, c.OIDC_CLIENT_SECRET].every(Boolean)) {
    throw new ConfigError("Single sign-on needs OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET together");
  }
  if (c.OIDC_ISSUER && !publicOrigin()) throw new ConfigError("Single sign-on needs PUBLIC_URL (its redirect URI is built from it)");
  oauthSettings();
}
