import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, lazyRouteComponent, Outlet, type RouterHistory } from "@tanstack/react-router";
import { AppShell } from "./features/shell/AppShell";
import { NotFoundPage } from "./features/shell/NotFound";
import type { ApiClient } from "./lib/api/client";

/**
 * Routes. The URL is the source of truth for where you are and what a list shows (view, filter, sort,
 * columns), so any screen can be bookmarked or shared. Every page but the shell is its own chunk.
 */

export interface RouterContext { api: ApiClient; queryClient: QueryClient }

/**
 * How search params are written and read. The router's default JSON-encodes values and turns numbers
 * and true/false into non-strings, so a string that looks like JSON got quotes: `reauth=1` became
 * `reauth=%221%22`. Here plain values (view, sort, columns, pipeline, return_to, reauth…) stay plain
 * text both ways, and only structured ones (a list's or the board's filter) are JSON, compact and
 * bookmarkable. On read, a JSON object or array is parsed; a JSON-quoted string (the old form, in
 * bookmarks made before) is unquoted; anything else is the text it is. Each route's validateSearch
 * then checks what it accepts.
 */
export function parseSearchValue(v: string): unknown {
  if (v.startsWith("{") || v.startsWith("[")) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  if (v.startsWith('"')) {
    try {
      const s: unknown = JSON.parse(v);
      if (typeof s === "string") return s;
    } catch {
      // not JSON: plain text that starts with a quote
    }
  }
  return v;
}

export function parseSearch(searchStr: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(searchStr.startsWith("?") ? searchStr.slice(1) : searchStr)) {
    if (!Object.hasOwn(out, k)) out[k] = parseSearchValue(v);
  }
  return out;
}

export function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) {
    if (v === undefined) continue;
    // A string that would read back as something else (it starts with { [ or ") is written as JSON; other strings as they are.
    const text = typeof v === "string" ? (parseSearchValue(v) === v ? v : JSON.stringify(v)) : v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
    params.set(k, text);
  }
  const str = params.toString();
  return str ? `?${str}` : "";
}

const str = (v: unknown, max = 200) => (typeof v === "string" && v.length <= max ? v : undefined);

/** `layout`: how the list is shown (a table when absent). `by`: the field a board's columns or a calendar's days come from. `group`: the field a table's rows are grouped by. `month`: the calendar's month. */
export interface ListSearch { view?: string; sort?: string; cols?: string; filter?: unknown; layout?: "board" | "calendar"; by?: string; group?: string; month?: string }
export function validateListSearch(s: Record<string, unknown>): ListSearch {
  const out: ListSearch = {};
  const view = str(s.view, 64);
  if (view && /^v_[0-9A-Za-z]+$/.test(view)) out.view = view;
  const sort = str(s.sort, 300);
  if (sort !== undefined) out.sort = sort;
  const cols = typeof s.cols === "string" && s.cols.length <= 6000 ? s.cols : undefined;
  if (cols !== undefined) out.cols = cols;
  if (s.filter !== undefined && s.filter !== null) out.filter = s.filter;
  if (s.layout === "board" || s.layout === "calendar") out.layout = s.layout;
  const name = (v: unknown) => {
    const x = str(v, 64);
    return x && /^[a-z][a-z0-9_]*$/.test(x) ? x : undefined;
  };
  if (name(s.by)) out.by = name(s.by);
  if (name(s.group)) out.group = name(s.group);
  const month = str(s.month, 7);
  if (month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) out.month = month;
  return out;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  notFoundComponent: NotFoundPage,
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  validateSearch: (s: Record<string, unknown>): { return_to?: string; workspace?: string; reauth?: "1" } => ({
    // As long as the server keeps (MAX_RETURN_TO): an OAuth authorization request comes back through here.
    ...(str(s.return_to, 2048) ? { return_to: str(s.return_to, 2048) } : {}),
    ...(str(s.workspace, 64) ? { workspace: str(s.workspace, 64) } : {}),
    ...(s.reauth === "1" || s.reauth === 1 || s.reauth === true ? { reauth: "1" as const } : {}),
  }),
  component: lazyRouteComponent(() => import("./features/auth/SignInPage"), "SignInPage"),
});

const signedOutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signed-out",
  component: lazyRouteComponent(() => import("./features/auth/SignInPage"), "SignedOutPage"),
});

const appRoute = createRoute({ getParentRoute: () => rootRoute, id: "app", component: AppShell });

const homeRoute = createRoute({
  getParentRoute: () => appRoute, path: "/", component: lazyRouteComponent(() => import("./features/home/HomePage"), "HomePage"),
});

export const listRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/o/$object",
  validateSearch: validateListSearch,
  component: lazyRouteComponent(() => import("./features/list/ObjectListPage"), "ObjectListPage"),
});

/** The layout editor of an object's record page. A static segment, so it wins over a record ID; no record ID is "customize". */
export const customizeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/o/$object/customize",
  validateSearch: (s: Record<string, unknown>): { record?: string } => (typeof s.record === "string" && /^[a-z]{1,8}_[0-9A-Za-z]{26}$/.test(s.record) ? { record: s.record } : {}),
  component: lazyRouteComponent(() => import("./features/layout-editor/LayoutEditorPage"), "LayoutEditorPage"),
});

export const recordRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/o/$object/$id",
  component: lazyRouteComponent(() => import("./features/record/RecordPage"), "RecordPage"),
});

export const boardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/board",
  validateSearch: (s: Record<string, unknown>): { pipeline?: string; filter?: unknown } => ({
    ...(str(s.pipeline, 64) ? { pipeline: str(s.pipeline, 64) } : {}),
    ...(s.filter !== undefined && s.filter !== null ? { filter: s.filter } : {}),
  }),
  component: lazyRouteComponent(() => import("./features/board/DealsBoard"), "DealsBoard"),
});

const tasksRoute = createRoute({
  getParentRoute: () => appRoute, path: "/tasks", component: lazyRouteComponent(() => import("./features/inbox/TasksPage"), "TasksPage"),
});

