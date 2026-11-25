/** A problem returned by the hl-crm-db API (RFC 9457). */
export class HlCrmError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
    /** From Retry-After on a 429 (or 503): seconds to wait before retrying. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export type Surface = "api" | "cli" | "admin-mcp" | "ops-mcp";

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  surface?: Surface;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * Allows a plain http:// base URL on a host other than localhost. The API key would cross the
   * network unencrypted, so set this only for a private network you control (e.g. a Compose network).
   */
  allowInsecureHttp?: boolean;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A random v4 UUID from Web Crypto, available in browsers and Node alike, so the SDK has no Node-only
 * import. Browsers offer randomUUID only in secure contexts (https or localhost), so a page reaching a
 * self-hosted install over plain http builds one from getRandomValues, which they always offer.
 */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: Partial<Crypto> }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  if (typeof c?.getRandomValues !== "function") {
    throw new HlCrmError(0, "no_random_source", "This environment has no Web Crypto random source to make an Idempotency-Key; pass idempotencyKey yourself");
  }
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Writes send an idempotency key; one is generated when not given. */
  idempotencyKey?: string;
  ifMatch?: number;
}

/** A thin, typed client for the hl-crm-db REST API. The CLI and MCP servers use it. */
/** A file attached to a record. `content_type` is detected by the server; downloads are always sent as attachments. */
export interface FileInfo {
  id: string; record: string; name: string; size: number; content_type: string; sha256: string; scan_status: string;
  uploaded_by: string | null; created_at: string;
}

export class HlCrmClient {
  private readonly baseUrl: string;

  constructor(private readonly opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    let base: URL;
    try {
      base = new URL(this.baseUrl);
    } catch {
      throw new Error(`hl-crm-db: baseUrl is not a URL: ${opts.baseUrl}`);
    }
    if (base.username || base.password || base.search || base.hash) throw new Error("hl-crm-db: baseUrl must not contain credentials, a query or a fragment");
    if (base.protocol !== "https:" && !(base.protocol === "http:" && (LOOPBACK.has(base.hostname) || opts.allowInsecureHttp))) {
      throw new Error("hl-crm-db: baseUrl must use https:// (http:// is allowed for localhost, or with allowInsecureHttp on a private network)");
    }
  }

