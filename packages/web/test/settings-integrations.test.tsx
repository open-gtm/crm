import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ConnectedApp, InstalledPack } from "@/lib/api/types";
import { endpointOf } from "@/features/settings/ConnectedApps";
import { describeTrigger } from "@/features/settings/AutomationsSettings";
import { renderRoute, SESSION, type Call } from "./utils";

const OWNER = { ...SESSION, permissions: [...SESSION.permissions, "members:manage", "automations:manage", "schema:manage"] };
const LIMITED = { ...SESSION, role: "field_limited", permissions: ["records:read", "records:write"] };

const app = (id: string, name: string, extra: Partial<ConnectedApp> = {}): ConnectedApp => ({
  id, member: "usr_ME", client: { id: `https://${name.toLowerCase()}.example/client.json`, name, kind: "metadata_document", verified_by_document: true, redirect_host: `${name.toLowerCase()}.example` },
  scopes: ["ops:read", "ops:write"], resource: "https://mcp.test/mcp/ops", created_at: new Date(Date.now() - 86_400_000).toISOString(), last_used_at: null,
  expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(), ...extra,
});

describe("Account → Connected apps", () => {
  it("lists my apps and disconnects one after confirming, with DELETE /v1/auth/apps/:id", async () => {
    let apps = [app("ogr_1", "Claude"), app("ogr_2", "Cursor", { resource: "https://mcp.test/mcp/admin", scopes: ["admin"], client: { ...app("x", "Cursor").client, kind: "registered", verified_by_document: false } })];
    const { calls } = renderRoute("/settings/account", (c: Call) => {
      if (c.path === "/v1/auth/apps") return { body: { data: apps } };
      if (c.method === "DELETE" && c.path === "/v1/auth/apps/ogr_2") {
        apps = apps.filter((a) => a.id !== "ogr_2");
        return { body: { data: { id: "ogr_2", revoked: true } } };
      }
      if (c.path === "/v1/auth/sessions") return { body: { data: [] } };
      return undefined;
    });
    const section = await screen.findByRole("region", { name: "Connected apps" });
    expect(await within(section).findByText("Claude")).toBeInTheDocument();
    expect(within(section).getByText("Admin MCP server")).toBeInTheDocument();
    expect(within(section).getByText("unverified name")).toBeInTheDocument();
    await userEvent.click(within(section).getByRole("button", { name: "Disconnect Cursor" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Disconnect Cursor?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(within(section).queryByText("Cursor")).not.toBeInTheDocument());
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.path).toBe("/v1/auth/apps/ogr_2");
    expect(del?.headers["x-csrf-token"]).toBe("csrf-1");
  });

  it("says when the server has OAuth off (from the session info: nothing is probed), and shows an empty state", async () => {
    const { calls } = renderRoute("/settings/account", (c) => {
      if (c.path === "/v1/auth/apps") return { body: { data: [] } };
      if (c.path === "/v1/auth/sessions") return { body: { data: [] } };
      return undefined;
    }, { session: { ...SESSION, server: { connected_apps: false } } });
    expect(await screen.findByText(/isn't turned on on this server/)).toBeInTheDocument();
    expect(await screen.findByText("No connected apps")).toBeInTheDocument();
    // No request that could only fail (and log a 404 in the console) to find that out.
    expect(calls.filter((c) => c.path.startsWith("/.well-known/") || c.path.startsWith("/oauth/"))).toEqual([]);
  });

  it("names the endpoint from the resource URL", () => {
    expect(endpointOf("https://mcp.test/mcp/ops")).toBe("Ops MCP server");
    expect(endpointOf("https://mcp.test/mcp/admin")).toBe("Admin MCP server");
    expect(endpointOf("https://other/x")).toBe("https://other/x");
  });
});

describe("Members → a member's connected apps", () => {
  it("lists them with ?member= and disconnects with DELETE /v1/apps/:id", async () => {
    let apps = [app("ogr_9", "ChatGPT", { member: "usr_2" })];
    const { calls } = renderRoute("/settings/members", (c) => {
      if (c.path === "/v1/members") return { body: { data: { users: [
        { id: "usr_ME", email: "me@example.com", name: "Mia Example", role: "owner", role_name: "Owner", active: true },
        { id: "usr_2", email: "sam@example.com", name: "Sam Second", role: "member", role_name: "Member", active: true },
      ], service_accounts: [] } } };
      if (c.path === "/v1/roles") return { body: { data: [] } };
      if (c.path === "/v1/apps") return { body: { data: c.query.get("member") === "usr_2" ? apps : [] } };
      if (c.method === "DELETE" && c.path === "/v1/apps/ogr_9") {
        apps = [];
        return { body: { data: { id: "ogr_9", revoked: true } } };
      }
      return undefined;
    }, { session: OWNER });
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Sam Second" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /connected apps/i }));
    const dialog = await screen.findByRole("dialog", { name: "Sam Second's connected apps" });
    expect(await within(dialog).findByText("ChatGPT")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect ChatGPT" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/v1/apps/ogr_9")).toBe(true));
    expect(await within(dialog).findByText("No connected apps")).toBeInTheDocument();
  });
});

describe("Workspace sign-in: connecting apps", () => {
  it("sends oauth_apps and oauth_scopes, and confirms before turning apps off", async () => {
    const { calls } = renderRoute("/settings/workspace", (c) => (c.method === "PATCH" && c.path === "/v1/workspace/sign-in" ? { body: { data: { ...SESSION.workspace.sign_in, ...(c.body as object) } } } : undefined), { session: { ...OWNER } });
    await userEvent.click(await screen.findByRole("checkbox", { name: /change the setup/i }));
    await userEvent.click(screen.getByRole("switch", { name: "Connecting apps" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await userEvent.click(within(confirm).getByRole("button", { name: "Turn off and disconnect" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toMatchObject({ oauth_apps: false, oauth_scopes: ["ops:read", "ops:write", "restricted:read"] });
  });
});

describe("Settings → Automations and Installed packs", () => {
  it("an empty automations list explains what one is and links the guide", async () => {
    renderRoute("/settings/automations", (c) => {
      if (c.path === "/v1/automations") return { body: { data: [] } };
      if (c.path === "/v1/automation-settings") return { body: { data: { paused: false, paused_at: null, paused_reason: null, external_email: false, timezone: "UTC" } } };
      return undefined;
    }, { session: OWNER });
    expect(await screen.findByText("No automations yet")).toBeInTheDocument();
    expect(screen.getByText(/does something for you when a record changes/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "automations guide" }).length).toBe(2);
    expect(document.body).not.toHaveTextContent(/See docs\//);
  });

  it("without automations:manage the section isn't listed and says why by URL, with no request", async () => {
    const { calls } = renderRoute("/settings/automations", () => undefined, { session: LIMITED });
    expect(await screen.findByText("You don't have access to automations")).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith("/v1/automations"))).toBe(false);
    expect(screen.queryByRole("link", { name: /installed packs/i })).not.toBeInTheDocument();
  });

  it("lists installed packs with what they add", async () => {
    const packs: InstalledPack[] = [{ name: "recruiting", version: "1.0.0", status: "installed", description: "Hire people", owns: { objects: ["candidate", "job"], fields: [], pipelines: ["hiring"], roles: ["recruiter"], views: [] },
      installed_at: new Date().toISOString(), installed_by: "usr_ME", updated_at: new Date().toISOString() }];
    renderRoute("/settings/packs", (c) => (c.path === "/v1/packs" ? { body: { data: packs } } : undefined), { session: OWNER });
    const table = await screen.findByRole("table", { name: "Installed packs" });
    expect(within(table).getByText("recruiting")).toBeInTheDocument();
    expect(within(table).getByText("2 objects, 1 pipeline, 1 role")).toBeInTheDocument();
    expect(screen.getByText(/crm pack/)).toBeInTheDocument();
  });

  it("describes triggers in words, including one from a newer server", () => {
    expect(describeTrigger({ type: "event", event: "deal.stage_changed" })).toBe("When a deal changes stage (deal.stage_changed)");
    expect(describeTrigger({ type: "event", event: "account.updated" })).toBe("When an account is changed (account.updated)");
    expect(describeTrigger({ type: "event", event: "custom.thing_happened" })).toBe("When custom.thing_happened");
    expect(describeTrigger({ type: "manual", object: "deal" })).toBe("Run by hand on deal records");
    expect(describeTrigger({ type: "webhook_in" })).toBe("webhook_in");
  });
});
