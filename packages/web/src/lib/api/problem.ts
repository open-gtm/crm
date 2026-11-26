/**
 * API errors as the app shows them. The API answers every error with an RFC 9457 problem document
 * ({type, title, status, detail, code, request_id, errors}); this turns one into an ApiProblem with a
 * readable title, the request ID (for a bug report), the Retry-After wait, and per-field messages
 * pulled out of the several shapes `errors` takes.
 */

export interface ProblemBody {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  request_id?: string;
  errors?: unknown;
}

export class ApiProblem extends Error {
  readonly status: number;
  readonly code: string;
  /** What to show a person: the server's detail, reworded where it speaks to an API key holder. */
  readonly detail: string;
  /** The server's own words, for a bug report. */
  readonly serverDetail: string;
  readonly requestId: string | null;
  readonly retryAfter: number | null;
  /** Messages by field name, when the API named the fields at fault. */
  readonly fieldErrors: Record<string, string>;
  readonly errors: unknown;

  constructor(init: { status: number; code: string; detail: string; requestId?: string | null; retryAfter?: number | null; errors?: unknown }) {
    const shown = personDetail(init.status, init.code, init.detail);
    super(shown);
    this.name = "ApiProblem";
    this.status = init.status;
    this.code = init.code;
    this.detail = shown;
    this.serverDetail = init.detail;
    this.requestId = init.requestId ?? null;
    this.retryAfter = init.retryAfter ?? null;
    this.errors = init.errors;
    this.fieldErrors = fieldErrorsOf(init.errors);
  }

  /** A short, human title for the problem (the detail says the rest). */
  get title(): string {
    return problemTitle(this.status, this.code);
  }
}

const TITLES: Record<string, string> = {
  unauthenticated: "You're signed out",
  csrf_failed: "This request was refused for safety",
  forbidden: "You don't have access to this",
  recent_sign_in_required: "Confirm it's you first",
  not_found: "Not found",
  version_mismatch: "Changed by someone else",
  conflict: "That conflicts with existing data",
  validation_failed: "Some values need fixing",
  rate_limited: "Too many requests",
  mixed_currencies: "Totals mix currencies",
  view_invalid: "This view no longer fits the schema",
  query_timeout: "That took too long",
  idempotency_not_replayable: "Already done",
  internal_error: "Something went wrong on the server",
  network_error: "Can't reach the server",
  module_disabled: "This part of the CRM is turned off",
  too_many_heavy_requests: "The server is busy",
};

/** Readable names of the role permissions a refusal may name. */
export const PERMISSION_LABELS: Record<string, string> = {
  "records:read": "read records", "records:write": "create and change records", "records:archive": "archive records",
  "restricted:read": "see restricted values", "schema:manage": "change the schema", "members:manage": "manage members",
  "roles:manage": "manage roles", "keys:manage": "manage API keys", "webhooks:manage": "manage webhooks",
  "automations:manage": "manage automations", "alerts:manage": "manage workspace alerts", "audit:read": "read the audit log",
  "views:manage": "manage shared views", "connections:manage": "manage connections",
};
const permissionLabel = (p: string) => (Object.hasOwn(PERMISSION_LABELS, p) ? PERMISSION_LABELS[p]! : p);

/**
 * The server writes its refusals for whoever holds the credential, usually an API key ("This key lacks
 * the "audit:read" permission"). In the app that credential is a person's session, acting with their
 * role, so those are reworded for a person. Only wording changes; the server's text is kept on the problem.
 */
export function personDetail(status: number, code: string, detail: string): string {
  if (code === "recent_sign_in_required") return "For your security, confirm it's you before doing this: your last sign-in was more than 10 minutes ago.";
  if (status !== 403) return detail;
  const lacks = /^This key lacks the "([^"]+)" permission( on every object)?$/.exec(detail);
  if (lacks) return `Your role doesn't allow this: it needs permission to ${permissionLabel(lacks[1]!)}. Ask a workspace admin if you need it.`;
  if (detail === "This key has no effective permissions") return "Your role has no permissions in this workspace. Ask a workspace admin.";
  return detail
    .replace(/needs the ([a-z]+:[a-z]+) permission/g, (_m, p: string) => `needs permission to ${permissionLabel(p)}`)
    .replace(/needs a key with ([a-z]+:[a-z]+)/g, (_m, p: string) => `needs a role that can ${permissionLabel(p)}`)
    .replace(/ directly; use the named operation \(for leads: convert_lead\)$/, " directly: convert the lead from its page instead")
    .replace(/^This key can't/, "Your role can't")
    .replace(/^This key /, "Your access ");
}

export function problemTitle(status: number, code: string): string {
  const known = Object.hasOwn(TITLES, code) ? TITLES[code] : undefined;
  if (known) return known;
  if (status === 0) return TITLES.network_error!;
  if (status === 401) return TITLES.unauthenticated!;
  if (status === 403) return TITLES.forbidden!;
  if (status === 404) return TITLES.not_found!;
  if (status === 409) return TITLES.conflict!;
  if (status === 412) return TITLES.version_mismatch!;
  if (status === 422) return TITLES.validation_failed!;
  if (status === 429) return TITLES.rate_limited!;
  if (status >= 500) return TITLES.internal_error!;
  return "The request failed";
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Field messages from a problem's `errors`, whichever shape it has:
 * - record validation: `{errors: [{field, message}]}`
 * - request validation (zod): `[{path, message}]`
 * - a unique conflict: `{field}`
 */
export function fieldErrorsOf(errors: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (field: unknown, message: unknown) => {
    if (typeof field !== "string" || !field) return;
    const key = field.split(".")[0]!;
    if (!out[key]) out[key] = typeof message === "string" && message ? message : "is not valid";
  };
  const list = Array.isArray(errors) ? errors : isRecord(errors) && Array.isArray(errors.errors) ? errors.errors : null;
  if (list) {
    for (const e of list) if (isRecord(e)) add(e.field ?? e.path, e.message);
  } else if (isRecord(errors) && typeof errors.field === "string") {
    add(errors.field, "already exists on another record");
  }
  return out;
}

/** Reads a fetch Response that failed into an ApiProblem. */
export async function problemFromResponse(res: Response): Promise<ApiProblem> {
  let body: ProblemBody = {};
  try {
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (isRecord(parsed)) body = parsed as ProblemBody;
  } catch {
    // Not JSON (a proxy's error page): fall back to the status.
  }
  const retry = Number(res.headers.get("retry-after"));
  return new ApiProblem({
    status: res.status,
    code: typeof body.code === "string" ? body.code : `http_${res.status}`,
    detail: typeof body.detail === "string" && body.detail ? body.detail : `The server answered ${res.status} ${res.statusText}`.trim(),
    requestId: typeof body.request_id === "string" ? body.request_id : res.headers.get("x-request-id"),
    retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null,
    errors: body.errors,
  });
}

/**
 * The server is busy for this member (too many heavy requests at once, across their tabs) or rate
 * limiting: short-lived, already retried by the request helper. A background refresh that still hits it
 * keeps what's on screen and says "busy, retrying" quietly instead of showing an error.
 */
export const isBusy = (e: unknown): boolean => e instanceof ApiProblem && e.status === 429;

/** Any thrown value as an ApiProblem, so every error is shown the same way. */
export function asProblem(e: unknown): ApiProblem {
  if (e instanceof ApiProblem) return e;
  if (e instanceof Error && e.name === "AbortError") return new ApiProblem({ status: 0, code: "aborted", detail: "The request was cancelled" });
  return new ApiProblem({ status: 0, code: "network_error", detail: e instanceof Error ? e.message : "The request failed" });
}