  /**
   * Builds the request URL. Paths often carry caller-supplied IDs, so `.` and `..` segments
   * (raw or percent-encoded) are refused: they would let an argument walk to another endpoint.
   */
  private url(path: string): URL {
    if (!path.startsWith("/") || /[?#\\]/.test(path)) throw new Error(`hl-crm-db: invalid request path: ${path}`);
    for (const seg of path.split("/")) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        throw new Error(`hl-crm-db: invalid request path: ${path}`);
      }
      if (decoded === "." || decoded === "..") throw new Error(`hl-crm-db: request path must not contain "." or ".." segments: ${path}`);
    }
    const url = new URL(this.baseUrl + path);
    const base = new URL(this.baseUrl);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/?$/, "/"))) {
      throw new Error(`hl-crm-db: request path leaves the API: ${path}`);
    }
    return url;
  }

  async request<T = unknown>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
    const { text } = await this.send(method, path, options, "application/json");
    return (text ? parseJson(text) : undefined) as T;
  }

  /**
   * Like request, but returns the response body as text with its status and headers, for
   * endpoints that answer with something other than JSON (CSV exports, for example).
   */
  async requestText(method: Method, path: string, options: RequestOptions & { accept?: string } = {}) {
    return this.send(method, path, options, options.accept ?? "*/*");
  }

  private async send(method: string, path: string, options: RequestOptions, accept: string): Promise<{ status: number; headers: Headers; text: string }> {
    const url = this.url(path);
    for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.apiKey}`,
      Accept: accept,
      "X-HLCRM-Surface": this.opts.surface ?? "api",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET") headers["Idempotency-Key"] = options.idempotencyKey ?? newIdempotencyKey();
    if (options.ifMatch !== undefined) headers["If-Match"] = `"v${options.ifMatch}"`;
    const res = await (this.opts.fetch ?? fetch)(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      // Never follow a redirect: fetch would resend the Authorization header to wherever it points.
      redirect: "error",
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      const p = (parseJson(text) ?? {}) as { code?: string; detail?: string; errors?: unknown; request_id?: string };
      const retry = Number(res.headers.get("retry-after") ?? NaN);
      throw new HlCrmError(res.status, p.code ?? "http_error", p.detail ?? `HTTP ${res.status}`, p.errors, p.request_id ?? res.headers.get("x-request-id") ?? undefined,
        Number.isFinite(retry) && retry >= 0 ? retry : undefined);
    }
    return { status: res.status, headers: res.headers, text };
  }

  /**
   * A request whose body, or whose answer, is bytes rather than JSON: a file upload (POST with `body`) or a
   * file download. Errors are the same problem documents as everywhere else.
   */
  private async sendBytes(method: "GET" | "POST", path: string, opts: { query?: RequestOptions["query"]; body?: Uint8Array; idempotencyKey?: string; timeoutMs?: number }):
    Promise<{ headers: Headers; bytes: Uint8Array }> {
    const url = this.url(path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.apiKey}`, Accept: "*/*", "X-HLCRM-Surface": this.opts.surface ?? "api" };
    if (opts.body) headers["Content-Type"] = "application/octet-stream";
    if (method !== "GET") headers["Idempotency-Key"] = opts.idempotencyKey ?? newIdempotencyKey();
    const res = await (this.opts.fetch ?? fetch)(url, { method, headers, ...(opts.body ? { body: new Blob([opts.body as BlobPart]) } : {}), redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? Math.max(this.opts.timeoutMs ?? 30_000, 120_000)) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) {
      const p = (parseJson(new TextDecoder().decode(bytes)) ?? {}) as { code?: string; detail?: string; errors?: unknown; request_id?: string };
      const retry = Number(res.headers.get("retry-after") ?? NaN);
      throw new HlCrmError(res.status, p.code ?? "http_error", p.detail ?? `HTTP ${res.status}`, p.errors, p.request_id ?? res.headers.get("x-request-id") ?? undefined,
        Number.isFinite(retry) && retry >= 0 ? retry : undefined);
    }
    return { headers: res.headers, bytes };
  }

  /** GET /v1/records/{id}/files: the files attached to a record. */
  listFiles(recordId: string) {
    return this.get<{ data: FileInfo[] }>(`/v1/records/${encodeURIComponent(recordId)}/files`);
  }

  /** POST /v1/records/{id}/files: attaches a file (its bytes and its name) to a record. */
  async uploadFile(recordId: string, name: string, data: Uint8Array, opts: { idempotencyKey?: string } = {}): Promise<{ data: FileInfo }> {
    const { bytes } = await this.sendBytes("POST", `/v1/records/${encodeURIComponent(recordId)}/files`, { query: { name }, body: data, ...opts });
    return parseJson(new TextDecoder().decode(bytes)) as { data: FileInfo };
  }

  /** GET /v1/files/{id}/content: a file's bytes. */
  async downloadFile(fileId: string): Promise<Uint8Array> {
    return (await this.sendBytes("GET", `/v1/files/${encodeURIComponent(fileId)}/content`, {})).bytes;
  }

  get<T = unknown>(path: string, query?: RequestOptions["query"]) {
    return this.request<T>("GET", path, { query });
  }
  post<T = unknown>(path: string, body?: unknown, opts: Omit<RequestOptions, "body"> = {}) {
    return this.request<T>("POST", path, { ...opts, body: body ?? {} });
  }
  patch<T = unknown>(path: string, body: unknown, opts: Omit<RequestOptions, "body"> = {}) {
    return this.request<T>("PATCH", path, { ...opts, body });
  }
  delete<T = unknown>(path: string, opts: Omit<RequestOptions, "body"> = {}) {
    return this.request<T>("DELETE", path, opts);
  }
  put<T = unknown>(path: string, body: unknown, opts: Omit<RequestOptions, "body"> = {}) {
    return this.request<T>("PUT", path, { ...opts, body });
  }

  /** POST /v1/query: one page of records, with the shape and paging options of QueryRequest. */
  query(body: QueryRequest) {
    return this.post<Page>("/v1/query", body);
  }
  /** POST /v1/aggregate: counts and totals per group (a board, a summary). */
  aggregate(body: AggregateRequest) {
    return this.post<AggregateResult>("/v1/aggregate", body);
  }
  /** GET /v1/views: saved views this key can use, optionally of one object. */
  async listViews(object?: string) {
    return (await this.get<{ data: SavedView[] }>("/v1/views", { object })).data;
  }
}

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

// Response and request shapes of the read routes. The authenticated OpenAPI document (GET /v1/openapi.json)
// describes every route and each workspace object's record schema in full.

/** A record as the caller may see it: fields the caller can't read are absent. */
export interface RecordData {
  id: string; object: string; display_name?: string; version?: number; created_at?: string; updated_at?: string; archived_at?: string;
  /** With include: related records by relation field, or null for an empty relation. display_name is null when the caller can't read them. */
  included?: Record<string, { id: string; object: string; display_name: string | null; [field: string]: unknown } | null>;
  [field: string]: unknown;
}
export interface Page<R = RecordData> { data: R[]; next_cursor: string | null; total?: number; total_capped?: boolean }
export type Where = { field?: string; path?: string[]; op: string; value?: unknown } | { and: Where[] } | { or: Where[] } | { not: Where };
export interface Sort { field: string; dir?: "asc" | "desc" }
export interface QueryRequest {
  object?: string; where?: Where; sort?: Sort[]; limit?: number; cursor?: string; include_archived?: boolean;
  count?: boolean; fields?: string[]; include?: string[]; view?: string;
}
export interface GroupBy { field: string; bucket?: "day" | "week" | "month" | "quarter" | "year" }
export interface AggregateRequest {
  object?: string; where?: Where; group_by?: GroupBy[]; measures?: { op: "count" | "sum" | "avg" | "min" | "max"; field?: string }[];
  order?: "key" | "count"; limit?: number; include_archived?: boolean; view?: string;
}
export interface AggregateResult {
  data: { group: Record<string, unknown>; count: number; values: Record<string, number | string | null>; currency?: string }[];
  group_by: GroupBy[]; measures: { key: string; op: string; field: string | null }[]; truncated: boolean;
  /** More records matched than the server looks at (100,000): groups and totals cover the most recently updated. */
  rows_capped: boolean;
}
export interface SavedView {
  id: string; object: string | null; name: string; shared: boolean; owner: string | null; mine: boolean;
  status: "ok" | "unavailable" | "broken"; problem?: string;
  where?: Where | null; sort?: Sort[] | null; columns?: string[] | null; group_by?: GroupBy[] | null; version: number;
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}
