import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/overlays";
import { ToastProvider } from "@/components/ui/toast";
import { ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import type { FieldMeta, ObjectMeta, SessionInfo } from "@/lib/api/types";
import { SessionProvider, type SessionValue } from "@/lib/session";
import { createAppRouter } from "@/router";

export interface Call { method: string; path: string; query: URLSearchParams; body: unknown; headers: Record<string, string> }
export type Handler = (c: Call) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

/** A fetch that answers from `handler` and records every call. Unanswered calls get 404 problems. */
export function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = { method: init?.method ?? "GET", path: url.pathname, query: url.searchParams, // A file upload's body is the file itself, not JSON.
      body: init?.body instanceof Blob ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined, headers };
    calls.push(call);
    const r = handler(call) ?? { status: 404, body: { code: "not_found", detail: `No fake for ${call.method} ${call.path}`, status: 404 } };
    const status = r.status ?? 200;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status, headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json", ...(r.headers ?? {}) },
    });
  };
  return { fetch: fn as typeof fetch, calls };
}

export const SESSION: SessionInfo = {
  session: { id: "ses_1", method: "server_link", signed_in_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(), idle_expires_at: new Date(Date.now() + 3_600_000).toISOString() },
  csrf_token: "csrf-1",
  member: { id: "usr_ME", email: "me@example.com", name: "Mia Example", has_password: true, sso_linked: false },
  workspace: { id: "ws_1", name: "Test Co", currency: "USD", modules: ["core", "sales"], sign_in: { password: true, sso: true, sso_allowed_domains: [], oauth_apps: true, oauth_scopes: ["ops:read", "ops:write", "restricted:read", "admin"] } },
  role: "owner",
  permissions: ["records:read", "records:write", "records:archive", "views:manage"],
  server: { connected_apps: true },
};

/** A fresh self-hosted server: passwords on, no email, no single sign-on. */
export const CAPABILITIES = { enabled: true, methods: { email_code: false, password: true, sso: null }, code_length: 8 };

export function sessionValue(s: SessionInfo = SESSION): SessionValue {
  const perms = new Set(s.permissions);
  return { ...s, can: (p) => perms.has(p), isOwner: s.role === "owner" };
}

/** Renders `ui` inside the app's providers and a memory router (so links work), talking to `handler`. */
export function renderApp(ui: ReactNode, handler: Handler = () => undefined, opts: { session?: SessionInfo; client?: QueryClient } = {}) {
  const { fetch, calls } = fakeFetch(handler);
  const api = new ApiClient({ fetch, sleep: async () => {} });
  api.setCsrfToken("csrf-1");
  const qc = opts.client ?? new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = createRoute({ getParentRoute: () => root, path: "/", component: () => <>{ui}</> });
  const any = [
    createRoute({ getParentRoute: () => root, path: "/o/$object", component: () => <p>list page</p> }),
    createRoute({ getParentRoute: () => root, path: "/o/$object/$id", component: () => <p>record page</p> }),
  ];
  const router = createRouter({ routeTree: root.addChildren([page, ...any]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const utils = render(
    <ApiProvider value={api}>
      <QueryClientProvider client={qc}>
        <SessionProvider value={sessionValue(opts.session)}>
          <TooltipProvider><ToastProvider><RouterProvider router={router as never} /></ToastProvider></TooltipProvider>
        </SessionProvider>
      </QueryClientProvider>
    </ApiProvider>,
  );
  return { ...utils, calls, api, qc, router };
}

export const field = (f: Partial<FieldMeta> & Pick<FieldMeta, "name" | "type">): FieldMeta => ({ label: f.name.replace(/_/g, " "), access: "write", ...f });

export function objectMeta(o: Partial<ObjectMeta> & { name: string; fields: FieldMeta[] }): ObjectMeta {
  return {
    label: o.name, plural_label: `${o.name}s`, id_prefix: o.name.slice(0, 3), standard: false, owned: false, access: { read: true, write: true, archive: true },
    currency: "USD", system_fields: [], ...o,
  };
}

/**
 * The whole app (its router, shell and pages) at `path`, talking to `handler`. The session, preferences,
 * object list and inbox count answer with defaults unless `handler` answers them.
 */
export function renderRoute(path: string, handler: Handler, opts: { session?: SessionInfo; objects?: unknown[] } = {}) {
  const defaults: Handler = (c) => {
    if (c.path === "/v1/auth/session") return { body: opts.session ?? SESSION };
    if (c.path === "/auth/capabilities") return { body: CAPABILITIES };
    if (c.path === "/v1/me/preferences") return { body: { data: {} } };
    if (c.path === "/v1/me/attention") return { body: { data: { counts: { unread: 0, critical: 0, warning: 0, info: 0, snoozed: 0 }, items: [], overdue_tasks: [], guidance: "", generated_at: "" } } };
    if (c.path === "/v1/objects") return { body: { data: opts.objects ?? [] } };
    return undefined;
  };
  const { fetch, calls } = fakeFetch((c) => handler(c) ?? defaults(c));
  const api = new ApiClient({ fetch, sleep: async () => {} });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createAppRouter({ api, queryClient: qc }, createMemoryHistory({ initialEntries: [path] }));
  const utils = render(
    <ApiProvider value={api}>
      <QueryClientProvider client={qc}>
        <TooltipProvider><ToastProvider><RouterProvider router={router} /></ToastProvider></TooltipProvider>
      </QueryClientProvider>
    </ApiProvider>,
  );
  return { ...utils, calls, api, qc, router };
}
