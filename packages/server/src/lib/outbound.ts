import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

/**
 * Outbound HTTP for webhooks, with server-side request forgery (SSRF) protection:
 * - HTTPS only, no credentials in the URL, no redirects followed.
 * - The host is resolved once, every address is checked against the blocked ranges, and the
 *   connection is pinned to a checked address (so DNS rebinding cannot swap it afterwards).
 * - Cloud metadata addresses are blocked even when private targets are allowed.
 * - 5-second DNS timeout, 10-second request timeout and a 64 KB cap on the response body that is read.
 */

const METADATA = new BlockList();
METADATA.addAddress("169.254.169.254");        // AWS, GCP, Azure, OpenStack instance metadata
METADATA.addAddress("169.254.170.2");          // AWS ECS task metadata
METADATA.addAddress("169.254.170.23");         // AWS EKS pod identity
METADATA.addAddress("fd00:ec2::254", "ipv6");  // AWS IMDS over IPv6
METADATA.addAddress("fd00:ec2::23", "ipv6");

/**
 * Special-purpose ranges (RFC 6890 and the IANA IPv4/IPv6 special-purpose registries), plus
 * multicast and the reserved 240/4. A few entries are globally reachable anycast (AS112, AMT);
 * no webhook receiver lives there, so they are blocked too.
 */
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 96],             // unspecified, loopback and the deprecated IPv4-compatible ::a.b.c.d (RFC 4291)
  ["::ffff:0:0:0", 96],   // IPv4-translated (RFC 2765)
  ["64:ff9b:1::", 48],    // local-use NAT64 (RFC 8215): translates to whatever the local network routes
  ["100::", 64], ["100:0:0:1::", 64], // discard-only and dummy prefixes (RFC 6666, RFC 9780)
  ["2001::", 23],         // IETF protocol assignments: Teredo, benchmarking, ORCHID and others
  ["2001:db8::", 32], ["3fff::", 20], // documentation (RFC 3849, RFC 9637)
  ["2002::", 16],         // 6to4: embeds an IPv4 address
  ["2620:4f:8000::", 48], // AS112
  ["5f00::", 16],         // SRv6 SIDs (RFC 9602)
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], // unique-local, link-local, old site-local, multicast
] as const) PRIVATE.addSubnet(net, bits, "ipv6");

export class BlockedTargetError extends Error {}

/** The eight 16-bit groups of an IPv6 address (any textual form, including a dotted IPv4 tail). */
export function hextets(addr: string): number[] | null {
  let s = addr.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail, extra] = s.split("::");
  if (extra !== undefined) return null;
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  if (fill < 0 || (tail === undefined && h.length !== 8)) return null;
  const out = [...h, ...Array<string>(fill).fill("0"), ...t].map((g) => parseInt(g, 16));
  return out.length === 8 && out.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : null;
}

/**
 * The IPv4 address an IPv6 address carries in its last 32 bits, for the forms that reach it:
 * mapped ::ffff:0:0/96, IPv4-compatible ::/96, IPv4-translated ::ffff:0:0:0/96 and NAT64 64:ff9b::/96.
 */
function embeddedV4(addr: string): string | null {
  const h = hextets(addr);
  if (!h) return null;
  const zero = (from: number, to: number) => h.slice(from, to).every((n) => n === 0);
  const carries = (zero(0, 5) && h[5] === 0xffff) || zero(0, 6) || (zero(0, 4) && h[4] === 0xffff && h[5] === 0)
    || (h[0] === 0x64 && h[1] === 0xff9b && zero(2, 6));
  return carries ? `${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}` : null;
}

/** Why an address may not be contacted, or null if it may. Both the IPv6 form and any IPv4 it carries are checked. */
export function blockedReason(address: string, allowPrivate: boolean): string | null {
  const family = isIP(address);
  if (family === 0) return "not an IP address";
  const forms: [string, "ipv4" | "ipv6"][] = [[address, family === 6 ? "ipv6" : "ipv4"]];
  const v4 = family === 6 ? embeddedV4(address) : null;
  if (v4) forms.push([v4, "ipv4"]);
  if (forms.some(([a, t]) => METADATA.check(a, t))) return "cloud metadata address";
  if (!allowPrivate && forms.some(([a, t]) => PRIVATE.check(a, t))) return "private, loopback, link-local or reserved address";
  return null;
}

export interface TargetPolicy {
  /** Allow http:// and private addresses (self-hosted internal targets, tests). Metadata stays blocked. */
  allowInsecure: boolean;
}

/** Syntactic checks, run when a webhook is registered and again before each send. */
export function checkUrl(raw: string, policy: TargetPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedTargetError("Webhook URL is not a valid URL");
  }
  if (url.protocol !== "https:" && !(policy.allowInsecure && url.protocol === "http:")) {
    throw new BlockedTargetError("Webhook URL must use https://");
  }
  if (url.username || url.password) throw new BlockedTargetError("Webhook URL must not contain credentials");
  if (!url.hostname) throw new BlockedTargetError("Webhook URL needs a host");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    const why = blockedReason(host, policy.allowInsecure);
    if (why) throw new BlockedTargetError(`Webhook URL points at a blocked address (${why})`);
  } else if (!policy.allowInsecure && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local"))) {
    throw new BlockedTargetError("Webhook URL points at an internal host name");
  }
  return url;
}

/**
 * DNS is bounded separately from the request: a send can take at most DNS_TIMEOUT_MS + TIMEOUT_MS.
 * (A lookup that times out keeps its libuv thread until the OS resolver gives up; the caller does not wait for it.)
 */
export const DNS_TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); })])
    .finally(() => clearTimeout(timer));
}

