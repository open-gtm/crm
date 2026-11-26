import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { PermissionInfo, Role } from "@/lib/api/types";
import { renderRoute, SESSION, type Call } from "./utils";

const ADMIN = { ...SESSION, permissions: [...SESSION.permissions, "members:manage", "roles:manage"] };
const obj = (name: string) => ({ name, label: name, plural_label: `${name}s`, id_prefix: name.slice(0, 3), standard: true, owned: false, field_count: 3, access: { read: true, write: true, archive: true } });

const role = (key: string, name: string, extra: Partial<Role> = {}): Role => ({
  id: `role_${key}`, key, name, description: "", permissions: ["records:read"], is_system: false, objects: {}, fields: {}, created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z", archived_at: null, active_members: 0, ...extra,
});
const CATALOG: PermissionInfo[] = [
  { key: "records:read", description: "Read records", category: "records", requires: [] },
  { key: "schema:manage", description: "Change objects and fields", category: "features", requires: [] },
  { key: "audit:read", description: "Read the audit log", category: "features", requires: [] },
];

describe("Settings → Account", () => {
  it("offers only the teams that are available, and saves the choice as a preference", async () => {
    // A workspace with quotes but no tickets or orders; the member has no audit:read.
    const { calls } = renderRoute("/settings/account", (c: Call) => {
      if (c.method === "PUT" && c.path === "/v1/me/preferences") return { body: { data: c.body } };
      return undefined;
    }, { objects: [obj("contact"), obj("quote")] });
    const select = await screen.findByRole("combobox", { name: "Your team" });
    await waitFor(() => expect(within(select).getByRole("option", { name: "Finance" })).toBeInTheDocument());
    const names = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["No team", "Sales", "Marketing", "Finance"]);
    expect(screen.getByText(/only changes what Home shows first/)).toBeInTheDocument();
    await userEvent.selectOptions(select, "finance");
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/v1/me/preferences")).toBe(true));
    expect(calls.find((c) => c.method === "PUT" && c.path === "/v1/me/preferences")!.body).toEqual({ "home.team": "finance" });
  });

  it("the theme cards save the theme preference", async () => {
    const { calls } = renderRoute("/settings/account", (c: Call) => (c.method === "PUT" && c.path === "/v1/me/preferences" ? { body: { data: c.body } } : undefined));
    const dark = await screen.findByRole("radio", { name: /Dark/ });
    expect(screen.getByRole("radio", { name: /System/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(dark);
    await waitFor(() => expect(dark).toHaveAttribute("aria-checked", "true"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && JSON.stringify(c.body).includes("dark"))).toBe(true));
  });

  it("has no inputs for name or photo, and no per-event notification matrix", async () => {
    renderRoute("/settings/account", () => undefined);
    await screen.findByRole("heading", { name: "Profile" });
    expect(screen.queryByRole("textbox", { name: /name/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/mentions/i)).not.toBeInTheDocument();
  });

  it("notification settings keep the severity levels and nothing per event", async () => {
    renderRoute("/settings/notifications", (c: Call) => (c.path === "/v1/me/notification-preferences"
      ? { body: { data: { email: { critical: "immediate", warning: "digest", info: "off" }, digest_hour: 8, timezone: "UTC", quiet_hours: null } } } : undefined));
    expect(await screen.findByRole("combobox", { name: "Critical" })).toHaveValue("immediate");
    expect(screen.getByRole("combobox", { name: "Info" })).toHaveValue("off");
    expect(screen.queryByText(/mentions|followed/i)).not.toBeInTheDocument();
  });
});

describe("Settings → Members", () => {
  const users = [
    { id: "usr_ME", email: "me@example.com", name: "Mia Example", role: "owner", role_name: "Owner", permission_sets: [], active: true, sign_in: { has_password: true, sso_linked: false, last_sign_in_at: new Date(Date.now() - 3_600_000).toISOString(), active_sessions: 1 } },
    { id: "usr_2", email: "sam@example.com", name: "Sam Second", role: "member", role_name: "Member", permission_sets: ["deal_desk"], active: true, sign_in: { has_password: false, sso_linked: true, last_sign_in_at: null, active_sessions: 0 } },
    { id: "usr_3", email: "lee@example.com", name: "Lee Third", role: "member", role_name: "Member", permission_sets: [], active: false },
  ];
  const handler = (c: Call) => {
    if (c.path === "/v1/members") return { body: { data: { users, service_accounts: [] } } };
    if (c.path === "/v1/roles") return { body: { data: [role("owner", "Owner", { is_system: true }), role("member", "Member", { is_system: true })] } };
    if (c.path === "/v1/permission-sets") return { body: { data: [role("deal_desk", "Deal desk")] } };
    return undefined;
  };

  it("filters by search, role and status, counts the rows, shows 'Last signed in' and never 'Invited'", async () => {
    renderRoute("/settings/members", handler, { session: ADMIN });
    expect(await screen.findByText("3 members")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Members" });
    expect(within(table).getByRole("columnheader", { name: "Last signed in" })).toBeInTheDocument();
    expect(within(table).getAllByText("Never")).toHaveLength(2);
    expect(within(table).getByText("Deal desk")).toBeInTheDocument();
    expect(screen.queryByText(/invited/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Roles & permission sets/ })).toHaveAttribute("href", "/settings/roles");

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Filter by status" }), "disabled");
    expect(await screen.findByText("1 member of 3")).toBeInTheDocument();
    expect(within(table).getByText("Lee Third")).toBeInTheDocument();
    expect(within(table).queryByText("Sam Second")).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Filter by status" }), "");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Filter by role" }), "owner");
    expect(await screen.findByText("1 member of 3")).toBeInTheDocument();
    expect(within(table).getByText("Mia Example", { exact: false })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Filter by role" }), "");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search members" }), "sam@");
    expect(await screen.findByText("1 member of 3")).toBeInTheDocument();
    expect(within(table).getByText("Sam Second")).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("searchbox", { name: "Search members" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search members" }), "nobody");
    expect(await screen.findByText("No members match.")).toBeInTheDocument();
  });
});

