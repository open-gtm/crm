import { sha256 } from "../lib/crypto.js";
import { addressKey } from "../lib/outbound.js";
import { canonicalEmail } from "./identity.js";

/**
 * In-memory sign-in and OAuth limits, per process, bounded like the API's limiters. Each is a fixed
 * window counter. Limits keyed by an email apply whether or not the email belongs to anyone, so
 * hitting one says nothing about the account.
 *
 * Three stores: OAuth limits are keyed by whatever unauthenticated callers send (client IDs, hosts,
 * addresses), so they live apart and churning them can never push a sign-in window out; automation
 * email has its own server-wide ceiling in a store of its own, so neither kind of email can use up or
 * evict the other's budget. Past its size, a store drops expired and unblocked windows first: a
 * blocked window outlives the pressure.
 */
interface Window { count: number; resetAt: number; max: number }
type Store = "signin" | "oauth" | "automail";
const stores: Record<Store, Map<string, Window>> = { signin: new Map(), oauth: new Map(), automail: new Map() };
const MAX_ENTRIES = 100_000;

export interface Limit { name: string; max: number; windowMs: number; store?: Store }

const MIN = 60_000;
export const LIMITS = {
  /** Sign-in requests of any kind from one client address. */
  address: { name: "addr", max: 60, windowMs: 15 * MIN },
  /**
   * Code requests for one email from one client address (5 in 15 minutes), and for one email from
   * anywhere (30 a day): an inbox can't be flooded, and someone requesting codes for your address
   * from elsewhere uses up only the daily allowance, not yours for the next quarter hour.
   */
  emailBurst: { name: "email15", max: 5, windowMs: 15 * MIN },
  emailDay: { name: "email24", max: 30, windowMs: 24 * 60 * MIN },
  /** Password attempts for one email from one client address, before (and besides) the per-account lockout. */
  password: { name: "pw", max: 10, windowMs: 15 * MIN },
  /**
   * Sign-in emails per workspace a message is for, so the members of one workspace (or someone asking
   * for codes for all of them) can't use up what everyone else needs. A message for memberships in
   * several workspaces goes out if any of them has room. Past it, the send is skipped and logged.
   */
  workspaceEmail: { name: "mailws", max: 60, windowMs: MIN },
  /** Sign-in emails the whole server sends: a last resort far above any one workspace's share. Past it, sends are skipped and logged as errors. */
  globalEmail: { name: "mail", max: 600, windowMs: MIN },
  /** Invitations, a budget of their own (they never use the sign-in one): per workspace and per inviting member, answered with 429. */
  inviteWorkspace: { name: "invws", max: 50, windowMs: 60 * MIN },
  inviteMember: { name: "invby", max: 20, windowMs: 60 * MIN },
  inviteGlobal: { name: "inv", max: 120, windowMs: MIN },
  /**
   * OAuth for MCP (ADR 0010; the full table is in docs/mcp/oauth.md). Addresses are counted per
   * IPv6 /64 (addressKey). No budget shared by every user of a client is charged for a request that
   * proves nothing: a public client_id is public. Hosted clients (Claude, ChatGPT) call the token
   * endpoint for all their users from a few addresses, so the per-address limits are generous.
   */
  /** Registrations per address, and per IPv6 /48 (one holder of a /48 has 65,536 /64s). */
  oauthRegister: { name: "oreg", max: 20, windowMs: 60 * MIN, store: "oauth" },
  oauthRegisterNet: { name: "oregnet", max: 200, windowMs: 60 * MIN, store: "oauth" },
  /** Registrations server-wide: past it, an alarm in the log, never a refusal (a few addresses could otherwise stop every new connection). */
  oauthRegisterAll: { name: "oregall", max: 300, windowMs: 60 * MIN, store: "oauth" },
  oauthAuthorize: { name: "oauthz", max: 120, windowMs: 15 * MIN, store: "oauth" },
  /** Per client and workspace, counted only for a signed-in member's request whose redirect URI checked out. */
  oauthAuthorizeClient: { name: "oauthzc", max: 2_000, windowMs: 15 * MIN, store: "oauth" },
  oauthToken: { name: "otok", max: 600, windowMs: MIN, store: "oauth" },
  /** Token requests that proved nothing (unknown client, no such code or refresh token), per client_id and address. */
  oauthTokenUnproven: { name: "otoku", max: 300, windowMs: MIN, store: "oauth" },
  /** Token requests whose code or refresh token was found (or whose assertion verified), per client and workspace. */
  oauthTokenClient: { name: "otokc", max: 1_200, windowMs: MIN, store: "oauth" },
  oauthRevoke: { name: "orev", max: 120, windowMs: MIN, store: "oauth" },
  /** Refetches of a client document or key set already known (cached, or fetched before), per host. */
  oauthDocumentHost: { name: "odoc", max: 60, windowMs: MIN, store: "oauth" },
  /** Fetches of URLs never seen before, per registrable domain and per caller address: bogus URLs can't use up a real client's budget. */
  oauthDocumentNewDomain: { name: "odocn", max: 30, windowMs: MIN, store: "oauth" },
  oauthDocumentNewCaller: { name: "odocc", max: 20, windowMs: MIN, store: "oauth" },
  /**
   * Automation email (`send_email`) the whole server sends, whatever the workspace: a last resort above every
   * workspace's hourly cap (those are durable, in automation_usage). Apart from the sign-in and invitation
   * budgets: automation email can't use up sign-in codes' room, nor the reverse.
   */
  automationEmail: { name: "automail", max: 600, windowMs: MIN, store: "automail" },
} satisfies Record<string, Limit>;

/** The key a caller's address is counted under (lib/outbound.ts): every limiter that counts per address uses it. */
export { addressKey };

/** A stable, non-reversible key for an email (in its canonical form), so the limiter never holds addresses. */
export const emailKey = (email: string) => sha256(`limit:${canonicalEmail(email)}`).toString("base64url").slice(0, 22);

/** Counts one hit. Returns null if allowed, else seconds until the window resets. */
export function hit(limit: Limit, key: string, now = Date.now()): number | null {
  const windows = stores[limit.store ?? "signin"];
  const k = `${limit.name}:${key}`;
  const w = windows.get(k);
  const cur = w && w.resetAt > now ? w : { count: 0, resetAt: now + limit.windowMs, max: limit.max };
  if (cur.count >= limit.max) return Math.ceil((cur.resetAt - now) / 1000);
  cur.count++;
  windows.delete(k);
  windows.set(k, cur);
  if (windows.size > MAX_ENTRIES) evict(windows, now);
  return null;
}

/** Seconds until the window resets if this key is used up, else null; counts nothing. */
export function peek(limit: Limit, key: string, now = Date.now()): number | null {
  const w = stores[limit.store ?? "signin"].get(`${limit.name}:${key}`);
  return w && w.resetAt > now && w.count >= limit.max ? Math.ceil((w.resetAt - now) / 1000) : null;
}

/**
 * Makes room, oldest first: expired and unblocked windows go; a blocked one moves to the young end
 * and stays. Only when a whole pass finds nothing but blocked windows does the oldest go anyway.
 */
function evict(windows: Map<string, Window>, now: number): void {
  let kept = 0;
  for (const [k, w] of windows) {
    if (windows.size <= MAX_ENTRIES) return;
    windows.delete(k);
    if (w.resetAt > now && w.count >= w.max && kept++ < windows.size) windows.set(k, w);
  }
}

/** For tests. */
export function resetSignInLimits(): void {
  stores.signin.clear();
  stores.oauth.clear();
  stores.automail.clear();
}