/** Resolves the host and returns one address that passed the checks. `dnsTimeoutMs` shortens the DNS wait (never lengthens it). */
export async function resolveTarget(url: URL, policy: TargetPolicy, dnsTimeoutMs = DNS_TIMEOUT_MS): Promise<{ address: string; family: 4 | 6 }> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  const wait = Math.min(dnsTimeoutMs, DNS_TIMEOUT_MS);
  const addrs = literal ? [{ address: host, family: literal as 4 | 6 }] : await withTimeout(lookup(host, { all: true, verbatim: true }), wait)
    .then((r) => r.map((a) => ({ address: a.address, family: a.family as 4 | 6 })))
    .catch((e: Error) => { throw new BlockedTargetError(`Could not resolve ${host}${e.message === "timeout" ? ` (timed out after ${wait / 1000}s)` : ""}`); });
  if (addrs.length === 0) throw new BlockedTargetError(`Could not resolve ${host}`);
  // Every address must pass: otherwise an attacker could mix a public and a private record.
  for (const a of addrs) {
    const why = blockedReason(a.address, policy.allowInsecure);
    if (why) throw new BlockedTargetError(`${host} resolves to a blocked address (${why})`);
  }
  return addrs[0]!;
}

export interface PostResult { status: number; body: string; durationMs: number }

export const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** POSTs a body to a checked URL, connecting only to the pinned address. Never follows redirects. */
export async function safePost(rawUrl: string, body: string, headers: Record<string, string>, policy: TargetPolicy): Promise<PostResult> {
  const url = checkUrl(rawUrl, policy);
  const pinned = await resolveTarget(url, policy);
  const started = Date.now();
  const mod = url.protocol === "https:" ? https : http;
  return new Promise<PostResult>((resolve, reject) => {
    const req = mod.request(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(body).toString(), "user-agent": "hl-crm-db-webhooks/1" },
      timeout: TIMEOUT_MS,
      lookup: (_host, opts, cb) => {
        // Node calls lookup with { all: true } in some versions; answer in the shape it asked for.
        if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [pinned]);
        else cb(null, pinned.address, pinned.family);
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= MAX_RESPONSE_BYTES) chunks.push(c);
        else res.destroy();
      });
      const done = () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8").slice(0, 2000), durationMs: Date.now() - started });
      res.on("end", done);
      res.on("close", done);
      res.on("error", done);
    });
    const timer = setTimeout(() => req.destroy(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
    req.on("timeout", () => req.destroy(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)));
    req.on("error", (e) => reject(e));
    req.on("close", () => clearTimeout(timer));
    req.end(body);
  });
}

export interface FetchResult { status: number; body: string; headers: Record<string, string | string[] | undefined>; truncated?: boolean }

export class ResponseTooLargeError extends Error {}

/**
 * A request to a checked URL for documents the server reads (identity provider discovery, keys
 * and tokens; the breached-password range API) and for automation HTTP steps. Same SSRF rules as
 * safePost, but the body must fit in `maxBytes` or the request fails (a truncated document is never
 * parsed), unless `truncate` is set: then the reply is cut at `maxBytes` and marked truncated.
 * `deadlineMs` bounds DNS and the request together (otherwise each has its own timeout, so a call
 * can take both).
 */
export async function safeRequest(rawUrl: string, opts: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: string; headers?: Record<string, string>; maxBytes: number;
  timeoutMs?: number; deadlineMs?: number; truncate?: boolean }, policy: TargetPolicy): Promise<FetchResult> {
  const url = checkUrl(rawUrl, policy);
  const started = Date.now();
  const pinned = await resolveTarget(url, policy, opts.deadlineMs ?? DNS_TIMEOUT_MS);
  const timeout = Math.min(opts.timeoutMs ?? TIMEOUT_MS, opts.deadlineMs !== undefined ? Math.max(1, opts.deadlineMs - (Date.now() - started)) : Infinity);
  const mod = url.protocol === "https:" ? https : http;
  return new Promise<FetchResult>((resolve, reject) => {
    const req = mod.request(url, {
      method: opts.method,
      headers: { "user-agent": "hl-crm-db/1", accept: "application/json", ...opts.headers,
        ...(opts.body !== undefined ? { "content-length": Buffer.byteLength(opts.body).toString() } : {}) },
      timeout,
      lookup: (_host, o, cb) => {
        if ((o as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [pinned]);
        else cb(null, pinned.address, pinned.family);
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= opts.maxBytes) chunks.push(c);
        else if (!opts.truncate) res.destroy(new ResponseTooLargeError(`response is larger than ${opts.maxBytes} bytes`));
        else {
          // Keep what fits and stop reading: an automation's HTTP step only needs the start of a reply.
          chunks.push(c.subarray(0, Math.max(0, opts.maxBytes - (size - c.length))));
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers, truncated: true });
          res.destroy();
        }
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
      res.on("error", reject);
    });
    const timer = setTimeout(() => req.destroy(new Error(`timed out after ${timeout / 1000}s`)), timeout);
    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeout / 1000}s`)));
    req.on("error", reject);
    req.on("close", () => clearTimeout(timer));
    req.end(opts.body);
  });
}

/**
 * The key a caller's address is counted under: an IPv6 address by its /64 (one subscriber's
 * allocation, so a host can't rotate through it), an IPv4-mapped one as IPv4, anything else as is.
 * `bits` 48 gives the IPv6 /48 a site gets; IPv4 stays per address.
 */
export function addressKey(addr: string, bits: 64 | 48 = 64): string {
  if (isIP(addr) !== 6) return addr;
  const h = hextets(addr);
  if (!h) return addr;
  if (h.slice(0, 5).every((n) => n === 0) && h[5] === 0xffff) return `${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`;
  return `${h.slice(0, bits / 16).map((n) => n.toString(16)).join(":")}::/${bits}`;
}