describe("Settings → Roles and permission sets", () => {
  const handler = (extra?: (c: Call) => ReturnType<NonNullable<Parameters<typeof renderRoute>[1]>>) => (c: Call) => {
    const r = extra?.(c);
    if (r) return r;
    if (c.method === "GET" && c.path === "/v1/roles") return { body: { data: [role("admin", "Admin", { is_system: true, active_members: 3 }), role("sales_lead", "Sales lead", { active_members: 1 })] } };
    if (c.method === "GET" && c.path === "/v1/permission-sets") return { body: { data: [role("deal_desk", "Deal desk", { active_members: 2 })] } };
    if (c.path === "/v1/permissions") return { body: { data: CATALOG } };
    if (c.method === "GET" && c.path === "/v1/roles/sales_lead") return { body: { data: role("sales_lead", "Sales lead", { permissions: ["records:read", "schema:manage"] }) } };
    if (c.method === "GET" && c.path === "/v1/permission-sets/deal_desk") return { body: { data: role("deal_desk", "Deal desk", { permissions: ["records:read", "audit:read"] }) } };
    if (c.path.endsWith("/access")) return { body: { data: { permissions: [], objects: [] } } };
    return undefined;
  };

  it("shows both lists beside the detail, with a lock on built-in roles and member counts", async () => {
    renderRoute("/settings/roles/sales_lead", handler(), { session: ADMIN });
    expect(await screen.findByRole("heading", { name: "Sales lead" })).toBeInTheDocument();
    const admin = await screen.findByRole("link", { name: /Admin/ });
    expect(within(admin).getByLabelText("Built in")).toBeInTheDocument();
    expect(within(admin).getByText("3 members")).toBeInTheDocument();
    const lead = screen.getByRole("link", { name: /Sales lead/ });
    expect(within(lead).queryByLabelText("Built in")).not.toBeInTheDocument();
    expect(lead).toHaveAttribute("aria-current", "page");
    expect(within(lead).getByText("1 member")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Deal desk/ })).toHaveAttribute("href", "/settings/permission-sets/deal_desk");
    // Record access has Read, Write and Archive only.
    const heads = (await screen.findAllByRole("columnheader")).map((h) => h.textContent);
    expect(heads).toEqual(expect.arrayContaining(["Read", "Write", "Archive"]));
    expect(heads).not.toEqual(expect.arrayContaining(["Create"]));
  });

  it("takes the feature permissions from the API's catalog, grouped by category", async () => {
    renderRoute("/settings/roles/sales_lead", handler((c) => (c.path === "/v1/permissions"
      ? { body: { data: [...CATALOG, { key: "reports:send", description: "Send reports", category: "features", requires: [] }] } } : undefined)), { session: ADMIN });
    await screen.findByRole("heading", { name: "Sales lead" });
    expect(await screen.findByRole("heading", { name: "Features" })).toBeInTheDocument();
    expect(screen.getByTitle("schema:manage")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    const features = within(dialog).getByRole("group", { name: "Features" });
    expect(await within(features).findByText("reports:send")).toBeInTheDocument();
    expect(within(dialog).queryByText("records:export")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("keys:use")).not.toBeInTheDocument();
  });

  it("Duplicate sends copy_from for a permission set and for a role", async () => {
    const { calls } = renderRoute("/settings/permission-sets/deal_desk", handler((c) => {
      if (c.method === "POST" && c.path === "/v1/permission-sets") return { status: 201, body: { data: role("deal_desk_copy", "Deal desk copy") } };
      if (c.path === "/v1/permission-sets/deal_desk_copy") return { body: { data: role("deal_desk_copy", "Deal desk copy") } };
      return undefined;
    }), { session: ADMIN });
    await userEvent.click(await screen.findByRole("button", { name: "Duplicate" }));
    const dialog = await screen.findByRole("dialog", { name: "Duplicate Deal desk" });
    expect(within(dialog).getByRole("textbox", { name: /^Key/ })).toHaveValue("deal_desk_copy");
    await userEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/permission-sets")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ key: "deal_desk_copy", name: "Deal desk copy", copy_from: "deal_desk" });
    expect(await screen.findByRole("heading", { name: "Deal desk copy" })).toBeInTheDocument();
  });

  it("Duplicate on a role posts to /v1/roles with copy_from", async () => {
    const { calls } = renderRoute("/settings/roles/sales_lead", handler((c) => (c.method === "POST" && c.path === "/v1/roles"
      ? { status: 201, body: { data: role("sales_lead_copy", "Sales lead copy") } } : undefined)), { session: ADMIN });
    await userEvent.click(await screen.findByRole("button", { name: "Duplicate" }));
    const dialog = await screen.findByRole("dialog", { name: "Duplicate Sales lead" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/roles")).toBe(true));
    expect((calls.find((c) => c.method === "POST")!.body as { copy_from: string }).copy_from).toBe("sales_lead");
  });
});
