import { useQuery, type QueryKey } from "@tanstack/react-query";
import { Link, Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { Bell, Database, FileClock, FileText, KeyRound, Lock, Package, Plug, Settings, Shield, ShieldPlus, UserRound, Users, Webhook, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { NoAccess, PageHeader } from "@/components/feedback";
import { useApi } from "@/lib/api/context";
import { useSession, type SessionValue } from "@/lib/session";

/** Settings sections, each shown only when the member's role allows what it does. */
export const SECTIONS: { to: string; label: string; icon: ReactNode; show: (s: SessionValue) => boolean; needs?: string }[] = [
  { to: "/settings/account", label: "Account and sessions", icon: <UserRound />, show: () => true },
  { to: "/settings/notifications", label: "Notifications", icon: <Bell />, show: () => true },
  { to: "/settings/workspace", label: "Workspace sign-in", icon: <Lock />, show: (s) => s.can("members:manage"), needs: "manage members" },
  { to: "/settings/members", label: "Members", icon: <Users />, show: (s) => s.can("members:manage"), needs: "manage members" },
  { to: "/settings/roles", label: "Roles", icon: <Shield />, show: () => true },
  { to: "/settings/permission-sets", label: "Permission sets", icon: <ShieldPlus />, show: () => true },
  { to: "/settings/api-keys", label: "API keys", icon: <KeyRound />, show: (s) => s.can("keys:manage"), needs: "manage API keys" },
  { to: "/settings/webhooks", label: "Webhooks", icon: <Webhook />, show: (s) => s.can("webhooks:manage"), needs: "manage webhooks" },
  { to: "/settings/connections", label: "Connections", icon: <Plug />, show: (s) => s.can("connections:manage"), needs: "manage connections" },
  { to: "/settings/audit", label: "Audit log", icon: <FileClock />, show: (s) => s.can("audit:read"), needs: "read the audit log" },
  { to: "/settings/automations", label: "Automations", icon: <Zap />, show: (s) => s.can("automations:manage"), needs: "manage automations" },
  { to: "/settings/schema", label: "Objects & fields", icon: <Database />, show: () => true },
  { to: "/settings/commerce", label: "Quotes and orders", icon: <FileText />, show: () => true },
  { to: "/settings/packs", label: "Installed packs", icon: <Package />, show: (s) => ["schema:manage", "roles:manage", "views:manage"].some((p) => s.can(p)), needs: "manage the schema, roles or views" },
];

/** The settings section a path is in. */
export const sectionOf = (path: string) => SECTIONS.find((x) => path === x.to || path.startsWith(`${x.to}/`));

export function SettingsLayout() {
  const s = useSession();
  const path = useRouterState({ select: (r) => r.location.pathname });
  const section = sectionOf(path);
  // Reached by URL without the permission: one clear state instead of the page, its buttons and its errors.
  const allowed = !section || section.show(s);
  return (
    <div className="flex min-h-full flex-col">
      <PageHeader icon={<Settings />} title="Settings" />
      <div className="flex flex-1 flex-col md:flex-row">
        <nav aria-label="Settings" className="border-b border-line bg-surface p-2 md:w-56 md:shrink-0 md:border-b-0 md:border-r md:p-3">
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {SECTIONS.filter((x) => x.show(s)).map((x) => (
              <li key={x.to}>
                <Link to={x.to as never} className="flex h-8 items-center gap-2 whitespace-nowrap rounded-md px-2 text-base text-muted hover:bg-surface-2 hover:text-fg data-[status=active]:bg-accent-soft data-[status=active]:font-medium data-[status=active]:text-accent-soft-fg [&_svg]:size-4">
                  {x.icon}{x.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1 p-4 md:p-6">
          {allowed ? <Outlet /> : (
            <NoAccess title={`You don't have access to ${section!.label.toLowerCase()}`} className="max-w-4xl rounded-lg border border-line bg-surface">
              Your role doesn't include permission to {section!.needs ?? "see this"}. If you need it, ask a workspace admin.
            </NoAccess>
          )}
        </div>
      </div>
    </div>
  );
}

export function SettingsIndex() {
  return <Navigate to="/settings/account" replace />;
}

/** A GET for an admin screen, cached under ["admin", …]. */
export function useAdmin<T>(key: QueryKey, path: string, query?: Record<string, string | number | undefined>, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ["admin", ...key, query ?? {}],
    queryFn: ({ signal }) => api.get<T>(path, query, signal),
    enabled,
  });
}

export function Section({ title, description, actions, children, id }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-h` : undefined} className="mb-6 max-w-4xl rounded-lg border border-line bg-surface">
      <header className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 id={id ? `${id}-h` : undefined} className="text-md font-semibold">{title}</h2>
          {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex gap-2">{actions}</div> : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/**
 * A plain table for settings lists; scrolls sideways on narrow screens, as a focusable region so the
 * keyboard can scroll it. A column without a visible heading (row actions) is named for screen readers.
 */
export function SimpleTable({ head, children, label }: { head: ReactNode[]; children: ReactNode; label: string }) {
  return (
    <div className="-mx-4 -my-4 overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus" role="region" aria-label={label} tabIndex={0}>
      <table className="w-full min-w-[36rem] text-left text-base" aria-label={label}>
        <thead className="border-b border-line bg-surface-2 text-sm text-muted">
          <tr>{head.map((h, i) => <th key={i} scope="col" className="px-4 py-2 font-medium">{h === "" ? <span className="sr-only">Actions</span> : h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}
