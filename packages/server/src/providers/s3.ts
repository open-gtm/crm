import { createHash, createHmac } from "node:crypto";

/**
 * The three calls the file store needs from an S3-compatible service (AWS S3, MinIO, Cloudflare R2,
 * Backblaze B2): put, get and delete one object, signed with AWS Signature Version 4. Path-style
 * addresses (endpoint/bucket/key), which every such service takes. No SDK: this is all it uses.
 */

export interface S3Config { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string }

const hex = (b: Buffer) => b.toString("hex");
const sha256Hex = (data: Buffer | string) => hex(createHash("sha256").update(data).digest());
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding of one path segment, as SigV4 canonical URIs want it. */
const encodeSegment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The headers that sign one request (SigV4, service s3, the payload's hash in x-amz-content-sha256). Exported for its known-answer test. */
export function signS3(cfg: S3Config, method: string, url: URL, payload: Buffer, now: Date): Record<string, string> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20260101T000000Z
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(payload);
  const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const signed = Object.keys(headers).sort();
  const canonical = [method, url.pathname, url.searchParams.toString(), ...signed.map((h) => `${h}:${headers[h]!}`), "", signed.join(";"), payloadHash].join("\n");
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, date), cfg.region), "s3"), "aws4_request");
  return {
    "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${hex(hmac(key, toSign))}`,
  };
}

export class S3Client {
  constructor(private readonly cfg: S3Config, private readonly fetcher: typeof fetch = fetch) {}

  private url(key: string): URL {
    const base = this.cfg.endpoint.replace(/\/+$/, "");
    return new URL(`${base}/${encodeSegment(this.cfg.bucket)}/${key.split("/").map(encodeSegment).join("/")}`);
  }

  private async send(method: "PUT" | "GET" | "DELETE", key: string, body?: Buffer): Promise<Response> {
    const url = this.url(key);
    const payload = body ?? Buffer.alloc(0);
    const res = await this.fetcher(url, { method, headers: signS3(this.cfg, method, url, payload, new Date()), ...(body ? { body: new Uint8Array(body) } : {}),
      redirect: "error", signal: AbortSignal.timeout(60_000) });
    return res;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const res = await this.send("PUT", key, body);
    if (!res.ok) throw new Error(`The file store refused the upload (HTTP ${res.status})`);
  }

  /** The object's bytes, or null when the store has none under that key. */
  async get(key: string): Promise<Buffer | null> {
    const res = await this.send("GET", key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`The file store refused the download (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Deleting a key that isn't there is not an error. */
  async delete(key: string): Promise<void> {
    const res = await this.send("DELETE", key);
    if (!res.ok && res.status !== 404) throw new Error(`The file store refused the delete (HTTP ${res.status})`);
  }
}
