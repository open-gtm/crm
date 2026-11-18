import { z } from "zod";
import { AlertInput, archiveAlert, backtestAlert, createAlert, getAlert, listAlerts, updateAlert } from "../core/alerts.js";
import { attentionSummary, getMyNotification, getPrefs, myNotifications, PrefsInput, requireUser, setNotificationState, setPrefs } from "../core/notifications.js";
import { route } from "./registry.js";
import { list, nullable, object, plain, R, ref, S } from "./responses.js";

const SaveFlags = z.object({ dry_run: z.boolean().optional(), backtest_days: z.number().int().min(1).max(90).optional() });

// --- My inbox (ops) --------------------------------------------------------------------------

route({
  method: "GET", path: "/v1/me/notifications", scope: "ops:read", tag: "notifications",
  response: plain(object({ data: list(ref("Notification")), next_before: nullable(S.str) })),
  summary: "My notifications, newest first. state: open (default), unread, acknowledged, snoozed, resolved or all",
  query: z.object({ state: z.enum(["open", "unread", "acknowledged", "snoozed", "resolved", "all"]).optional(),
    severity: z.enum(["info", "warning", "critical"]).optional(), limit: z.coerce.number().int().optional(), before: z.string().optional() }),
  handler: async ({ tx, ctx, query }) => ({ body: await myNotifications(tx, ctx, query) }),
});

route({
  method: "GET", path: "/v1/me/notifications/:id", scope: "ops:read", tag: "notifications", summary: "One of my notifications, with its delivery log",
  response: R.notification,
  idParams: { id: "notification" },
  handler: async ({ tx, ctx, params }) => ({ body: { data: await getMyNotification(tx, ctx, params.id!) } }),
});

for (const action of ["acknowledge", "resolve"] as const) {
  route({
    method: "POST", path: `/v1/me/notifications/:id/${action}`, scope: "ops:write", tag: "notifications",
    summary: action === "acknowledge" ? "Acknowledge a notification (seen, still open)" : "Resolve a notification (done; the alert may fire again later)",
    idParams: { id: "notification" }, response: R.notification,
    handler: async ({ tx, ctx, params }) => ({ body: { data: await setNotificationState(tx, ctx, params.id!, action) } }),
  });
}

route({
  method: "POST", path: "/v1/me/notifications/:id/snooze", scope: "ops:write", tag: "notifications", summary: "Snooze a notification until a date-time",
  response: R.notification,
  idParams: { id: "notification" }, body: z.object({ until: z.string() }),
  handler: async ({ tx, ctx, params, body }) => ({ body: { data: await setNotificationState(tx, ctx, params.id!, "snooze", body.until) } }),
});

route({
  method: "GET", path: "/v1/me/attention", scope: "ops:read", tag: "notifications",
  response: R.attention,
  summary: "What needs my attention: open alerts by severity and overdue tasks, in the order to work through them",
  handler: async ({ tx, ctx }) => ({ body: { data: await attentionSummary(tx, ctx) } }),
});

route({
  method: "GET", path: "/v1/me/notification-preferences", scope: "ops:read", tag: "notifications", summary: "My notification preferences",
  response: R.notificationPreferences,
  handler: async ({ tx, ctx }) => ({ body: { data: await getPrefs(tx, requireUser(ctx)) } }),
});

route({
  method: "PATCH", path: "/v1/me/notification-preferences", scope: "ops:write", tag: "notifications",
  response: R.notificationPreferences,
  summary: "Set which severities email me (immediate, digest or off), my digest hour, time zone and quiet hours",
  body: PrefsInput,
  handler: async ({ tx, ctx, body }) => ({ body: { data: await setPrefs(tx, ctx, body) } }),
});

// --- My personal alerts (ops) ----------------------------------------------------------------

route({
  method: "GET", path: "/v1/me/alerts", scope: "ops:read", tag: "alerts", summary: "My personal alerts",
  response: R.alerts,
  handler: async ({ tx, ctx }) => ({ body: { data: await listAlerts(tx, ctx, "mine") } }),
});

route({
  method: "POST", path: "/v1/me/alerts", scope: "ops:write", tag: "alerts",
  response: { ...R.alertWrite, status: 201, alsoStatus: 200 },
  summary: "Create a personal alert (notifies only me). dry_run returns a summary and a backtest without saving",
  body: AlertInput.extend(SaveFlags.shape),
  handler: async ({ tx, ctx, body }) => {
    const { dry_run, backtest_days, ...input } = body;
    return { status: dry_run ? 200 : 201, body: await createAlert(tx, ctx, input, { scope: "personal", dryRun: dry_run ?? false, backtestDays: backtest_days }) };
  },
});

