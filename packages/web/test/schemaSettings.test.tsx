import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { field, objectMeta, renderRoute, SESSION, type Call } from "./utils";

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;

const ACCESS = { read: true, write: true, archive: true };
const summary = (o: Record<string, unknown>) => ({ plural_label: "x", id_prefix: "x", standard: true, owned: false, field_count: 0, access: ACCESS, origin: "standard", ...o });
const OBJECTS = [
  summary({ name: "contact", label: "Contact", module: "core", field_count: 3 }),
  summary({ name: "deal", label: "Deal", module: "sales", field_count: 4, id_prefix: "deal" }),
  summary({ name: "ticket", label: "Ticket", standard: false, origin: "pack", pack: "support-desk", field_count: 2 }),
  summary({ name: "property", label: "Property", standard: false, origin: "custom", field_count: 1 }),
  summary({ name: "secret", label: "Secret", module: "core", access: { read: false, write: false, archive: false } }),
];

const LAST = { change: "field_added", changed_at: ago(2 * HOUR), surface: "cli", via: null, pack: null, actor: "usr_AL", version: 7 };
const DEAL = (extra: Record<string, unknown> = {}) => objectMeta({ name: "deal", label: "Deal", id_prefix: "deal", standard: true, fields: [
  field({ name: "name", label: "Name", type: "text", standard: true, required: true, origin: "standard" }),
  field({ name: "margin", label: "Gross margin", type: "percent", sensitivity: "restricted", origin: "custom", ...extra }),
  field({ name: "account", label: "Account", type: "relation", relation: { to: "contact", cardinality: "many_to_one" }, origin: "custom" }),
  field({ name: "priority", label: "Priority", type: "single_select", origin: "pack", pack: "support-desk", values: [{ key: "low", label: "Low" }] }),
] });

const ROWS = [
  { version: 9, changed_at: ago(HOUR), change: "field_updated", object: "deal", field: "margin", surface: "admin-mcp", via: "Claude Desktop", pack: null, actor: "usr_AL", before: { sensitivity: "standard" }, after: { sensitivity: "restricted" } },
  { version: 7, changed_at: ago(2 * HOUR), change: "field_added", object: "deal", field: "margin", surface: "cli", via: null, pack: null, actor: "usr_AL", before: null, after: { api_name: "margin", type: "percent" } },
  { version: 3, changed_at: ago(3 * HOUR), change: "field_added", object: "deal", field: "account", surface: "web", via: null, pack: null, actor: "usr_ME", before: null, after: null },
];

const ADMIN = { ...SESSION, permissions: [...SESSION.permissions, "schema:manage", "audit:read"] };

function server(extra: (c: Call) => ReturnType<NonNullable<Parameters<typeof renderRoute>[1]>> = () => undefined) {
  return (c: Call) => {
    const x = extra(c);
    if (x) return x;
    if (c.path === "/v1/objects" ) return { body: { data: OBJECTS } };
    if (c.path === "/v1/objects/deal" && c.method === "GET") return { body: { data: DEAL(c.query.get("include_hidden") === "true" ? { last_change: LAST } : {}) } };
    if (c.path === "/v1/schema") return { body: { data: { objects: [{ name: "deal", records: 10000, records_capped: true }, { name: "contact", records: 12 }] } } };
    if (c.path === "/v1/schema/changes") return { body: { data: ROWS } };
    if (c.path === "/v1/users") return { body: { data: [{ id: "usr_AL", name: "Alex Kim", email: "a@example.com" }] } };
    if (c.path === "/v1/objects/deal/layout") return { body: { data: { object: "deal", custom: false, version: 0, layout: {}, sections: [], updated_at: null } } };
    return undefined;
  };
}

