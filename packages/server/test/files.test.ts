import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sniffContentType } from "../src/core/files.js";
import { decodeId } from "../src/lib/ids.js";
import { S3FileStore, setFileStore } from "../src/providers/files.js";
import { S3Client, signS3 } from "../src/providers/s3.js";
import { app, call, create, memberWithKey, newWorkspace, uniqueEmail, type Workspace } from "./helpers.js";

/**
 * Files attached to records (ADR 0011), through real HTTP calls: upload as raw bytes, list, download as
 * an attachment, remove; access follows the record's object; limits and quota; merges keep every file;
 * and the S3 store, against a small in-process server that keeps objects in memory.
 */

const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
afterAll(() => sql.end());

let ws: Workspace;
const ids = { contact: "", deal: "" };
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2000, 7)]);

/** Sends a file's bytes as the request body. */
async function upload(key: string, record: string, name: string, data: Buffer, headers: Record<string, string> = {}) {
  const res = await app.request(`/v1/records/${record}/files?name=${encodeURIComponent(name)}`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/octet-stream", ...headers }, body: new Uint8Array(data) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined, headers: res.headers };
}

async function download(key: string, file: string) {
  const res = await app.request(`/v1/files/${file}/content`, { headers: { Authorization: `Bearer ${key}` } });
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
}

beforeAll(async () => {
  ws = await newWorkspace("Files");
  const contact = await create(ws.keys.ops, "contact", { first_name: "Fay", email: uniqueEmail("fay") });
  const deal = await create(ws.keys.ops, "deal", { name: "File deal", primary_contact: contact.id, amount: 10 });
  Object.assign(ids, { contact: contact.id, deal: deal.id });
});

describe("files: attach, list, download, remove", () => {
  it("a file goes up as raw bytes and comes back the same, always as a download", async () => {
    const up = await upload(ws.keys.ops, ids.deal, "Signed contract (final).pdf", PDF);
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    const f = up.json.data;
    expect(f).toMatchObject({ record: ids.deal, name: "Signed contract (final).pdf", size: PDF.length, content_type: "application/pdf", scan_status: "unscanned" });
    expect(f.id).toMatch(/^file_/);
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);

    const listed = await call("GET", `/v1/records/${ids.deal}/files`, { key: ws.keys.ops });
    expect(listed.json.data.map((x: { id: string }) => x.id)).toEqual([f.id]);
    expect((await call("GET", `/v1/files/${f.id}`, { key: ws.keys.ops })).json.data).toEqual(f);

    const got = await download(ws.keys.ops, f.id);
    expect(got.status).toBe(200);
    expect(got.bytes.equals(PDF)).toBe(true);
    // Never inline, never the detected type: there is no scanner, so nothing may render or run where it was fetched.
    expect(got.headers.get("content-type")).toBe("application/octet-stream");
    expect(got.headers.get("content-disposition")).toBe(`attachment; filename="Signed contract (final).pdf"; filename*=UTF-8''Signed%20contract%20%28final%29.pdf`);
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("content-security-policy")).toContain("sandbox");
    expect(got.headers.get("cache-control")).toContain("no-store");

    const gone = await call("DELETE", `/v1/files/${f.id}`, { key: ws.keys.ops });
    expect(gone.json.data).toEqual({ id: f.id, deleted: true });
    expect((await call("GET", `/v1/records/${ids.deal}/files`, { key: ws.keys.ops })).json.data).toEqual([]);
    expect((await download(ws.keys.ops, f.id)).status).toBe(404);
    expect((await call("DELETE", `/v1/files/${f.id}`, { key: ws.keys.ops })).status).toBe(404);
    // The bytes are gone; the row stays, marked removed, for the audit trail.
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
      return tx<{ deleted: boolean; blobs: number }[]>`
        SELECT f.deleted_at IS NOT NULL AS deleted, (SELECT count(*)::int FROM file_blobs b WHERE b.file_id = f.id) AS blobs FROM files f WHERE f.id = ${decodeId(f.id)!.uuid}`;
    });
    expect(rows).toEqual([{ deleted: true, blobs: 0 }]);
    const actions = ((await call("GET", "/v1/audit-log?action=file.", { key: ws.keys.admin })).json.data as { action: string }[]).map((e) => e.action);
    for (const a of ["file.uploaded", "file.downloaded", "file.deleted"]) expect(actions).toContain(a);
  });

  it("the type is detected from the bytes, never taken from the uploader", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    const html = Buffer.from("<!doctype html><script>alert(1)</script>");
    const a = await upload(ws.keys.ops, ids.contact, "photo.html", png, { "Content-Type": "text/html" });
    expect(a.json.data.content_type).toBe("image/png");
    const b = await upload(ws.keys.ops, ids.contact, "page.png", html, { "Content-Type": "image/png" });
    expect(b.json.data.content_type).toBe("text/plain");
    const got = await download(ws.keys.ops, b.json.data.id);
    expect(got.headers.get("content-type")).toBe("application/octet-stream");
    expect(sniffContentType(Buffer.from([0, 1, 2, 3]))).toBe("application/octet-stream");
    expect(sniffContentType(Buffer.from("PK\u0003\u0004rest"))).toBe("application/zip");
    // A long text cut inside a multi-byte character is still text.
    expect(sniffContentType(Buffer.from(`${"a".repeat(4095)}é${"b".repeat(100)}`))).toBe("text/plain");
  });

  it("refuses bad names, empty files and files past the size limit", async () => {
    expect((await upload(ws.keys.ops, ids.deal, "../../etc/passwd", PDF)).status).toBe(422);
    expect((await upload(ws.keys.ops, ids.deal, "a\\b.pdf", PDF)).status).toBe(422);
    expect((await upload(ws.keys.ops, ids.deal, "line\nbreak.pdf", PDF)).status).toBe(422);
    expect((await upload(ws.keys.ops, ids.deal, "..", PDF)).status).toBe(422);
    expect((await upload(ws.keys.ops, ids.deal, "x".repeat(256), PDF)).status).toBe(422);
    expect((await upload(ws.keys.ops, ids.deal, "empty.txt", Buffer.alloc(0))).status).toBe(422);
    const noName = await app.request(`/v1/records/${ids.deal}/files`, { method: "POST", headers: { Authorization: `Bearer ${ws.keys.ops}` }, body: new Uint8Array(PDF) });
    expect(noName.status).toBe(422);
    const limits = (await call("GET", "/v1/files/limits", { key: ws.keys.ops })).json.data;
    expect(limits).toEqual({ max_bytes: 10 * 1024 * 1024, quota_bytes: 1024 * 1024 * 1024, max_files_per_record: 100 });
    // Larger than a JSON body may be, well inside the file limit: uploads have their own limit.
    const big = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(3 * 1024 * 1024, 9)]);
    const ok = await upload(ws.keys.ops, ids.deal, "big.pdf", big);
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect((await download(ws.keys.ops, ok.json.data.id)).bytes.length).toBe(big.length);
    const tooBig = await upload(ws.keys.ops, ids.deal, "huge.bin", Buffer.alloc(limits.max_bytes + 1, 1));
    expect(tooBig.status).toBe(413);
    expect(tooBig.json.detail).toContain("10 MB");
    // The 1 MB limit for everything else stays.
    const json = await call("POST", "/v1/objects/contact/records", { key: ws.keys.ops, body: { first_name: "x".repeat(1_100_000) } });
    expect(json.status).toBe(413);
  });

  it("a retried upload with the same Idempotency-Key is replayed, not stored twice", async () => {
    const contact = await create(ws.keys.ops, "contact", { first_name: "Idem", email: uniqueEmail("idem") });
    const key = `up-${Date.now()}`;
    const first = await upload(ws.keys.ops, contact.id, "once.pdf", PDF, { "Idempotency-Key": key });
    const again = await upload(ws.keys.ops, contact.id, "once.pdf", PDF, { "Idempotency-Key": key });
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.json.data.id).toBe(first.json.data.id);
    const other = await upload(ws.keys.ops, contact.id, "once.pdf", Buffer.concat([PDF, Buffer.from("x")]), { "Idempotency-Key": key });
    expect(other.status).toBe(422);
    expect((await call("GET", `/v1/records/${contact.id}/files`, { key: ws.keys.ops })).json.data).toHaveLength(1);
  });
});

