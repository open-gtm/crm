import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { describeTest, PRESETS } from "@/features/settings/ConnectionsSettings";
import type { Connection } from "@/lib/api/types";
import { renderRoute, SESSION, type Call } from "./utils";

const ADMIN = { ...SESSION, permissions: [...SESSION.permissions, "connections:manage"] };
const SECRET = "pat-na1-SECRET-VALUE-123456";

const conn = (extra: Partial<Connection> = {}): Connection => ({
  id: "conn_1", key: "hubspot", name: "HubSpot", description: null, type: "static_token", base_url: "https://api.hubapi.com", header_name: "Authorization",
  header_prefix: "Bearer ", token_url: null, client_id: null, scope: null, token_lifetime_minutes: 30, test_path: "/crm/v3/objects/contacts?limit=1", enabled: true,
  status: "active", has_secret: true, secret_set_at: "2026-11-25T10:00:00Z", has_refresh_token: false, refresh_token_set_at: null, token_expires_at: null,
  last_used_at: null, last_error: null, last_error_at: null, ...extra,
});

describe("Settings → Connections", () => {
  it("is shown only with connections:manage", async () => {
    renderRoute("/settings/connections", () => undefined);
    expect(await screen.findByText(/don't have access/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connections" })).not.toBeInTheDocument();
  });

  it("creates one from a preset, sends the secret once and keeps no copy of it, then tests it", async () => {
    let made: Connection | null = null;
    const { calls, qc } = renderRoute("/settings/connections", (c: Call) => {
      if (c.path === "/v1/connections" && c.method === "GET") return { body: { data: made ? [made] : [] } };
      if (c.path === "/v1/connections" && c.method === "POST") {
        made = conn();
        return { status: 201, body: { data: { ...made, used_by: [] } } };
      }
      if (c.path === "/v1/connections/conn_1" && c.method === "GET") return { body: { data: { ...made, used_by: [{ id: "auto_1", name: "Contact to HubSpot" }] } } };
      if (c.path === "/v1/connections/conn_1/test") return { body: { data: { ok: true, token: null, request: { ok: true, status: 200, error: null } } } };
      return undefined;
    }, { session: ADMIN });
    expect(await screen.findByText("No connections yet.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /new connection/i }));
    const dialog = await screen.findByRole("dialog");
    const create = within(dialog).getByRole("button", { name: "Create connection" });
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Set up for" }), "hubspot");
    expect(within(dialog).getByRole("textbox", { name: "Base URL" })).toHaveValue("https://api.hubapi.com");
    expect(within(dialog).getByRole("textbox", { name: "Key" })).toHaveValue("hubspot");
    expect(create).toBeDisabled(); // no token yet
    await userEvent.type(within(dialog).getByLabelText(/^Token/), SECRET);
    await userEvent.click(create);

    // The detail page opens; the secret was sent once and is nowhere in the page or the caches.
    expect(await screen.findByText("Contact to HubSpot")).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST" && c.path === "/v1/connections")!;
    expect(post.body).toMatchObject({ key: "hubspot", type: "static_token", base_url: "https://api.hubapi.com", secret: SECRET, test_path: "/crm/v3/objects/contacts?limit=1" });
    expect(post.body).not.toHaveProperty("token_url");
    expect(document.body.textContent).not.toContain(SECRET);
    const cached = () => JSON.stringify([...qc.getMutationCache().getAll().map((m) => m.state), ...qc.getQueryCache().getAll().map((q) => q.state.data)]);
    await waitFor(() => expect(cached()).not.toContain(SECRET));

    await userEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByRole("status")).toHaveTextContent("The test request was answered with HTTP 200.");
  });

  it("asks for the secrets again when the base URL changes, and not otherwise", async () => {
    const sf = conn({ id: "conn_2", key: "salesforce", name: "Salesforce", type: "oauth_client_credentials", base_url: "https://acme.my.salesforce.com",
      token_url: "https://acme.my.salesforce.com/services/oauth2/token", client_id: "3MVG9", test_path: "/services/data/" });
    const { calls } = renderRoute("/settings/connections/conn_2", (c: Call) => {
      if (c.path === "/v1/connections/conn_2" && c.method === "GET") return { body: { data: { ...sf, used_by: [] } } };
      if (c.path === "/v1/connections/conn_2" && c.method === "PATCH") return { body: { data: { ...sf, used_by: [] } } };
      return undefined;
    }, { session: ADMIN });
    await userEvent.click(await screen.findByRole("button", { name: "Change…" }));
    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(within(dialog).getByRole("textbox", { name: "Key" })).toBeDisabled();
    expect(save).toBeEnabled(); // nothing moved: the stored secret stays
    const base = within(dialog).getByRole("textbox", { name: "Base URL" });
    await userEvent.clear(base);
    await userEvent.type(base, "https://other.my.salesforce.com");
    expect(save).toBeDisabled();
    expect(within(dialog).getByText(/secrets must be entered again/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Client secret/), "new-secret");
    await userEvent.click(save);
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toBeTruthy());
    const patch = calls.find((c) => c.method === "PATCH")!.body as Record<string, unknown>;
    expect(patch).toMatchObject({ base_url: "https://other.my.salesforce.com", secret: "new-secret" });
    expect(patch).not.toHaveProperty("key");
    expect(patch).not.toHaveProperty("type");
  });

  it("won't save a preset whose YOUR-… parts are still there", async () => {
    renderRoute("/settings/connections", (c: Call) => (c.path === "/v1/connections" ? { body: { data: [] } } : undefined), { session: ADMIN });
    await userEvent.click(await screen.findByRole("button", { name: /new connection/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Set up for" }), "salesforce");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Client ID" }), "3MVG9");
    await userEvent.type(within(dialog).getByLabelText(/Client secret/), "s");
    expect(within(dialog).getByRole("button", { name: "Create connection" })).toBeDisabled();
    expect(within(dialog).getAllByText(/Replace the YOUR-… part/).length).toBeGreaterThan(0);
  });

  it("says what a test found, and presets name no secret", () => {
    expect(describeTest({ ok: false, token: { ok: false, error: "connection sf: the token request was answered with HTTP 400 (invalid_client)" }, request: null })).toMatch(/invalid_client/);
    expect(describeTest({ ok: false, token: { ok: true, error: null }, request: { ok: false, status: 403, error: "the server answered HTTP 403" } })).toMatch(/token was issued, but .* HTTP 403/);
    expect(describeTest({ ok: true, token: { ok: true, error: null }, request: null })).toMatch(/Set a test path/);
    for (const p of Object.values(PRESETS)) expect(Object.keys(p)).not.toContain("secret");
  });
});
