import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readPack } from "../../cli/src/packfile.js";
import { resetRateLimiter } from "../src/api/app.js";
import { call, memberWithKey, newWorkspace, type Workspace } from "./helpers.js";

/**
 * Where the schema comes from and who changed it through what: an object's and a field's origin (standard,
 * custom or a pack), the source of each schema change (surface, the app or key by name, the pack), and the
 * last change beside each field for those who may read the audit log.
 */

const PACKS = fileURLToPath(new URL("../../../packs/", import.meta.url));
interface Field { name: string; origin: string; pack?: string; last_change?: { change: string; surface: string; via: string | null; pack: string | null; actor: string; changed_at: string; version: number } }
interface Change { version: number; change: string; object: string | null; field: string | null; surface: string; via: string | null; pack: string | null; actor: string }

let ws: Workspace;
let adminKeyName: string;
const describeObject = async (name: string, key = ws.keys.admin) => (await call("GET", `/v1/objects/${name}`, { key })).json.data as { origin: string; pack?: string; fields: Field[]; last_change?: unknown };
const changes = async (query = "") => (await call("GET", `/v1/schema/changes${query}`, { key: ws.keys.admin })).json.data as Change[];

beforeEach(() => resetRateLimiter());
beforeAll(async () => {
  ws = await newWorkspace("Schema source");
  const keys = (await call("GET", "/v1/api-keys", { key: ws.keys.admin })).json.data as { name: string; scopes: string[] }[];
  adminKeyName = keys.find((k) => k.scopes.includes("admin"))!.name;
});

describe("the source of a schema change", () => {
  it("records the surface and the key by name, and shows the last change beside the field to those who read the audit log", async () => {
    const added = await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, headers: { "x-hlcrm-surface": "admin-mcp" }, body: { api_name: "tier", type: "text" } });
    expect(added.status).toBe(201);
    const [newest] = await changes("?limit=1");
    expect(newest).toMatchObject({ change: "field_added", object: "contact", field: "tier", surface: "admin-mcp", via: adminKeyName, pack: null });
    expect(newest!.actor).toMatch(/^usr_/);

    const contact = await describeObject("contact");
    expect(contact.origin).toBe("standard");
    const tier = contact.fields.find((f) => f.name === "tier")!;
    expect(tier).toMatchObject({ origin: "custom", last_change: { change: "field_added", surface: "admin-mcp", via: adminKeyName, pack: null, version: newest!.version } });
    expect(tier.last_change!.actor).toMatch(/^usr_/);
    // A standard field nobody changed has no change to show.
    const email = contact.fields.find((f) => f.name === "email")!;
    expect(email.origin).toBe("standard");
    expect(email.last_change).toBeUndefined();

    // A later change through the CLI replaces it.
    expect((await call("PATCH", "/v1/objects/contact/fields/tier", { key: ws.keys.admin, headers: { "x-hlcrm-surface": "cli" }, body: { label: "Tier level", dry_run: false } })).status).toBeLessThan(300);
    expect((await describeObject("contact")).fields.find((f) => f.name === "tier")!.last_change).toMatchObject({ change: "field_updated", surface: "cli" });
  });

  it("gives the origin to every reader, and the last change only with audit:read", async () => {
    const viaOps = await describeObject("contact", ws.keys.ops);
    const tier = viaOps.fields.find((f) => f.name === "tier")!;
    expect(tier.origin).toBe("custom");
    expect(tier.last_change).toBeUndefined();
    expect(viaOps.last_change).toBeUndefined();
    const reader = await memberWithKey(ws, "read_only", ["ops:read"]);
    expect((await describeObject("contact", reader.key)).fields.every((f) => f.last_change === undefined && typeof f.origin === "string")).toBe(true);
    expect((await call("GET", "/v1/schema/changes", { key: reader.key })).status).toBe(403);
  });

  it("narrows the history to one object, its fields included", async () => {
    expect((await call("POST", "/v1/objects/account/fields", { key: ws.keys.admin, body: { api_name: "region", type: "text" } })).status).toBe(201);
    const onContact = await changes("?object=contact");
    expect(onContact.length).toBeGreaterThanOrEqual(2);
    expect(onContact.every((c) => c.object === "contact")).toBe(true);
    expect((await changes("?object=account")).map((c) => c.field)).toContain("region");
    expect((await call("GET", "/v1/schema/changes?object=nope", { key: ws.keys.admin })).status).toBe(404);
  });

  it("marks what a pack made as the pack's: objects, fields and each change", async () => {
    const pack = readPack(join(PACKS, "support-desk"));
    const plan = await call("POST", "/v1/packs/plan", { key: ws.keys.admin, body: { pack } });
    expect(plan.status, JSON.stringify(plan.json).slice(0, 300)).toBe(200);
    const applied = await call("POST", "/v1/packs/apply", { key: ws.keys.admin, body: { pack, plan_token: plan.json.plan_token } });
    expect(applied.status, JSON.stringify(applied.json).slice(0, 300)).toBe(200);

    const objects = (await call("GET", "/v1/objects", { key: ws.keys.ops })).json.data as { name: string; origin: string; pack?: string }[];
    expect(objects.find((o) => o.name === "ticket")).toMatchObject({ origin: "pack", pack: "support-desk" });
    expect(objects.find((o) => o.name === "contact")).toMatchObject({ origin: "standard" });
    expect(objects.find((o) => o.name === "contact")!.pack).toBeUndefined();

    const ticket = await describeObject("ticket");
    expect(ticket).toMatchObject({ origin: "pack", pack: "support-desk" });
    const packFields = ticket.fields.filter((f) => f.origin === "pack");
    expect(packFields.length).toBeGreaterThan(2);
    expect(packFields.every((f) => f.pack === "support-desk" && f.last_change?.pack === "support-desk")).toBe(true);

    const onTicket = await changes("?object=ticket&limit=200");
    expect(onTicket.length).toBeGreaterThan(0);
    expect(onTicket.every((c) => c.pack === "support-desk" && c.via === adminKeyName)).toBe(true);
    // A field added by hand to a pack's object is the workspace's own.
    expect((await call("POST", "/v1/objects/ticket/fields", { key: ws.keys.admin, body: { api_name: "internal_ref", type: "text" } })).status).toBe(201);
    const mine = (await describeObject("ticket")).fields.find((f) => f.name === "internal_ref")!;
    expect(mine).toMatchObject({ origin: "custom", last_change: { pack: null } });
    expect(mine.pack).toBeUndefined();
  });
});