describe("files: access follows the record's object", () => {
  it("read lists and downloads, write attaches and removes, and a file's ID alone gives nothing", async () => {
    const f = (await upload(ws.keys.ops, ids.deal, "pricing.pdf", PDF)).json.data;
    const role = (await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: `files_${Date.now().toString(36)}`, name: "Contacts only",
      permissions: [], objects: { contact: { read: true, write: true } } } })).json.data;
    const limited = await memberWithKey(ws, role.key, ["ops:read", "ops:write"]);
    // The deal's files don't exist for someone who can't read deals: by record or by file ID.
    expect((await call("GET", `/v1/records/${ids.deal}/files`, { key: limited.key })).status).toBe(403);
    expect((await call("GET", `/v1/files/${f.id}`, { key: limited.key })).status).toBe(403);
    expect((await download(limited.key, f.id)).status).toBe(403);
    expect((await call("DELETE", `/v1/files/${f.id}`, { key: limited.key })).status).toBe(403);
    expect((await upload(limited.key, ids.deal, "mine.pdf", PDF)).status).toBe(403);
    // On contacts, which they can write, they can.
    expect((await upload(limited.key, ids.contact, "mine.pdf", PDF)).status).toBe(201);

    const reader = await memberWithKey(ws, "read_only", ["ops:read"]);
    expect((await call("GET", `/v1/records/${ids.deal}/files`, { key: reader.key })).status).toBe(200);
    expect((await download(reader.key, f.id)).status).toBe(200);
    // A read-only member, with a key that could write if the role did.
    const readerWrite = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "ro", scopes: ["ops:read"], owner: reader.id } });
    expect((await upload(readerWrite.json.data.secret, ids.deal, "no.pdf", PDF)).status).toBe(403);
    expect((await call("DELETE", `/v1/files/${f.id}`, { key: reader.key })).status).toBe(403);
    expect((await download(ws.keys.ops, "file_01JD0000000000000000000000")).status).toBe(404);
    expect((await call("GET", "/v1/records/con_01JD0000000000000000000000/files", { key: ws.keys.ops })).status).toBe(404);
  });

  it("an archived record keeps its files for reading and takes no new ones", async () => {
    const contact = await create(ws.keys.ops, "contact", { first_name: "Arch", email: uniqueEmail("arch") });
    const f = (await upload(ws.keys.ops, contact.id, "kept.pdf", PDF)).json.data;
    expect((await call("DELETE", `/v1/objects/contact/records/${contact.id}`, { key: ws.keys.ops })).status).toBe(200);
    expect((await download(ws.keys.ops, f.id)).status).toBe(200);
    expect((await upload(ws.keys.ops, contact.id, "late.pdf", PDF)).status).toBe(409);
  });

  it("a merge moves the duplicates' files to the survivor", async () => {
    const a = await create(ws.keys.ops, "contact", { first_name: "Merge", last_name: "Keep", email: uniqueEmail("keep") });
    const b = await create(ws.keys.ops, "contact", { first_name: "Merge", last_name: "Dup", email: uniqueEmail("dup") });
    const fa = (await upload(ws.keys.ops, a.id, "a.pdf", PDF)).json.data;
    const fb = (await upload(ws.keys.ops, b.id, "b.pdf", PDF)).json.data;
    const dry = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: a.id, duplicates: [b.id] } });
    expect(dry.status, JSON.stringify(dry.json)).toBe(200);
    const token = dry.json.confirm_token ?? dry.json.result?.confirm_token ?? dry.json.data?.confirm_token;
    const done = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: a.id, duplicates: [b.id], dry_run: false, confirm_token: token } });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const files = (await call("GET", `/v1/records/${a.id}/files`, { key: ws.keys.ops })).json.data as { id: string; record: string }[];
    expect(files.map((x) => x.id).sort()).toEqual([fa.id, fb.id].sort());
    expect(files.every((x) => x.record === a.id)).toBe(true);
    expect((await download(ws.keys.ops, fb.id)).status).toBe(200);
  });
});

