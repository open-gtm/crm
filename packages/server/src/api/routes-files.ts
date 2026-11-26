import { z } from "zod";
import { deleteFile, downloadFile, fileLimits, getFile, listFiles, uploadFile, workspaceFileLimits } from "../core/files.js";
import { route } from "./registry.js";
import { data, dataList, nullable, object, ref, S } from "./responses.js";

// --- Files attached to records (core/files.ts, ADR 0011) --------------------------------------

/** A download's file name as a header value: an ASCII fallback, and the real name percent-encoded (RFC 6266). */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

route({
  method: "GET", path: "/v1/records/:id/files", scope: "ops:read", tag: "files", idParams: { id: "record" },
  summary: "The files attached to a record (any object), oldest first. Needs read on the record's object",
  response: dataList(ref("File")),
  handler: async ({ tx, ctx, params }) => ({ body: { data: await listFiles(tx, ctx, params.id!) } }),
});

route({
  method: "POST", path: "/v1/records/:id/files", scope: "ops:write", tag: "files", idParams: { id: "record" },
  summary: "Attach a file to a record: the request body is the file's bytes (any Content-Type), and name= is its name. "
    + "Needs write on the record's object. The size limit is FILE_MAX_MB (10 MB unless the server says otherwise); GET /v1/files/limits shows it",
  response: data(ref("File"), 201),
  rawBody: { maxBytes: () => fileLimits().max_bytes },
  query: z.object({ name: z.string().min(1).max(1000) }),
  // An upload holds a connection while its bytes are written, and costs more than a small request.
  heavy: true,
  cost: () => 5,
  handler: async ({ tx, ctx, params, query, raw }) => ({ status: 201, body: { data: await uploadFile(tx, ctx, params.id!, { name: query.name, data: raw! }) } }),
});

route({
  method: "GET", path: "/v1/files/limits", scope: "ops:read", tag: "files",
  summary: "The largest file an upload may hold and what one workspace's files may hold in all, in bytes",
  response: data(object({ max_bytes: S.int, quota_bytes: { ...nullable(S.int), description: "What the workspace's files may hold in all; null when unlimited" }, max_files_per_record: S.int })),
  handler: async ({ tx }) => ({ body: { data: { ...(await workspaceFileLimits(tx)), max_files_per_record: 100 } } }),
});

route({
  method: "GET", path: "/v1/files/:id", scope: "ops:read", tag: "files", idParams: { id: "file" },
  summary: "A file's name, size, detected type and hash. Needs read on its record's object",
  response: data(ref("File")),
  handler: async ({ tx, ctx, params }) => ({ body: { data: await getFile(tx, ctx, params.id!) } }),
});

route({
  method: "GET", path: "/v1/files/:id/content", scope: "ops:read", tag: "files", idParams: { id: "file" },
  summary: "Download a file's bytes. Always sent as an attachment (never shown inline), whatever its type. Needs read on its record's object; audited",
  response: { schema: { type: "string", format: "binary" }, contentType: "application/octet-stream", description: "The file's bytes" },
  heavy: true,
  cost: () => 2,
  handler: async ({ tx, ctx, params }) => {
    const { file, data: bytes } = await downloadFile(tx, ctx, params.id!);
    return {
      body: bytes,
      headers: {
        // Never the detected type: with no scanner, a file must not render or run in the browser that fetched it.
        "Content-Type": "application/octet-stream",
        "Content-Disposition": disposition(file.name),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-store",
        "Content-Length": String(bytes.length),
      },
    };
  },
});

route({
  method: "DELETE", path: "/v1/files/:id", scope: "ops:write", tag: "files", idParams: { id: "file" },
  summary: "Remove a file from its record and delete its bytes. Needs write on the record's object",
  response: data(object({ id: S.str, deleted: { type: "boolean", const: true } })),
  handler: async ({ tx, ctx, params }) => {
    const out = await deleteFile(tx, ctx, params.id!);
    return { body: { data: out.result }, ...(out.after ? { after: out.after } : {}) };
  },
});
