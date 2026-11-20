import { beforeAll, describe, expect, it } from "vitest";
import { Browser, call, create, newWorkspace, signedIn, uniqueEmail, validate, type Schema, type Workspace } from "./helpers.js";

/**
 * The read-side features (multi-sort, counts, aggregates, saved views, preferences) used from a browser
 * session rather than an API key: permissions come from the member's role, every write needs the CSRF
 * checks, preferences belong to the member whichever credential they use, and counts and aggregates
 * take rate-limit tokens from the member's bucket.
 */

const SECRET = `zq${Date.now().toString(36)}sessionsentinel`;
let n = 0;
const slug = (s: string) => `${s}_${++n}_${Date.now().toString(36)}`;

let ws: Workspace;

/** Adds a member with `role` and returns their ID, email and (when scopes are given) a key. */
async function member(role: string, scopes?: string[]) {
  const email = uniqueEmail(role);
  const m = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email, name: `S ${role}`, role } });
  if (m.status !== 201) throw new Error(`add member failed: ${m.status} ${JSON.stringify(m.json)}`);
  const id = m.json.data.id as string;
  if (!scopes) return { id, email, key: "" };
  const k = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: `${role} key`, scopes, owner: id } });
  if (k.status !== 201) throw new Error(`create key failed: ${k.status} ${JSON.stringify(k.json)}`);
  return { id, email, key: k.json.data.secret as string };
}

beforeAll(async () => {
  ws = await newWorkspace("Session reads");
  expect((await call("POST", "/v1/objects/deal/fields", { key: ws.keys.admin, body: { api_name: "deal_secret", type: "text" } })).status).toBe(201);
  const contact = await create(ws.keys.ops, "contact", { email: uniqueEmail("c") });
  for (const [name, amount, stage] of [["Alpha", 100, "Qualification"], ["Alpha", 50, "Qualification"], ["Bravo", 300, "Proposal"], ["Charlie", 70, "Proposal"]] as const) {
    await create(ws.keys.ops, "deal", { name, amount, stage, primary_contact: contact.id, deal_secret: SECRET });
  }
});