export const inboxRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/inbox",
  validateSearch: (s: Record<string, unknown>): { state?: string } => {
    const state = str(s.state, 20);
    return state && ["open", "unread", "acknowledged", "snoozed", "resolved", "all"].includes(state) ? { state } : {};
  },
  component: lazyRouteComponent(() => import("./features/inbox/InboxPage"), "InboxPage"),
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute, path: "/settings", component: lazyRouteComponent(() => import("./features/settings/SettingsLayout"), "SettingsLayout"),
});
const settingsIndex = createRoute({ getParentRoute: () => settingsRoute, path: "/", component: lazyRouteComponent(() => import("./features/settings/SettingsLayout"), "SettingsIndex") });
const settingsAccount = createRoute({ getParentRoute: () => settingsRoute, path: "/account", component: lazyRouteComponent(() => import("./features/settings/AccountSettings"), "AccountSettings") });
const settingsNotifications = createRoute({ getParentRoute: () => settingsRoute, path: "/notifications", component: lazyRouteComponent(() => import("./features/settings/AccountSettings"), "NotificationSettings") });
const settingsWorkspace = createRoute({ getParentRoute: () => settingsRoute, path: "/workspace", component: lazyRouteComponent(() => import("./features/settings/WorkspaceSettings"), "WorkspaceSettings") });
const settingsMembers = createRoute({ getParentRoute: () => settingsRoute, path: "/members", component: lazyRouteComponent(() => import("./features/settings/MembersSettings"), "MembersSettings") });
const settingsRoles = createRoute({ getParentRoute: () => settingsRoute, path: "/roles", component: lazyRouteComponent(() => import("./features/settings/RolesSettings"), "RolesSettings") });
const settingsRole = createRoute({ getParentRoute: () => settingsRoute, path: "/roles/$roleId", component: lazyRouteComponent(() => import("./features/settings/RolesSettings"), "RoleDetail") });
const settingsPermissionSets = createRoute({ getParentRoute: () => settingsRoute, path: "/permission-sets", component: lazyRouteComponent(() => import("./features/settings/RolesSettings"), "PermissionSetsSettings") });
const settingsPermissionSet = createRoute({ getParentRoute: () => settingsRoute, path: "/permission-sets/$roleId", component: lazyRouteComponent(() => import("./features/settings/RolesSettings"), "PermissionSetDetail") });
const settingsCommerce = createRoute({ getParentRoute: () => settingsRoute, path: "/commerce", component: lazyRouteComponent(() => import("./features/settings/CommerceSettings"), "CommerceSettings") });
const settingsKeys = createRoute({ getParentRoute: () => settingsRoute, path: "/api-keys", component: lazyRouteComponent(() => import("./features/settings/ApiKeysSettings"), "ApiKeysSettings") });
const settingsWebhooks = createRoute({ getParentRoute: () => settingsRoute, path: "/webhooks", component: lazyRouteComponent(() => import("./features/settings/WebhooksSettings"), "WebhooksSettings") });
const settingsWebhook = createRoute({ getParentRoute: () => settingsRoute, path: "/webhooks/$webhookId", component: lazyRouteComponent(() => import("./features/settings/WebhooksSettings"), "WebhookDetail") });
const settingsConnections = createRoute({ getParentRoute: () => settingsRoute, path: "/connections", component: lazyRouteComponent(() => import("./features/settings/ConnectionsSettings"), "ConnectionsSettings") });
const settingsConnection = createRoute({ getParentRoute: () => settingsRoute, path: "/connections/$connectionId", component: lazyRouteComponent(() => import("./features/settings/ConnectionsSettings"), "ConnectionDetail") });
const settingsAudit = createRoute({ getParentRoute: () => settingsRoute, path: "/audit", component: lazyRouteComponent(() => import("./features/settings/AuditSettings"), "AuditSettings") });
const settingsSchema = createRoute({ getParentRoute: () => settingsRoute, path: "/schema", component: lazyRouteComponent(() => import("./features/settings/SchemaSettings"), "SchemaSettings") });
const settingsSchemaObject = createRoute({ getParentRoute: () => settingsRoute, path: "/schema/$schemaObject", component: lazyRouteComponent(() => import("./features/settings/SchemaSettings"), "SchemaObject") });
const settingsAutomations = createRoute({ getParentRoute: () => settingsRoute, path: "/automations", component: lazyRouteComponent(() => import("./features/settings/AutomationsSettings"), "AutomationsSettings") });
const settingsAutomationNew = createRoute({ getParentRoute: () => settingsRoute, path: "/automations/new", component: lazyRouteComponent(() => import("./features/settings/AutomationsSettings"), "NewAutomation") });
const settingsAutomation = createRoute({ getParentRoute: () => settingsRoute, path: "/automations/$automationId", component: lazyRouteComponent(() => import("./features/settings/AutomationsSettings"), "AutomationDetail") });
const settingsPacks = createRoute({ getParentRoute: () => settingsRoute, path: "/packs", component: lazyRouteComponent(() => import("./features/settings/AutomationsSettings"), "PacksSettings") });
const settingsDataHealth = createRoute({ getParentRoute: () => settingsRoute, path: "/data-health", component: lazyRouteComponent(() => import("./features/settings/data-health/DataHealthSettings"), "DataHealthSettings") });
const settingsChildren = [settingsIndex, settingsAccount, settingsNotifications, settingsWorkspace, settingsMembers, settingsRoles, settingsRole, settingsPermissionSets, settingsPermissionSet, settingsCommerce, settingsKeys, settingsWebhooks, settingsWebhook, settingsConnections, settingsConnection, settingsAudit, settingsSchema, settingsSchemaObject, settingsAutomations, settingsAutomationNew, settingsAutomation, settingsPacks, settingsDataHealth];

const routeTree = rootRoute.addChildren([
  signInRoute,
  signedOutRoute,
  appRoute.addChildren([homeRoute, listRoute, customizeRoute, recordRoute, boardRoute, tasksRoute, inboxRoute, settingsRoute.addChildren(settingsChildren)]),
]);

export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context,
    ...(history ? { history } : {}),
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    defaultNotFoundComponent: NotFoundPage,
    parseSearch,
    stringifySearch,
  });
}

declare module "@tanstack/react-router" {
  interface Register { router: ReturnType<typeof createAppRouter> }
}