describe("Settings → Objects & fields", () => {
  it("groups readable objects by module, custom objects and packs, with field counts", async () => {
    renderRoute("/settings/schema", server(), { session: ADMIN, objects: OBJECTS });
    const nav = await screen.findByRole("navigation", { name: "Objects" });
    const heads = within(nav).getAllByRole("heading").map((h) => h.textContent);
    expect(heads).toEqual(["Core", "Sales", "Custom", "support-deskpack"]);
    expect(within(nav).getByRole("link", { name: /Deal\s*4 fields/ })).toHaveAttribute("href", "/settings/schema/deal");
    expect(within(nav).getByRole("link", { name: /Ticket\s*2 fields/ })).toBeInTheDocument();
    expect(within(nav).queryByText("Secret")).not.toBeInTheDocument(); // the caller can't read it
  });

  it("shows the header with origin and a capped record count", async () => {
    renderRoute("/settings/schema/deal", server(), { session: ADMIN, objects: OBJECTS });
    expect(await screen.findByText(/10,000\+ records/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Deal" }).parentElement).toHaveTextContent("Standard");
  });

  it("shows origin and last change to audit:read callers, and 'Built in' / the pack otherwise", async () => {
    renderRoute("/settings/schema/deal", server(), { session: ADMIN, objects: OBJECTS });
    const table = await screen.findByRole("table", { name: "Deal fields" });
    const margin = within(table).getByRole("row", { name: /Gross margin/ });
    expect(await within(margin).findByText(/Alex Kim · CLI/)).toBeInTheDocument();
    expect(within(margin).getByText("Restricted")).toBeInTheDocument();
    expect(within(margin).getByText("Custom")).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: /Name/ })).toHaveTextContent("Built in");
    expect(within(table).getByRole("row", { name: /Priority/ })).toHaveTextContent("support-desk pack");
    expect(within(table).getByRole("row", { name: /Account/ })).toHaveTextContent("Relation → Contact");
  });

  it("leaves last change empty for a custom field without audit:read, and hides the Changes tab and the history calls", async () => {
    const { calls } = renderRoute("/settings/schema/deal", server((c) => (c.path === "/v1/objects/deal" ? { body: { data: DEAL() } } : undefined)), { objects: OBJECTS });
    const table = await screen.findByRole("table", { name: "Deal fields" });
    const margin = within(table).getByRole("row", { name: /Gross margin/ });
    expect(margin.querySelectorAll("td")[6]!.textContent).toBe("");
    expect(within(table).getByRole("row", { name: /Name/ })).toHaveTextContent("Built in");
    expect(screen.queryByRole("tab", { name: "Changes" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Last change by an agent/)).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === "/v1/schema/changes")).toBe(false);
  });

  it("says when the last CLI and agent changes were, from the real history, for audit:read callers only", async () => {
    renderRoute("/settings/schema", server(), { session: ADMIN, objects: OBJECTS });
    expect(await screen.findByText(/Last change from the CLI: 2 hours ago by Alex Kim/)).toBeInTheDocument();
    expect(screen.getByText(/Last change by an agent: 1 hour ago by Alex Kim \(Claude Desktop\)/)).toBeInTheDocument();
    expect(screen.queryByText(/connected now/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "MCP guide" })).toHaveAttribute("href", expect.stringContaining("mcp/README.md"));
  });

  it("offers no Add field without schema:manage", async () => {
    renderRoute("/settings/schema/deal", server(), { session: { ...SESSION, permissions: ["records:read", "audit:read"] }, objects: OBJECTS });
    await screen.findByRole("table", { name: "Deal fields" });
    expect(screen.queryByRole("button", { name: /add field/i })).not.toBeInTheDocument();
  });

  it("previews the dry run before applying: sends dry_run true, then the same body with dry_run false", async () => {
    const { calls } = renderRoute("/settings/schema/deal", server((c) => {
      if (c.path === "/v1/objects/deal/fields" && c.method === "POST") {
        const dry = (c.body as { dry_run?: boolean }).dry_run === true;
        return { status: dry ? 200 : 201, body: { dry_run: dry, schema_version: 5, changes: [{ change: "field_added", object: "deal", field: "renewal_risk", after: { api_name: "renewal_risk", type: "single_select", required: true, options: { values: [{ key: "low", label: "Low" }, { key: "high", label: "High" }] } }, warning: "Existing records have no value for this field." }] } };
      }
      return undefined;
    }), { session: ADMIN, objects: OBJECTS });
    await userEvent.click(await screen.findByRole("button", { name: /add field/i }));
    const form = await screen.findByRole("form", { name: "New field on Deal" });
    await userEvent.type(within(form).getByRole("textbox", { name: "Label" }), "Renewal risk");
    expect(within(form).getByRole("textbox", { name: /API name/ })).toHaveValue("renewal_risk");
    await userEvent.selectOptions(within(form).getByRole("combobox", { name: "Type" }), "single_select");
    await userEvent.type(within(form).getByRole("textbox", { name: /Values/ }), "Low, High");
    await userEvent.click(within(form).getByRole("checkbox", { name: "Required" }));
    await userEvent.click(within(form).getByRole("button", { name: "Preview change" }));

    const review = await screen.findByRole("group", { name: /Review the new field/ });
    expect(within(review).getByText("deal.renewal_risk")).toBeInTheDocument();
    expect(within(review).getByText("Existing records have no value for this field.")).toBeInTheDocument();
    expect(within(review).getByText(/add_field\(object: "deal", name: "renewal_risk", type: "single_select"/)).toBeInTheDocument();
    const posts = () => calls.filter((c) => c.method === "POST" && c.path === "/v1/objects/deal/fields");
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toEqual({
      api_name: "renewal_risk", type: "single_select", label: "Renewal risk", required: true,
      options: { values: [{ key: "low", label: "Low" }, { key: "high", label: "High" }] }, dry_run: true,
    });

    await userEvent.click(within(review).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    const { dry_run: _d, ...first } = posts()[0]!.body as Record<string, unknown>;
    expect(posts()[1]!.body).toEqual(first); // exactly what was previewed
    await waitFor(() => expect(screen.queryByRole("group", { name: /Review the new field/ })).not.toBeInTheDocument());
    expect(calls.filter((c) => c.path === "/v1/objects/deal" && c.method === "GET").length).toBeGreaterThan(1); // describe refreshed
  });

  it("goes back from the preview without writing anything", async () => {
    const { calls } = renderRoute("/settings/schema/deal", server((c) => (c.path === "/v1/objects/deal/fields"
      ? { body: { dry_run: true, schema_version: 5, changes: [{ change: "field_added", object: "deal", field: "note", after: { type: "text" } }] } } : undefined)), { session: ADMIN, objects: OBJECTS });
    await userEvent.click(await screen.findByRole("button", { name: /add field/i }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Label" }), "Note");
    await userEvent.click(screen.getByRole("button", { name: "Preview change" }));
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(await screen.findByRole("textbox", { name: "Label" })).toHaveValue("Note");
    expect(calls.filter((c) => c.method === "POST").every((c) => (c.body as { dry_run?: boolean }).dry_run === true)).toBe(true);
  });

  it("shows the server's 422 message in the form", async () => {
    renderRoute("/settings/schema/deal", server((c) => (c.path === "/v1/objects/deal/fields"
      ? { status: 422, body: { code: "validation_failed", status: 422, detail: 'Field name "id" is reserved' } } : undefined)), { session: ADMIN, objects: OBJECTS });
    await userEvent.click(await screen.findByRole("button", { name: /add field/i }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Label" }), "Id");
    await userEvent.click(screen.getByRole("button", { name: "Preview change" }));
    expect(await screen.findByRole("alert")).toHaveTextContent('Field name "id" is reserved');
    expect(screen.getByRole("form", { name: "New field on Deal" })).toBeInTheDocument();
  });

  it("lists the Changes tab with source labels, who, via and a compact before → after; Load more raises the limit", async () => {
    const { calls } = renderRoute("/settings/schema/deal", server(), { session: ADMIN, objects: OBJECTS });
    await userEvent.click(await screen.findByRole("tab", { name: "Changes" }));
    const mcp = (await screen.findAllByText("MCP"))[0]!.closest("li")!;
    expect(mcp).toHaveTextContent("Alex Kim via Claude Desktop changed the field margin");
    expect(mcp).toHaveTextContent("sensitivity: standard → restricted");
    expect(screen.getAllByText("CLI").length).toBeGreaterThan(0);
    expect(screen.getByText("Web").closest("li")).toHaveTextContent("Mia Example (you)");
    const objectCalls = () => calls.filter((c) => c.path === "/v1/schema/changes" && c.query.get("object") === "deal");
    expect(objectCalls()[0]!.query.get("limit")).toBe("50");
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument(); // fewer rows than the limit
  });

  it("offers Load more when a full page came back", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...ROWS[2]!, version: 100 - i }));
    const { calls } = renderRoute("/settings/schema/deal", server((c) => (c.path === "/v1/schema/changes" && c.query.get("object") === "deal" ? { body: { data: many } } : undefined)), { session: ADMIN, objects: OBJECTS });
    await userEvent.click(await screen.findByRole("tab", { name: "Changes" }));
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/schema/changes" && c.query.get("object") === "deal" && Number(c.query.get("limit")) > 50)).toBe(true));
  });
});
