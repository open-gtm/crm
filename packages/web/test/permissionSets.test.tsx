import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { PermissionInfo, Role } from "@/lib/api/types";
import { renderRoute, SESSION, type Call } from "./utils";

const ADMIN = { ...SESSION, permission_sets: ["held_set"], permissions: [...SESSION.permissions, "members:manage", "roles:manage"] };

const CATALOG: PermissionInfo[] = [
  { key: "records:read", description: "Read records", category: "records", requires: [] },
  { key: "records:write", description: "Create and update records", category: "records", requires: [] },
  { key: "webhooks:manage", description: "Manage webhook endpoints", category: "features", requires: ["records:read"] },
  { key: "schema:manage", description: "Change objects and fields", category: "features", requires: [] },
];

const set = (key: string, name: string, extra: Partial<Role> = {}): Role => ({
  id: `pset_${key}`, key, name, description: "", permissions: [], objects: {}, fields: {}, created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(), archived_at: null, active_members: 0, ...extra,
});

describe("Settings → Permission sets", () => {
  it("lists the sets, and creates one in two areas: objects and fields, and features", async () => {
    const sets = [set("deal_desk", "Deal desk", { description: "Works deals", active_members: 2 })];
    const { calls } = renderRoute("/settings/permission-sets", (c: Call) => {
      if (c.method === "GET" && c.path === "/v1/permission-sets") return { body: { data: sets } };
      if (c.path === "/v1/permissions") return { body: { data: CATALOG } };
      if (c.method === "POST" && c.path === "/v1/permission-sets") return { status: 201, body: { data: set("hooks", "Hooks") } };
      if (c.path === "/v1/permission-sets/hooks") return { body: { data: set("hooks", "Hooks", { permissions: ["records:read", "webhooks:manage"] }) } };
      if (c.path === "/v1/permission-sets/hooks/access") return { body: { data: { permission_set: "hooks", permissions: [], objects: [] } } };
      return undefined;
    }, { session: ADMIN });
    expect(await screen.findByRole("link", { name: /Deal desk/ })).toHaveAttribute("href", "/settings/permission-sets/deal_desk");
    expect(screen.getByText("2 members")).toBeInTheDocument();
    // A set has no "System" or "Custom" badge: there are no system sets.
    expect(screen.queryByText("Custom")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "New permission set" }));
    const dialog = await screen.findByRole("dialog", { name: "New permission set" });
    const records = within(dialog).getByRole("group", { name: "Objects and fields" });
    const features = within(dialog).getByRole("group", { name: "Features" });
    expect(await within(records).findByText("records:read")).toBeInTheDocument();
    expect(within(records).queryByText("webhooks:manage")).not.toBeInTheDocument();
    expect(within(features).getByText("schema:manage")).toBeInTheDocument();
    // A new set starts with nothing (a new role starts with records:read).
    for (const box of within(dialog).getAllByRole("checkbox")) expect(box).not.toBeChecked();

    await userEvent.type(within(dialog).getByRole("textbox", { name: /key/i }), "hooks");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^name/i }), "Hooks");
    // Choosing a feature adds the record permission it requires.
    await userEvent.click(within(features).getByRole("checkbox", { name: /webhooks:manage/ }));
    expect(within(records).getByRole("checkbox", { name: /records:read/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save permission set" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/permission-sets")).toBe(true));
    const sent = calls.find((c) => c.method === "POST" && c.path === "/v1/permission-sets")!.body as { key: string; permissions: string[] };
    expect(sent.key).toBe("hooks");
    expect([...sent.permissions].sort()).toEqual(["records:read", "webhooks:manage"]);
    // Then its page, with the two areas shown apart.
    expect(await screen.findByRole("heading", { name: "Hooks" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Features" })).toBeInTheDocument();
  });

  it("a set you hold can't be edited or archived", async () => {
    renderRoute("/settings/permission-sets/held_set", (c: Call) => {
      if (c.path === "/v1/permission-sets/held_set") return { body: { data: set("held_set", "Held", { permissions: ["records:read"] }) } };
      if (c.path === "/v1/permission-sets/held_set/access") return { body: { data: { permission_set: "held_set", permissions: [], objects: [] } } };
      if (c.path === "/v1/permissions") return { body: { data: CATALOG } };
      return undefined;
    }, { session: ADMIN });
    expect(await screen.findByText(/You hold this permission set, so you can't change it/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /archive/i })).not.toBeInTheDocument();
  });
});

describe("Members → permission sets", () => {
  it("shows each member's sets and replaces them with PATCH /v1/members/:id", async () => {
    let held = ["deal_desk"];
    const { calls } = renderRoute("/settings/members", (c: Call) => {
      if (c.method === "GET" && c.path === "/v1/members") return { body: { data: { users: [
        { id: "usr_ME", email: "me@example.com", name: "Mia Example", role: "owner", role_name: "Owner", permission_sets: [], active: true },
        { id: "usr_2", email: "sam@example.com", name: "Sam Second", role: "member", role_name: "Member", permission_sets: held, active: true },
      ], service_accounts: [{ id: "svc_1", name: "Sync bot", role: "member", role_name: "Member", permission_sets: [], active: true }] } } };
      if (c.path === "/v1/roles") return { body: { data: [] } };
      if (c.path === "/v1/permission-sets") return { body: { data: [set("deal_desk", "Deal desk"), set("hooks", "Hooks", { description: "Webhooks" })] } };
      if (c.method === "PATCH" && c.path === "/v1/members/usr_2") {
        held = (c.body as { permission_sets: string[] }).permission_sets;
        return { body: { data: {} } };
      }
      return undefined;
    }, { session: ADMIN });
    // Nobody changes their own sets: yours are shown as text, not as a button.
    const open = await screen.findByRole("button", { name: "Permission sets of Sam Second: Deal desk" });
    expect(screen.queryByRole("button", { name: /Permission sets of Mia Example/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Permission sets of Sync bot: None" })).toBeInTheDocument();
    await userEvent.click(open);
    const dialog = await screen.findByRole("dialog", { name: "Permission sets of Sam Second" });
    expect(within(dialog).getByRole("checkbox", { name: /Deal desk/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Hooks/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.path === "/v1/members/usr_2")).toBe(true));
    expect([...(calls.find((c) => c.method === "PATCH")!.body as { permission_sets: string[] }).permission_sets].sort()).toEqual(["deal_desk", "hooks"]);
    expect(await screen.findByRole("button", { name: "Permission sets of Sam Second: Deal desk, Hooks" })).toBeInTheDocument();
  });
});
