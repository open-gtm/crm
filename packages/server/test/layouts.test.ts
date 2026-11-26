import { beforeAll, describe, expect, it } from "vitest";
import { call, memberWithKey, newWorkspace, type Workspace } from "./helpers.js";

/** Record page layouts: sections of fields per object, set by someone who manages the schema. */

let ws: Workspace;
const put = (object: string, sections: unknown, key = ws.keys.admin) => call("PUT", `/v1/objects/${object}/layout`, { key, body: { sections } });
const get = async (object: string, key = ws.keys.ops) => (await call("GET", `/v1/objects/${object}/layout`, { key }));

beforeAll(async () => {
  ws = await newWorkspace("Layouts");
  const f = await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "shoe_size", type: "number" } });
  if (f.status !== 201) throw new Error(JSON.stringify(f.json));
});

describe("record page layouts", () => {
  it("an object has the default page until a layout is set, then its sections in order", async () => {
    expect((await get("contact")).json.data).toMatchObject({ object: "contact", custom: false, version: 0, sections: [], updated_at: null });
    const set = await put("contact", [
      { title: "Who", fields: ["first_name", "last_name", "job_title"] },
      { title: "Reach them", fields: ["email", "phone"] },
      { title: "Empty for now", fields: [] },
    ]);
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json.data).toMatchObject({ object: "contact", custom: true, sections: [
      { title: "Who", fields: ["first_name", "last_name", "job_title"] }, { title: "Reach them", fields: ["email", "phone"] }, { title: "Empty for now", fields: [] }] });
    expect(set.json.data.updated_at).toBeTruthy();
    // Everyone who can read the object reads the same layout.
    const reader = await memberWithKey(ws, "read_only", ["ops:read"]);
    expect((await get("contact", reader.key)).json.data.sections).toHaveLength(3);
    // Another object is untouched.
    expect((await get("deal")).json.data.custom).toBe(false);
    // Replacing is whole: the new layout is all there is.
    const again = await put("contact", [{ title: "Everything", fields: ["email", "shoe_size"] }]);
    expect(again.json.data.sections).toEqual([{ title: "Everything", fields: ["email", "shoe_size"] }]);
    const audit = (await call("GET", "/v1/audit-log?action=page_layout.", { key: ws.keys.admin })).json.data as { action: string }[];
    expect(audit.filter((e) => e.action === "page_layout.updated").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps a field's place when it is renamed, and drops it when it is archived", async () => {
    await put("contact", [{ title: "Sizes", fields: ["shoe_size", "email"] }]);
    const renamed = await call("PATCH", "/v1/objects/contact/fields/shoe_size", { key: ws.keys.admin, body: { api_name: "boot_size", dry_run: false } });
    expect(renamed.status, JSON.stringify(renamed.json)).toBeLessThan(300);
    expect((await get("contact")).json.data.sections).toEqual([{ title: "Sizes", fields: ["boot_size", "email"] }]);
    const dry = await call("POST", "/v1/objects/contact/fields/boot_size/archive", { key: ws.keys.admin, body: { dry_run: true } });
    const token = dry.json.confirm_token;
    const archived = await call("POST", "/v1/objects/contact/fields/boot_size/archive", { key: ws.keys.admin, body: { dry_run: false, confirm_token: token } });
    expect(archived.status, JSON.stringify(archived.json)).toBeLessThan(300);
    expect((await get("contact")).json.data.sections).toEqual([{ title: "Sizes", fields: ["email"] }]);
  });

  it("refuses layouts that don't make sense, and anyone who doesn't manage the schema", async () => {
    const bad: [string, unknown][] = [
      ["no sections", []],
      ["unknown field", [{ title: "A", fields: ["no_such_field"] }]],
      ["a field twice", [{ title: "A", fields: ["email"] }, { title: "B", fields: ["email"] }]],
      ["two sections with one title", [{ title: "A", fields: [] }, { title: "a", fields: [] }]],
      ["an empty title", [{ title: "  ", fields: [] }]],
      ["a title with a line break", [{ title: "A\nB", fields: [] }]],
      ["a long title", [{ title: "x".repeat(81), fields: [] }]],
      ["an unknown key", [{ title: "A", fields: [], hidden: true }]],
      ["too many sections", Array.from({ length: 21 }, (_, i) => ({ title: `S${i}`, fields: [] }))],
    ];
    for (const [what, sections] of bad) expect((await put("deal", sections)).status, what).toBe(422);
    expect((await get("deal")).json.data.custom).toBe(false);
    expect((await put("deal", [{ title: "A", fields: ["name"] }], ws.keys.ops)).status).toBe(403);
    expect((await call("DELETE", "/v1/objects/deal/layout", { key: ws.keys.ops })).status).toBe(403);
    expect((await put("no_such_object", [{ title: "A", fields: [] }])).status).toBe(404);
    // Someone who can't read the object doesn't read its layout.
    const role = (await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: `lay_${Date.now().toString(36)}`, name: "No deals", permissions: ["records:read"],
      objects: { deal: { read: false } } } })).json.data;
    const blind = await memberWithKey(ws, role.key, ["ops:read"]);
    expect((await get("deal", blind.key)).status).toBe(403);
  });

  it("reset brings the default page back", async () => {
    await put("account", [{ title: "A", fields: ["name"] }]);
    const reset = await call("DELETE", "/v1/objects/account/layout", { key: ws.keys.admin });
    expect(reset.json.data).toMatchObject({ object: "account", custom: false, sections: [], updated_at: null });
    expect((await call("DELETE", "/v1/objects/account/layout", { key: ws.keys.admin })).status).toBe(200);
  });
});