describe("read features from a browser session", () => {
  it("lists with multi-sort and a count, aggregates, saves and runs a view, with CSRF on every write", async () => {
    const m = await member("member");
    const b = await signedIn(m.email);
    expect(b.csrf).toBeTruthy();

    // Multi-column sort and a count on a GET list (no CSRF needed: GET changes nothing).
    const list = await b.request("GET", "/v1/objects/deal/records?sort=name,-amount&count=true&limit=200");
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(list.json.total).toBe(4);
    expect(list.json.data.map((d: { name: string; amount: number }) => `${d.name}:${d.amount}`)).toEqual(["Alpha:100", "Alpha:50", "Bravo:300", "Charlie:70"]);
    expect(list.headers.get("cache-control")).toBe("no-store");

    // POST reads are cookie requests that aren't GET: they need the CSRF token too.
    const q = { object: "deal", sort: [{ field: "amount", dir: "desc" }, { field: "name" }], count: true, limit: 2 };
    const noCsrf = await b.request("POST", "/v1/query", { body: q, csrf: false });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.json.code).toBe("csrf_failed");
    const crossSite = await b.request("POST", "/v1/query", { body: q, headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    const page = await b.request("POST", "/v1/query", { body: q });
    expect(page.status).toBe(200);
    expect(page.json).toMatchObject({ total: 4, total_capped: false });
    expect(page.json.data.map((d: { amount: number }) => d.amount)).toEqual([300, 100]);

    // An aggregate.
    const agg = { object: "deal", group_by: [{ field: "stage" }], measures: [{ op: "sum", field: "amount" }] };
    expect((await b.request("POST", "/v1/aggregate", { body: agg, csrf: false })).status).toBe(403);
    const sums = await b.request("POST", "/v1/aggregate", { body: agg });
    expect(sums.status, JSON.stringify(sums.json)).toBe(200);
    const byStage = Object.fromEntries(sums.json.data.map((g: { group: { stage: { display_name: string } }; values: Record<string, number> }) =>
      [g.group.stage.display_name, Object.values(g.values)[0]]));
    expect(byStage).toEqual({ Qualification: 150, Proposal: 370 });

    // A personal saved view: created, run (list, query and aggregate), changed and deleted from the session.
    const viewBody = { object: "deal", name: "Big ones", where: { field: "amount", op: "gte", value: 70 }, sort: [{ field: "amount", dir: "desc" }] };
    expect((await b.request("POST", "/v1/views", { body: viewBody, csrf: false })).status).toBe(403);
    const made = await b.request("POST", "/v1/views", { body: viewBody });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    expect(made.json.data).toMatchObject({ mine: true, shared: false, owner: m.id, status: "ok" });
    const view = made.json.data.id as string;
    const ran = await b.request("GET", `/v1/objects/deal/records?view=${view}&count=true`);
    expect(ran.json.data.map((d: { amount: number }) => d.amount)).toEqual([300, 100, 70]);
    expect(ran.json.total).toBe(3);
    expect((await b.request("POST", "/v1/query", { body: { view } })).json.data).toHaveLength(3);
    expect((await b.request("POST", "/v1/aggregate", { body: { view, measures: [{ op: "count" }] } })).status).toBe(200);
    expect((await b.request("GET", "/v1/views")).json.data.map((v: { id: string }) => v.id)).toContain(view);
    expect((await b.request("PATCH", `/v1/views/${view}`, { body: { name: "Renamed" }, csrf: false })).status).toBe(403);
    expect((await b.request("PATCH", `/v1/views/${view}`, { body: { name: "Renamed" } })).json.data.name).toBe("Renamed");
    // A member role has no views:manage: sharing it is refused for the session as for a key.
    expect((await b.request("PATCH", `/v1/views/${view}`, { body: { shared: true } })).status).toBe(403);
    expect((await b.request("DELETE", `/v1/views/${view}`, { csrf: false })).status).toBe(403);
    expect((await b.request("DELETE", `/v1/views/${view}`)).status).toBe(200);
  });

  it("keeps preferences per member: a session and a key of the same member share them; a service account has its own", async () => {
    const m = await member("member", ["ops:read"]);
    const b = await signedIn(m.email);
    expect((await b.request("PUT", "/v1/me/preferences", { body: { "deals.columns": ["name"] }, csrf: false })).status).toBe(403);
    expect((await b.request("PUT", "/v1/me/preferences", { body: { "deals.columns": ["name"] }, headers: { Origin: "https://evil.example" } })).status).toBe(403);
    const set = await b.request("PUT", "/v1/me/preferences", { body: { "deals.columns": ["name", "amount"], "ui:theme": "dark" } });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    // The member's key sees what the session wrote, and the other way round.
    expect((await call("GET", "/v1/me/preferences", { key: m.key })).json.data).toEqual({ "deals.columns": ["name", "amount"], "ui:theme": "dark" });
    expect((await call("PUT", "/v1/me/preferences", { key: m.key, body: { "ui:theme": null } })).status).toBe(200);
    expect((await b.request("GET", "/v1/me/preferences")).json.data).toEqual({ "deals.columns": ["name", "amount"] });
    // A second session of the same member: the same preferences.
    expect((await (await signedIn(m.email)).request("GET", "/v1/me/preferences")).json.data).toEqual({ "deals.columns": ["name", "amount"] });

    // Someone else's session, and a service account's key, see none of them.
    const other = await member("member");
    expect((await (await signedIn(other.email)).request("GET", "/v1/me/preferences")).json.data).toEqual({});
    const svc = await call("POST", "/v1/service-accounts", { key: ws.keys.admin, body: { name: slug("bot"), role: "member" } });
    expect(svc.status).toBe(201);
    const svcKey = (await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "bot", scopes: ["ops:read"], owner: svc.json.data.id } })).json.data.secret as string;
    expect((await call("GET", "/v1/me/preferences", { key: svcKey })).json.data).toEqual({});
    expect((await call("PUT", "/v1/me/preferences", { key: svcKey, body: { "ui:theme": "light" } })).status).toBe(200);
    expect((await b.request("GET", "/v1/me/preferences")).json.data).toEqual({ "deals.columns": ["name", "amount"] });
  });

  it("refuses a field-limited member's session an aggregate, sort or view over a hidden field, without the hidden value", async () => {
    const role = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: slug("lim"), name: "Limited", permissions: ["records:read", "records:write"],
      fields: { deal: { deal_secret: "none", amount: "none" } } } });
    expect(role.status, JSON.stringify(role.json)).toBe(201);
    const m = await member(role.json.data.key as string);
    const b = await signedIn(m.email);
    const has = (body: unknown) => JSON.stringify(body ?? null).includes(SECRET);
    for (const body of [
      { object: "deal", group_by: [{ field: "deal_secret" }] },
      { object: "deal", measures: [{ op: "sum", field: "amount" }] },
      { object: "deal", group_by: [{ field: "stage" }], measures: [{ op: "max", field: "amount" }] },
      { object: "deal", where: { field: "deal_secret", op: "eq", value: SECRET }, group_by: [{ field: "stage" }] },
    ]) {
      const r = await b.request("POST", "/v1/aggregate", { body });
      expect(r.status, JSON.stringify(body)).toBe(403);
      expect(has(r.json)).toBe(false);
    }
    // What the role can read still works from the session.
    const ok = await b.request("POST", "/v1/aggregate", { body: { object: "deal", group_by: [{ field: "stage" }] } });
    expect(ok.status).toBe(200);
    expect(has(ok.json)).toBe(false);
    expect((await b.request("GET", "/v1/objects/deal/records?sort=name,-amount")).status).toBe(403);
    const list = await b.request("GET", "/v1/objects/deal/records?sort=name&count=true");
    expect(list.status).toBe(200);
    expect(has(list.json)).toBe(false);
    expect(list.json.data.every((d: Record<string, unknown>) => !("amount" in d) && !("deal_secret" in d))).toBe(true);
    // A shared view over the hidden field, saved by the owner, is refused for this session and its definition withheld.
    const shared = await call("POST", "/v1/views", { key: ws.keys.ops, body: { object: "deal", name: "Secret", shared: true, where: { field: "deal_secret", op: "eq", value: SECRET } } });
    expect(shared.status).toBe(201);
    expect((await b.request("POST", "/v1/aggregate", { body: { view: shared.json.data.id } })).status).toBe(403);
    const seen = await b.request("GET", `/v1/views/${shared.json.data.id}`);
    expect(has(seen.json)).toBe(false);
    // The session can't save a view over the hidden field either.
    expect((await b.request("POST", "/v1/views", { body: { object: "deal", name: "Mine", sort: [{ field: "amount" }] } })).status).toBe(403);
  });

  it("charges counts and aggregates to the signed-in member's rate-limit bucket", async () => {
    const m = await member("member", ["ops:read"]);
    const b = await signedIn(m.email);
    // The costliest aggregate: 2 + 2 group_by + 6 measures = 10 tokens. The member's burst is 200 (20 a second),
    // so it runs out after about 20 of them; at one token each it would take 200.
    const body = { object: "deal", group_by: [{ field: "stage" }, { field: "name" }],
      measures: [{ op: "count" }, { op: "count" }, { op: "count" }, { op: "count" }, { op: "count" }, { op: "count" }] };
    let ok = 0;
    let refused: Awaited<ReturnType<Browser["request"]>> | undefined;
    for (let i = 0; i < 100 && !refused; i++) {
      const r = await b.request("POST", "/v1/aggregate", { body });
      if (r.status === 200) ok++;
      else refused = r;
    }
    expect(refused?.status).toBe(429);
    expect(refused?.json.code).toBe("rate_limited");
    // The refusal usually comes when the request's extra tokens are taken, but if exactly none are left it comes
    // at the first token instead, with the plain message. The count of requests let through is what proves the charge.
    expect(refused?.json.detail).toMatch(/slow down/);
    expect(refused?.headers.get("retry-after")).toBeTruthy();
    expect(ok).toBeGreaterThanOrEqual(15);
    expect(ok).toBeLessThan(40);
    // The bucket is the member's, not the session's: a second session of the same member is limited too.
    const again = await (await signedIn(m.email)).request("POST", "/v1/aggregate", { body });
    expect(again.status).toBe(429);
    // A key has its own bucket: the member's key still works.
    expect((await call("POST", "/v1/aggregate", { key: m.key, body })).status).toBe(200);
  });
});