route({
  method: "POST", path: "/v1/me/alerts/backtest", scope: "ops:read", tag: "alerts", summary: "How often a personal alert would have fired recently",
  response: R.alertBacktest,
  body: AlertInput.extend({ backtest_days: z.number().int().min(1).max(90).optional() }),
  handler: async ({ tx, ctx, body }) => {
    const { backtest_days, ...input } = body;
    return { body: { data: await backtestAlert(tx, ctx, input, "personal", backtest_days) } };
  },
});

route({
  method: "PATCH", path: "/v1/me/alerts/:id", scope: "ops:write", tag: "alerts", summary: "Change or pause one of my alerts (supports dry_run)",
  response: R.alertWrite,
  idParams: { id: "alert" }, body: AlertInput.partial().extend(SaveFlags.shape),
  handler: async ({ tx, ctx, params, body }) => {
    const { dry_run, backtest_days, ...patch } = body;
    return { body: await updateAlert(tx, ctx, params.id!, patch, { scope: "personal", dryRun: dry_run ?? false, backtestDays: backtest_days }) };
  },
});

route({
  method: "DELETE", path: "/v1/me/alerts/:id", scope: "ops:write", tag: "alerts", summary: "Delete one of my alerts", idParams: { id: "alert" },
  response: R.alert,
  handler: async ({ tx, ctx, params }) => ({ body: { data: await archiveAlert(tx, ctx, params.id!, "personal") } }),
});

// --- Workspace alerts (admin) ----------------------------------------------------------------

route({
  method: "GET", path: "/v1/alerts", scope: "admin", tag: "alerts", summary: "All alert rules: workspace and personal",
  response: R.alerts,
  handler: async ({ tx, ctx }) => ({ body: { data: await listAlerts(tx, ctx, "all") } }),
});

route({
  method: "POST", path: "/v1/alerts", scope: "admin", tag: "alerts",
  response: { ...R.alertWrite, status: 201, alsoStatus: 200 },
  summary: "Create a workspace alert. dry_run returns a summary and a backtest without saving",
  body: AlertInput.extend(SaveFlags.shape),
  handler: async ({ tx, ctx, body }) => {
    const { dry_run, backtest_days, ...input } = body;
    return { status: dry_run ? 200 : 201, body: await createAlert(tx, ctx, input, { scope: "workspace", dryRun: dry_run ?? false, backtestDays: backtest_days }) };
  },
});

route({
  method: "POST", path: "/v1/alerts/backtest", scope: "admin", tag: "alerts", summary: "How often a workspace alert would have fired recently, with samples",
  response: R.alertBacktest,
  body: AlertInput.extend({ backtest_days: z.number().int().min(1).max(90).optional() }),
  handler: async ({ tx, ctx, body }) => {
    const { backtest_days, ...input } = body;
    return { body: { data: await backtestAlert(tx, ctx, input, "workspace", backtest_days) } };
  },
});

route({
  method: "GET", path: "/v1/alerts/:id", scope: "admin", tag: "alerts", summary: "Get an alert rule", idParams: { id: "alert" },
  response: R.alert,
  handler: async ({ tx, ctx, params }) => ({ body: { data: await getAlert(tx, ctx, params.id!, "any") } }),
});

route({
  method: "PATCH", path: "/v1/alerts/:id", scope: "admin", tag: "alerts", summary: "Change or pause a workspace alert (supports dry_run)",
  response: R.alertWrite,
  idParams: { id: "alert" }, body: AlertInput.partial().extend(SaveFlags.shape),
  handler: async ({ tx, ctx, params, body }) => {
    const { dry_run, backtest_days, ...patch } = body;
    return { body: await updateAlert(tx, ctx, params.id!, patch, { scope: "workspace", dryRun: dry_run ?? false, backtestDays: backtest_days }) };
  },
});

route({
  method: "DELETE", path: "/v1/alerts/:id", scope: "admin", tag: "alerts", summary: "Archive an alert rule (workspace or personal)", idParams: { id: "alert" },
  response: R.alert,
  handler: async ({ tx, ctx, params }) => ({ body: { data: await archiveAlert(tx, ctx, params.id!, "workspace") } }),
});