describe("files: the S3 store", () => {
  // Path-style S3, in memory: PUT, GET and DELETE of /bucket/key. Checks each request is signed.
  const objects = new Map<string, Buffer>();
  const seen: { method: string; url: string; auth: string }[] = [];
  let server: Server;
  let endpoint = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization) });
        if (!/^AWS4-HMAC-SHA256 Credential=AKTEST\/\d{8}\/eu-test-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/
          .test(String(req.headers.authorization))) {
          res.writeHead(403).end();
        } else if (req.method === "PUT") {
          objects.set(req.url!, Buffer.concat(chunks));
          res.writeHead(200).end();
        } else if (req.method === "GET") {
          const o = objects.get(req.url!);
          res.writeHead(o ? 200 : 404).end(o);
        } else {
          objects.delete(req.url!);
          res.writeHead(204).end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    setFileStore(new S3FileStore(new S3Client({ endpoint, bucket: "crm-files", region: "eu-test-1", accessKeyId: "AKTEST", secretAccessKey: "secret" })));
  });
  afterAll(async () => {
    setFileStore(null);
    await new Promise((r) => server.close(r));
  });

  it("signs requests as AWS documents (the GET Object example)", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "GET Object", without its Range header.
    const cfg = { endpoint: "https://examplebucket.s3.amazonaws.com", bucket: "", region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
    const h = signS3(cfg, "GET", new URL("https://examplebucket.s3.amazonaws.com/test.txt"), Buffer.alloc(0), new Date("2013-05-24T00:00:00Z"));
    expect(h["x-amz-date"]).toBe("20130524T000000Z");
    expect(h["x-amz-content-sha256"]).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(h.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    // Deterministic: the same request signs the same way, and any change to it changes the signature.
    const again = signS3(cfg, "GET", new URL("https://examplebucket.s3.amazonaws.com/test.txt"), Buffer.alloc(0), new Date("2013-05-24T00:00:00Z"));
    expect(again.Authorization).toBe(h.Authorization);
    const other = signS3(cfg, "GET", new URL("https://examplebucket.s3.amazonaws.com/test2.txt"), Buffer.alloc(0), new Date("2013-05-24T00:00:00Z"));
    expect(other.Authorization).not.toBe(h.Authorization);
  });

  it("keeps bytes in the bucket sealed with the workspace's key, and nothing in Postgres", async () => {
    const contact = await create(ws.keys.ops, "contact", { first_name: "Sthree", email: uniqueEmail("s3") });
    const up = await upload(ws.keys.ops, contact.id, "in-s3.pdf", PDF);
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    const uuid = decodeId(up.json.data.id)!.uuid;
    const key = `/crm-files/${ws.tenantId}/${uuid}`;
    const stored = objects.get(key)!;
    expect(stored).toBeDefined();
    // Sealed: the store never holds the file's bytes in the clear.
    expect(stored.includes(Buffer.from("%PDF-"))).toBe(false);
    expect(stored.length).toBe(PDF.length + 28);
    const [row] = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
      return tx<{ store: string; key_version: number; blobs: number }[]>`
        SELECT store, key_version, (SELECT count(*)::int FROM file_blobs b WHERE b.file_id = f.id) AS blobs FROM files f WHERE f.id = ${uuid}`;
    });
    expect(row).toEqual({ store: "s3", key_version: 1, blobs: 0 });

    const got = await download(ws.keys.ops, up.json.data.id);
    expect(got.status).toBe(200);
    expect(got.bytes.equals(PDF)).toBe(true);
    // Bytes swapped in the bucket are refused, not served.
    objects.set(key, Buffer.concat([stored.subarray(0, stored.length - 1), Buffer.from([stored[stored.length - 1]! ^ 1])]));
    expect((await download(ws.keys.ops, up.json.data.id)).status).toBe(500);
    objects.set(key, stored);

    expect((await call("DELETE", `/v1/files/${up.json.data.id}`, { key: ws.keys.ops })).status).toBe(200);
    expect(objects.has(key)).toBe(false);
    expect(seen.map((s) => s.method)).toEqual(expect.arrayContaining(["PUT", "GET", "DELETE"]));
    // A file written to Postgres earlier is still read from Postgres while the store is S3.
    setFileStore(null);
    const local = await upload(ws.keys.ops, contact.id, "local.pdf", PDF);
    setFileStore(new S3FileStore(new S3Client({ endpoint, bucket: "crm-files", region: "eu-test-1", accessKeyId: "AKTEST", secretAccessKey: "secret" })));
    expect((await download(ws.keys.ops, local.json.data.id)).bytes.equals(PDF)).toBe(true);
  });
});

describe("files: configuration", () => {
  it("reads empty S3 settings (as Docker Compose passes them) as unset, and refuses the S3 store without them", async () => {
    const { resetConfig, config } = await import("../src/config.js");
    const { storeNamed } = await import("../src/providers/files.js");
    const before = { ...process.env };
    try {
      Object.assign(process.env, { FILE_STORE: "postgres", S3_ENDPOINT: "", S3_BUCKET: "", S3_REGION: "", S3_ACCESS_KEY_ID: "", S3_SECRET_ACCESS_KEY: "" });
      resetConfig();
      expect(config()).toMatchObject({ FILE_STORE: "postgres", FILE_MAX_MB: 10, FILE_QUOTA_MB: 1024, S3_REGION: "us-east-1" });
      expect(config().S3_ENDPOINT).toBeUndefined();
      expect(() => storeNamed("s3")).toThrow(/FILE_STORE=s3 needs S3_ENDPOINT/);
    } finally {
      for (const k of ["FILE_STORE", "S3_ENDPOINT", "S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
        if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
      }
      resetConfig();
    }
  });
});