describe("sign-in routes in the OpenAPI document", () => {
  it("describe the session cookie, and their real responses match the closed shapes they declare", async () => {
    const doc = (await call("GET", "/v1/openapi.json", { key: ws.keys.ops })).json as Schema;
    const schemes = (doc.components as { securitySchemes: Record<string, { in?: string; name?: string }> }).securitySchemes;
    expect(schemes.session).toMatchObject({ type: "apiKey", in: "cookie", name: "__Host-hlcrm_session" });
    const paths = doc.paths as Record<string, Record<string, { security: unknown; responses: Record<string, { content: Record<string, { schema: Schema }> }> }>>;
    expect(paths["/v1/auth/session"]!.get!.security).toEqual([{ session: [] }]);
    expect(paths["/v1/aggregate"]!.post!.security).toEqual([{ bearer: [] }, { session: [] }]);
    // The unauthenticated document says nothing tenant-specific, and leaves the /auth endpoints to docs/sign-in.md.
    const pub = await (await (await import("./helpers.js")).app.request("/openapi.json")).json() as Schema;
    expect(Object.keys(pub.paths as Schema).filter((p) => p.startsWith("/auth"))).toEqual([]);
    expect(JSON.stringify(pub)).not.toContain(ws.name);

    const m = await member("member");
    const b = await signedIn(m.email);
    const other = await member("member");
    await signedIn(other.email);
    const second = await signedIn(m.email);
    const secondId = (await second.request("GET", "/v1/auth/session")).json.session.id as string;
    const listed = (await b.request("GET", "/v1/auth/sessions")).json.data as Record<string, unknown>[];
    const samples: [string, string, () => Promise<{ status: number; json: unknown }>][] = [
      ["GET", "/v1/auth/session", () => b.request("GET", "/v1/auth/session")],
      ["GET", "/v1/auth/sessions", () => b.request("GET", "/v1/auth/sessions")],
      ["GET", "/v1/me", () => b.request("GET", "/v1/me")],
      ["GET", "/v1/workspace", () => b.request("GET", "/v1/workspace")],
      ["DELETE", "/v1/sessions/{id}", () => b.request("DELETE", `/v1/sessions/${secondId}`)],
      ["POST", "/v1/auth/password", () => b.request("POST", "/v1/auth/password", { body: { password: `Correct horse ${Date.now()} staple` } })],
      ["DELETE", "/v1/auth/sso", () => b.request("DELETE", "/v1/auth/sso")],
      ["POST", "/v1/auth/sessions/revoke-others", () => b.request("POST", "/v1/auth/sessions/revoke-others")],
      ["GET", "/v1/members/{id}/sessions", () => call("GET", `/v1/members/${other.id}/sessions`, { key: ws.keys.admin })],
      ["POST", "/v1/members/{id}/sessions/revoke", () => call("POST", `/v1/members/${other.id}/sessions/revoke`, { key: ws.keys.admin })],
      ["DELETE", "/v1/members/{id}/sso", () => call("DELETE", `/v1/members/${other.id}/sso`, { key: ws.keys.admin })],
      ["PATCH", "/v1/workspace/sign-in", () => call("PATCH", "/v1/workspace/sign-in", { key: ws.keys.admin, body: { password: true } })],
      ["DELETE", "/v1/auth/password", () => b.request("DELETE", "/v1/auth/password")],
      ["POST", "/v1/auth/sign-out", () => b.request("POST", "/v1/auth/sign-out")],
    ];
    for (const [method, template, run] of samples) {
      const res = await run();
      expect(res.status, `${method} ${template}: ${JSON.stringify(res.json)}`).toBe(200);
      const declared = paths[template]![method.toLowerCase()]!.responses["200"]!.content["application/json"]!.schema;
      expect(validate(doc, declared, res.json), `${method} ${template}`).toEqual([]);
    }
    // The closed shapes do catch an extra field.
    expect(validate(doc, { $ref: "#/components/schemas/Session" }, { ...listed[0], token: "x" })).toContain("$.token: not allowed");
  });
});
