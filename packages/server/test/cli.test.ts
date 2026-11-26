import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The CLI only talks HTTP; here its fetch calls the API app in-process, as the MCP tests do.
import { run } from "../../cli/src/program.js";
import type { Runtime } from "../../cli/src/runtime.js";
import { formatDoc, parseDoc } from "../../cli/src/schemafile.js";
import { anchorTenant, sealTenant } from "../src/core/auditchain.js";
import { app, call, create, memberWithKey, newWorkspace, signedIn, uniqueEmail, type Workspace } from "./helpers.js";

/**
 * End-to-end tests of the `crm` CLI (packages/cli) against the real API app and database. They
 * live here rather than in packages/cli because they need the server's test database setup.
 */

const apiFetch: typeof fetch = async (input, init) => app.request(input instanceof Request ? input : String(input), init);

let ws: Workspace;
let home: string;
beforeAll(async () => {
  ws = await newWorkspace("CLI");
  home = mkdtempSync(join(tmpdir(), "crm-cli-"));
});

/** Runs `crm …` with captured output, the shared temporary config dir and no terminal. */
async function crm(args: string[], over: Partial<Runtime> & { stdin?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const rt: Runtime = {
    stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), readStdin: async () => over.stdin ?? "",
    promptSecret: async () => "", confirm: async () => false, env: { HLCRM_CONFIG_DIR: join(home, "config") },
    interactive: false, stdoutIsTTY: false, cwd: home, fetch: apiFetch, ...over,
  };
  const code = await run(args, rt);
  return { code, out: out.join(""), err: err.join("") };
}

const configFile = () => join(home, "config", "config.json");
const file = (name: string) => join(home, name);

describe("crm auth, remote, doctor and api", () => {
  it("logs in with the key on stdin, stores it owner-only and never prints it", async () => {
    const r = await crm(["auth", "login", "--url", "http://localhost", "--with-token", "--name", "test"], { stdin: `${ws.keys.admin}\n` });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Saved as remote "test"');
    expect(r.out + r.err).not.toContain(ws.keys.admin);
    expect(statSync(configFile()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toMatchObject({ current: "test", remotes: { test: { url: "http://localhost", key: ws.keys.admin } } });
  });

  it("refuses a wrong key without saving it", async () => {
    const bad = `hlcrm_live_${"A".repeat(52)}`;
    const r = await crm(["auth", "login", "--url", "http://localhost", "--with-token", "--name", "bad"], { stdin: bad });
    expect(r.code).toBe(3);
    expect(r.err).toContain("A valid API key is required");
    expect(r.err).toMatch(/Request ID: \S+/);
    expect(readFileSync(configFile(), "utf8")).not.toContain(bad);
  });

  it("reports status and passes doctor", async () => {
    const s = await crm(["auth", "status", "--json"]);
    expect(s.code).toBe(0);
    expect(JSON.parse(s.out)).toMatchObject({ remote: "test", actor: { role: "owner" }, key: expect.stringMatching(/^hlcrm_live_.{4}…$/) });
    const d = await crm(["doctor", "--json"]);
    expect(d.code).toBe(0);
    const report = JSON.parse(d.out);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c: { check: string }) => c.check)).toEqual(expect.arrayContaining(["config file", "remote", "connectivity", "authentication", "version", "permissions"]));
    expect(report.server_version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("lets environment variables override the saved remote", async () => {
    const r = await crm(["auth", "status", "--json"], { env: { HLCRM_CONFIG_DIR: join(home, "config"), HLCRM_API_URL: "http://localhost", HLCRM_API_KEY: ws.keys.ops } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ remote: null, source: { url: "env", key: "env" }, scopes: expect.arrayContaining(["ops:read"]) });
  });

  it("sends raw requests with crm api", async () => {
    const r = await crm(["api", "GET", "/v1/objects/contact/records?limit=1"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toHaveProperty("data");
    const bad = await crm(["api", "GET", "/v1/../v1/me"]);
    expect(bad.code).toBe(2);
    const missing = await crm(["api", "GET", "/v1/objects/nope"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("not found");
  });

  it("lists, switches and removes remotes", async () => {
    expect((await crm(["auth", "login", "--url", "http://localhost", "--with-token", "--name", "second"], { stdin: ws.keys.ops })).code).toBe(0);
    const list = await crm(["remote", "list", "--json"]);
    expect(JSON.parse(list.out)).toMatchObject({ current: "second" });
    expect(list.out).not.toContain(ws.keys.ops);
    expect((await crm(["remote", "use", "test"])).code).toBe(0);
    expect((await crm(["remote", "remove", "second"])).code).toBe(0);
    expect(readFileSync(configFile(), "utf8")).not.toContain(ws.keys.ops);
    expect((await crm(["remote", "use", "second"])).code).toBe(2);
  });
});

describe("crm schema", () => {
  it("pull → edit → plan → apply, with documented exit codes", async () => {
    const path = file("crm.schema.yaml");
    const pulled = await crm(["schema", "pull", "-o", path]);
    expect(pulled.code).toBe(0);
    const text = readFileSync(path, "utf8");
    expect(text).toMatch(/^# hl-crm-db schema document/);
    const doc = parseDoc(text, path) as { schema_version: number; objects: { name: string; fields: { name: string; type: string; label?: string }[] }[] };
    expect(doc.schema_version).toBeGreaterThanOrEqual(0);

    expect((await crm(["schema", "plan", "-f", path])).code).toBe(0);
    doc.objects.find((o) => o.name === "contact")!.fields.push({ name: "cli_tier", type: "text", label: "CLI tier" });
    writeFileSync(path, formatDoc(doc, path));
    const plan = await crm(["schema", "plan", "-f", path]);
    expect(plan.code).toBe(5);
    expect(plan.out).toContain("+ add field contact.cli_tier (text)");

    const noYes = await crm(["schema", "apply", "-f", path, "--no-input"]);
    expect(noYes.code).toBe(6);
    expect(noYes.err).toContain("--yes");
    const declined = await crm(["schema", "apply", "-f", path], { interactive: true, confirm: async () => false });
    expect(declined.code).toBe(6);
    const applied = await crm(["schema", "apply", "-f", path], { interactive: true, confirm: async () => true });
    expect(applied.code).toBe(0);
    expect(applied.out).toContain("Applied 1 change(s)");
    expect((await crm(["schema", "plan", "-f", path])).code).toBe(0);
    // Applying again is a no-op.
    expect((await crm(["schema", "apply", "-f", path, "--yes"])).code).toBe(0);
  });

  it("detects drift: exit 4 until --accept-drift", async () => {
    const path = file("drift.schema.json");
    expect((await crm(["schema", "pull", "-o", path])).code).toBe(0);
    const doc = JSON.parse(readFileSync(path, "utf8")) as { objects: { name: string; fields: { name: string; label?: string }[] }[] };
    // Someone relabels the field through the API after the pull; the file still has the old label and a new description.
    expect((await call("PATCH", "/v1/objects/contact/fields/cli_tier", { key: ws.keys.admin, body: { label: "Tier (API)" } })).status).toBe(200);
    Object.assign(doc.objects.find((o) => o.name === "contact")!.fields.find((f) => f.name === "cli_tier")!, { description: "Set by the CLI test" });
    writeFileSync(path, JSON.stringify(doc));
    const plan = await crm(["schema", "plan", "-f", path]);
    expect(plan.code).toBe(4);
    expect(plan.out).toContain("this plan would overwrite it");
    const refused = await crm(["schema", "apply", "-f", path, "--yes"]);
    expect(refused.code).toBe(4);
    expect(refused.err).toContain("--accept-drift");
    const forced = await crm(["schema", "apply", "-f", path, "--yes", "--accept-drift", "--json"]);
    expect(forced.code).toBe(0);
    expect(JSON.parse(forced.out)).toMatchObject({ applied: true });
  });

  it("plan exits 4 when what drifted can't be listed (a file from another workspace), and apply refuses it", async () => {
    const path = file("foreign.schema.json");
    expect((await crm(["schema", "pull", "-o", path])).code).toBe(0);
    const doc = JSON.parse(readFileSync(path, "utf8")) as { schema_version: number; objects: { name: string; description?: string }[] };
    doc.schema_version += 1000;
    doc.objects.find((o) => o.name === "contact")!.description = "From elsewhere";
    writeFileSync(path, JSON.stringify(doc));
    const plan = await crm(["schema", "plan", "-f", path]);
    expect(plan.code).toBe(4);
    expect(plan.out).toContain("can't be told");
    const refused = await crm(["schema", "apply", "-f", path, "--yes"]);
    expect(refused.code).toBe(4);
  });

  it("describes objects and fields", async () => {
    const all = await crm(["schema", "describe"]);
    expect(all.code).toBe(0);
    expect(all.out).toContain("contact");
    const one = await crm(["schema", "describe", "contact", "--json"]);
    expect(JSON.parse(one.out).fields.map((f: { name: string }) => f.name)).toContain("cli_tier");
  });
});

describe("crm data", () => {
  it("exports every matching record to an owner-only CSV, across several responses", async () => {
    const tag = `cli${Date.now()}`;
    for (let i = 0; i < 3; i++) await create(ws.keys.ops, "contact", { first_name: `=P${i}`, last_name: tag, email: uniqueEmail("exp") });
    const out = file("contacts.csv");
    const r = await crm(["data", "export", "contact", "-o", out, "--filter", `last_name=${tag}`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Wrote 3 contact record(s)");
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const lines = readFileSync(out, "utf8").trim().split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines.filter((l) => l.startsWith("id,"))).toHaveLength(1);
    expect(lines[1]).toContain("'=P");
  });

  it("imports: dry run by default, then --apply; errors go to a report file", async () => {
    const tag = `imp${Date.now()}`;
    const csv = file("people.csv");
    writeFileSync(csv, `Email,First name,Surname\n${uniqueEmail("i1")},Ann,${tag}\n${uniqueEmail("i2")},Bo,${tag}\n`);
    const maps = ["--map", "Email=email", "--map", "First name=first_name", "--map", "Surname=last_name", "--key", "email"];
    const dry = await crm(["data", "import", "contact", csv, ...maps]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("Dry run: 2 to create");
    const listed = async () => (await call("GET", `/v1/objects/contact/records?filter[last_name]=${tag}`, { key: ws.keys.ops })).json.data.length;
    expect(await listed()).toBe(0);
    const applied = await crm(["data", "import", "contact", csv, ...maps, "--apply"]);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain("Imported: 2 created");
    expect(await listed()).toBe(2);

    const bad = file("bad.csv");
    writeFileSync(bad, `email,first_name\nnot-an-email,X\n${uniqueEmail("ok")},Y\n`);
    const failed = await crm(["data", "import", "contact", bad, "--key", "email", "--apply", "--json"]);
    expect(failed.code).toBe(1);
    const res = JSON.parse(failed.out);
    expect(res).toMatchObject({ applied: false, counts: { error: 1 }, report: `${bad}.errors.csv` });
    expect(readFileSync(`${bad}.errors.csv`, "utf8")).toMatch(/^row,line,action,id,reason,details\r\n1,2,error,,.*email/);
  });

  it("replaces its own earlier error report without asking, but never a file it didn't write, nor through a symlink", async () => {
    const bad = file("again.csv");
    const report = `${bad}.errors.csv`;
    writeFileSync(bad, "email,first_name\nnot-an-email,X\n");
    // A dry run writes the report; the same command with --apply after it replaces it, no --yes needed.
    const dry = await crm(["data", "import", "contact", bad, "--key", "email"]);
    expect(dry.code).toBe(1);
    expect(readFileSync(report, "utf8")).not.toContain("\r\n2,3,error");
    writeFileSync(bad, "email,first_name\nnot-an-email,X\nstill-not-an-email,Y\n");
    const applied = await crm(["data", "import", "contact", bad, "--key", "email", "--apply"]);
    expect(applied.code).toBe(1);
    expect(applied.out + applied.err).not.toMatch(/not written|already exists/);
    expect(readFileSync(report, "utf8")).toContain("\r\n2,3,error");

    // A file of the person's own at that name is kept unless they confirm.
    writeFileSync(report, "my,own,notes\n");
    const kept = await crm(["data", "import", "contact", bad, "--key", "email"]);
    expect(kept.code).toBe(1);
    expect(kept.out + kept.err).toContain("The error report was not written");
    expect(readFileSync(report, "utf8")).toBe("my,own,notes\n");

    // A symlink there (even to an earlier report) is refused before anything is sent.
    const real = file("real-report.csv");
    writeFileSync(real, "row,line,action,id,reason,details\r\n");
    const linked = file("linked.csv.errors.csv");
    symlinkSync(real, linked);
    writeFileSync(file("linked.csv"), "email,first_name\nnot-an-email,X\n");
    const refused = await crm(["data", "import", "contact", file("linked.csv"), "--key", "email"]);
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/symbolic link/);
    expect(readFileSync(real, "utf8")).toBe("row,line,action,id,reason,details\r\n");
  });

  it("chunks a large file into several requests, dry-running all of them before writing any", async () => {
    expect((await call("POST", "/v1/objects", { key: ws.keys.admin, body: { api_name: "cli_item", fields: [{ api_name: "label", type: "text" }] } })).status).toBe(201);
    const csv = file("items.csv");
    const n = 520;
    writeFileSync(csv, `label\n${Array.from({ length: n }, (_, i) => `item ${i}`).join("\n")}\n${"=bad,row"}\n`);
    // The last row has an extra column, so the server rejects it: nothing at all may be written.
    const failed = await crm(["data", "import", "cli_item", csv, "--apply", "--json"]);
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.out)).toMatchObject({ applied: false, chunks: 2, applied_chunks: 0 });
    const count = async () => (await call("GET", "/v1/schema", { key: ws.keys.ops })).json.data.objects.find((o: { name: string }) => o.name === "cli_item").records;
    expect(await count()).toBe(0);
    writeFileSync(csv, `label\n${Array.from({ length: n }, (_, i) => `item ${i}`).join("\n")}\n`);
    const ok = await crm(["data", "import", "cli_item", csv, "--apply", "--json"]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ applied: true, chunks: 2, counts: { create: n, error: 0 } });
    expect(await count()).toBe(n);
  }, 120_000);

  it("lists and gets records", async () => {
    const c = await create(ws.keys.ops, "contact", { first_name: "Listed", email: uniqueEmail("l") });
    const list = await crm(["data", "list", "contact", "--filter", `email=${c.email as string}`, "--json"]);
    expect(JSON.parse(list.out).data[0].id).toBe(c.id);
    const got = await crm(["data", "get", c.id]);
    expect(got.out).toContain("Listed");
  });

  it("lists with several sort fields, a count, chosen fields and a saved view; aggregates", async () => {
    const c = await create(ws.keys.ops, "contact", { first_name: "Board", email: uniqueEmail("board") });
    for (const [name, amount, stage] of [["Zed", 10, "Proposal"], ["Ann", 30, "Proposal"], ["Ann", 20, "Discovery"]] as const) {
      await create(ws.keys.ops, "deal", { name, amount, stage, primary_contact: c.id });
    }
    const list = await crm(["data", "list", "deal", "--sort", "name,-amount", "--fields", "name,amount", "--count", "--json"]);
    const page = JSON.parse(list.out);
    expect(page.data.map((d: { name: string; amount: number }) => `${d.name}${d.amount}`)).toEqual(["Ann30", "Ann20", "Zed10"]);
    expect(page.total).toBe(3);
    const text = await crm(["data", "list", "deal", "--sort", "name,-amount", "--fields", "name,amount", "--count"]);
    expect(text.out).toMatch(/NAME\s+AMOUNT/);
    expect(text.err).toContain("3 matching record(s)");
    const view = await call("POST", "/v1/views", { key: ws.keys.admin, body: { object: "deal", name: "Anns", where: { field: "name", op: "eq", value: "Ann" } } });
    expect(JSON.parse((await crm(["data", "list", "deal", "--view", view.json.data.id, "--json"])).out).data).toHaveLength(2);
    const agg = await crm(["data", "aggregate", "deal", "--group-by", "stage", "--sum", "amount"]);
    expect(agg.code).toBe(0);
    expect(agg.out).toMatch(/Discovery\s+1\s+20/);
    expect(agg.out).toMatch(/Proposal\s+2\s+40/);
    const json = JSON.parse((await crm(["data", "aggregate", "deal", "--group-by", "stage", "--sum", "amount", "--filter", "name=Ann", "--json"])).out);
    expect(json.data.map((g: { values: { sum_amount: number } }) => g.values.sum_amount)).toEqual([20, 30]);
    expect((await crm(["data", "aggregate", "deal", "--group-by", "amount"])).code).not.toBe(0);
  });
});

describe("crm and record access (ADR 0008)", () => {
  const SECRET = `zq${Date.now().toString(36)}clisentinel`;
  let limited: { id: string; key: string };
  let roleKey: string;
  /** Runs `crm …` as the limited member, through the environment rather than the saved remote. */
  const asLimited = (args: string[]) => crm(args, { env: { HLCRM_CONFIG_DIR: join(home, "config"), HLCRM_API_URL: "http://localhost", HLCRM_API_KEY: limited.key } });
  beforeAll(async () => {
    expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "cli_secret", type: "text" } })).status).toBe(201);
    await create(ws.keys.ops, "contact", { first_name: "Hidden", email: uniqueEmail("hid"), cli_secret: SECRET, phone: "555 0199" });
    roleKey = `cli_limited_${Date.now().toString(36)}`;
    const r = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: roleKey, name: "CLI limited", permissions: ["records:read", "records:write", "records:archive"],
      objects: { deal: { read: false, write: false, archive: false } }, fields: { contact: { cli_secret: "none", phone: "read" } } } });
    expect(r.status).toBe(201);
    limited = await memberWithKey(ws, roleKey, ["ops:read", "ops:write"]);
  });

  it("doctor reports the key's record access", async () => {
    const d = await asLimited(["doctor"]);
    expect(d.code).toBe(0);
    const line = d.out.split("\n").find((l) => l.includes("record access"))!;
    expect(line).toMatch(/^ok\s+record access\s+limited: /);
    for (const l of ["deal: none", "contact.cli_secret: none", "contact.phone: read"]) expect(line).toContain(l);
    const j = JSON.parse((await asLimited(["doctor", "--json"])).out);
    expect(j.record_access.find((o: { object: string }) => o.object === "deal")).toMatchObject({ read: false });
    expect((await crm(["doctor"])).out).toMatch(/record access\s+read, write and archive on every object and field/);
  });

  it("roles get shows the rules and the access they give", async () => {
    const r = await crm(["roles", "get", roleKey]);
    expect(r.code).toBe(0);
    const rules = r.out.split("\n").find((l) => l.startsWith("rules"))!;
    for (const l of ["deal: read denied, write denied, archive denied", "contact.cli_secret: none", "contact.phone: read"]) expect(rules).toContain(l);
    expect(r.out).not.toContain("[object Object]");
    expect(r.out).toMatch(/deal\s+none/);
    expect(r.out).toMatch(/contact\s+read, write, archive\s+.*cli_secret: none/);
    expect(JSON.parse((await crm(["roles", "get", roleKey, "--json"])).out).access.find((o: { object: string }) => o.object === "deal")).toMatchObject({ read: false });
  });

  it("schema describe shows what the key can do; schema pull keeps the key's access out of the file", async () => {
    const all = await asLimited(["schema", "describe"]);
    expect(all.out).toMatch(/\bdeal\b.*\bnone\b/);
    const one = await asLimited(["schema", "describe", "contact"]);
    expect(one.out).toContain("This key: read, write, archive.");
    expect(one.out).toMatch(/cli_secret\s+.*\s+text\s+none/);
    const path = file("limited.schema.yaml");
    const pulled = await asLimited(["schema", "pull", "-o", path]);
    expect(pulled.code).toBe(0);
    expect(pulled.err).toMatch(/^Note: this key's record access is limited \(.*deal: none.*\)\. The file still lists every object and field/);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("cli_secret"); // names are not data
    expect(parseDoc(text, path)).not.toHaveProperty("access");
  });

  it("data export prints the API's refusal and leaves an existing file alone", async () => {
    const out = file("refused.csv");
    writeFileSync(out, "keep me\n");
    for (const args of [["data", "export", "deal", "-o", out, "--yes"], ["data", "export", "contact", "-o", out, "--yes", "--filter", `cli_secret=${SECRET}`]]) {
      const r = await asLimited(args);
      expect(r.code, args.join(" ")).toBe(3);
      expect(r.err).toMatch(/^Error: (This key can't read deal records|"cli_secret" is not visible to this key, so it cannot be filtered on) \(403 forbidden\)/);
      expect(readFileSync(out, "utf8")).toBe("keep me\n");
    }
    const ok = await asLimited(["data", "export", "contact", "-o", out, "--yes"]);
    expect(ok.code).toBe(0);
    const csv = readFileSync(out, "utf8");
    expect(csv.split("\r\n")[0]).not.toContain("cli_secret");
    expect(csv).not.toContain(SECRET);
    expect(csv).toContain("555 0199");
  });

  it("data import prints the API's refusal naming the columns", async () => {
    const csv = file("refused-import.csv");
    writeFileSync(csv, `email,phone,cli_secret\n${uniqueEmail("ri")},1,x\n`);
    const r = await asLimited(["data", "import", "contact", csv]);
    expect(r.code).toBe(3);
    expect(r.err).toContain(`Error: This key can't write contact.phone (column "phone"), contact.cli_secret (column "cli_secret"); map those columns to "" to leave them out (403 forbidden)`);
    const ok = await asLimited(["data", "import", "contact", csv, "--map", "phone=", "--map", "cli_secret="]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("Dry run: 1 to create");
  });
});

describe("crm data: bulk changes, merge, duplicates and restore", () => {
  const ops = () => ({ env: { HLCRM_CONFIG_DIR: join(home, "config"), HLCRM_API_URL: "http://localhost", HLCRM_API_KEY: ws.keys.ops } });

  it("update and archive by filter preview first, need --yes under --no-input, and never widen", async () => {
    const tag = `cli-bulk-${Date.now()}`;
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await create(ws.keys.ops, "contact", { email: uniqueEmail(`cb${i}`), source: tag })).id);
    const refused = await crm(["data", "update", "contact", "--where", `source=${tag}`, "--set", "job_title=CLI", "--no-input"], ops());
    expect(refused.code).toBe(6);
    expect(refused.out).toContain("3 contact record(s) would be updated");
    expect((await call("GET", `/v1/records/${ids[0]}`, { key: ws.keys.ops })).json.data.job_title).toBeNull();
    const done = await crm(["data", "update", "contact", "--where", `source=${tag}`, "--set", "job_title=CLI", "--set", "lifecycle_stage=\"lead\"", "--yes", "--json"], ops());
    expect(done.code).toBe(0);
    expect(JSON.parse(done.out).result.counts.update).toBe(3);
    expect((await call("GET", `/v1/records/${ids[2]}`, { key: ws.keys.ops })).json.data).toMatchObject({ job_title: "CLI", lifecycle_stage: "lead" });
    const bad = await crm(["data", "update", "contact", "--id", ids[0]!, "--set", "email=not-an-email", "--yes"], ops());
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("Nothing was changed");
    const arch = await crm(["data", "archive", "contact", "--where", JSON.stringify({ field: "source", op: "eq", value: tag }), "--yes"], ops());
    expect(arch.code).toBe(0);
    expect(arch.out).toContain("Archived 3 record(s)");
    const listed = await crm(["data", "list", "contact", "--archived", "--filter", `source=${tag}`, "--json"], ops());
    expect(JSON.parse(listed.out).data).toHaveLength(3);
    const restored = await crm(["data", "restore", ids[0]!], ops());
    expect(restored.code).toBe(0);
    expect(restored.out).toContain(`Restored ${ids[0]}`);
  });

  it("finds duplicates and merges them after a preview", async () => {
    const stamp = Date.now().toString(36);
    const a = await create(ws.keys.ops, "contact", { first_name: `Cli${stamp}`, last_name: "Twin", email: uniqueEmail("t1") });
    const b = await create(ws.keys.ops, "contact", { first_name: `cli${stamp}`, last_name: "twin", email: uniqueEmail("t2"), job_title: "Twin" });
    const d = await crm(["data", "duplicates", "contact", "--rule", "first_name,last_name"], ops());
    expect(d.code).toBe(0);
    expect(d.out).toMatch(/Group \d+: 2 records, normalized first_name \+ last_name/);
    const no = await crm(["data", "merge", a.id, b.id, "--no-input"], ops());
    expect(no.code).toBe(6);
    expect(no.out).toContain("job_title");
    const yes = await crm(["data", "merge", a.id, b.id, "--yes"], ops());
    expect(yes.code).toBe(0);
    expect((await call("GET", `/v1/records/${b.id}`, { key: ws.keys.ops })).json.data.merged_into).toBe(a.id);
  });

  it("erases a contact for good after a preview, with an admin key", async () => {
    const c = await create(ws.keys.ops, "contact", { first_name: "Cli", last_name: "Erased", email: uniqueEmail("erase") });
    const admin = () => ({ env: { HLCRM_CONFIG_DIR: join(home, "config"), HLCRM_API_URL: "http://localhost", HLCRM_API_KEY: ws.keys.admin } });
    const refused = await crm(["data", "erase", "contact", c.id, "--yes"], ops());
    expect(refused.code).not.toBe(0);
    const no = await crm(["data", "erase", "contact", c.id, "--no-input"], admin());
    expect(no.code).toBe(6);
    expect(no.out).toContain("contacts: 1");
    expect((await call("GET", `/v1/records/${c.id}`, { key: ws.keys.ops })).json.data.last_name).toBe("Erased");
    const yes = await crm(["data", "erase", "contact", c.id, "--yes"], admin());
    expect(yes.code, yes.err).toBe(0);
    expect(yes.out).toContain(`Erased ${c.id}`);
    const got = (await call("GET", `/v1/records/${c.id}`, { key: ws.keys.ops })).json.data;
    expect(got).toMatchObject({ last_name: "[erased]", email: null });
    expect(got.erased_at).toBeTruthy();
  });

  it("a record's name can't forge output lines in duplicates", async () => {
    const stamp = Date.now().toString(36);
    const forged = `Forged${stamp}`;
    await create(ws.keys.ops, "contact", { first_name: `Nl${stamp}`, last_name: `x\n${forged} line\r\nGroup 99: fake`, email: uniqueEmail("nl1") });
    await create(ws.keys.ops, "contact", { first_name: `nl${stamp}`, last_name: `x\n${forged} line\r\nGroup 99: fake`, email: uniqueEmail("nl2") });
    const d = await crm(["data", "duplicates", "contact", "--rule", "first_name,last_name", "--limit", "200"], ops());
    expect(d.code).toBe(0);
    expect(d.out).toContain(forged);
    for (const line of d.out.split("\n")) expect(line.trimStart().startsWith(forged) || line.startsWith("Group 99")).toBe(false);
  });
});

describe("crm roles, webhooks, access review and events", () => {
  it("creates, updates, shows and archives a role from flags and a file", async () => {
    const key = `cli_role_${Date.now().toString(36)}`;
    writeFileSync(file("role.yaml"), `key: ${key}\nname: CLI role\npermissions: [records:read, records:write]\nfields:\n  contact:\n    phone: read\n`);
    const made = await crm(["roles", "create", "--file", file("role.yaml"), "--object", "deal:read=deny", "--object", "deal:write=deny", "--json"]);
    expect(made.code, made.err).toBe(0);
    expect(JSON.parse(made.out).data).toMatchObject({ key, objects: { deal: { read: false, write: false } }, fields: { contact: { phone: "read" } } });
    expect((await crm(["roles", "update", key, "--field", "contact.phone=inherit", "--field", "contact.email=none"])).code).toBe(0);
    const access = await crm(["roles", "access", key, "--json"]);
    const contact = JSON.parse(access.out).data.objects.find((o: { object: string }) => o.object === "contact");
    expect(contact.fields).toEqual({ email: "none" });
    expect((await crm(["roles", "update", key, "--object", "deal:fly=deny"])).code).toBe(2);
    expect((await crm(["roles", "archive", key, "--no-input"])).code).toBe(6);
    expect((await crm(["roles", "archive", key, "--yes"])).code).toBe(0);
  });

  it("permission sets: create, show, give to a member and take away, archive", async () => {
    const key = `cli_set_${Date.now().toString(36)}`;
    const made = await crm(["permission-sets", "create", "--key", key, "--name", "CLI set", "--permissions", "views:manage", "--object", "deal:read=allow", "--json"]);
    expect(made.code, made.err).toBe(0);
    expect(JSON.parse(made.out).data).toMatchObject({ key, feature_permissions: ["views:manage"], record_permissions: [], objects: { deal: { read: true } } });
    expect(JSON.parse(made.out).data.id).toMatch(/^pset_/);
    expect((await crm(["permission-sets", "list"])).out).toContain(key);
    const shown = await crm(["permission-sets", "get", key]);
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toContain("feature_permissions");
    expect((await crm(["permission-sets", "update", key, "--field", "deal.amount=read"])).code).toBe(0);
    const access = JSON.parse((await crm(["permission-sets", "access", key, "--json"])).out).data.objects.find((o: { object: string }) => o.object === "deal");
    expect(access).toMatchObject({ read: true, write: false, fields: { amount: "read" } });

    const added = await crm(["members", "add", "--email", uniqueEmail("cliset"), "--name", "Set Holder", "--role", "read_only", "--permission-sets", key, "--json"]);
    expect(added.code, added.err).toBe(0);
    const member = JSON.parse(added.out).data as { id: string; permission_sets: string[] };
    expect(member.permission_sets).toEqual([key]);
    expect((await crm(["members", "list"])).out).toContain(key);
    // Held by an active member, so it can't be archived yet (a conflict).
    expect((await crm(["permission-sets", "archive", key, "--yes"])).code).not.toBe(0);
    const cleared = await crm(["members", "update", member.id, "--permission-sets", "none", "--json"]);
    expect(JSON.parse(cleared.out).data.permission_sets).toEqual([]);
    expect((await crm(["members", "update", member.id])).code).toBe(2);
    expect((await crm(["permission-sets", "archive", key, "--no-input"])).code).toBe(6);
    expect((await crm(["permission-sets", "archive", key, "--yes"])).code).toBe(0);
  });

  it("files: attach a local file to a record, list, download it back and remove it", async () => {
    const contact = await create(ws.keys.ops, "contact", { first_name: "Filey", email: uniqueEmail("clifile") });
    writeFileSync(file("brief.txt"), "The brief, line one.\nLine two.\n");
    const attached = await crm(["files", "attach", contact.id, file("brief.txt"), "--json"]);
    expect(attached.code, attached.err).toBe(0);
    const info = JSON.parse(attached.out).data as { id: string; name: string; size: number; content_type: string };
    expect(info).toMatchObject({ name: "brief.txt", size: 31, content_type: "text/plain" });
    expect((await crm(["files", "list", contact.id])).out).toContain("brief.txt");
    const out = file("copy.txt");
    const got = await crm(["files", "download", info.id, "--output", out]);
    expect(got.code, got.err).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("The brief, line one.\nLine two.\n");
    // An existing file is not replaced without a yes.
    expect((await crm(["files", "download", info.id, "--output", out, "--no-input"])).code).toBe(6);
    expect((await crm(["files", "attach", contact.id, file("no-such-file.txt")])).code).toBe(2);
    expect((await crm(["files", "list", "not an id"])).code).toBe(2);
    expect((await crm(["files", "remove", info.id, "--no-input"])).code).toBe(6);
    expect((await crm(["files", "remove", info.id, "--yes"])).code).toBe(0);
    expect(JSON.parse((await crm(["files", "list", contact.id, "--json"])).out).data).toEqual([]);
  });

  it("webhooks: list, get, test, deliveries; the secret goes to stdout alone", async () => {
    const hook = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: "https://hooks.example.com/cli", events: ["contact.created"] } });
    const id = hook.json.data.id as string;
    expect((await crm(["webhooks", "list"])).out).toContain(id);
    expect((await crm(["webhooks", "get", id])).out).toContain("https://hooks.example.com/cli");
    expect((await crm(["webhooks", "test", id])).out).toContain("Queued test delivery dlv_");
    expect(JSON.parse((await crm(["webhooks", "deliveries", id, "--json"])).out).data[0]).toMatchObject({ event_type: "webhook.test" });
    expect((await crm(["webhooks", "secret", id, "--no-input"])).code).toBe(6);
    const s = await crm(["webhooks", "secret", id, "--yes"]);
    expect(s.code).toBe(0);
    expect(s.out).toMatch(/^whsec_\S+\n$/);
    expect(s.err).not.toContain(s.out.trim());
  });

  it("automations: create and update from a file after a dry run, pause, resume, run and runs", async () => {
    writeFileSync(file("auto.yaml"), [
      "name: CLI stamp", "trigger:", "  type: manual", "  object: contact", "actions:",
      "  - type: http_request", "    id: push", "    method: POST", "    url: https://hooks.example.com/cli-auto?c={{record.id}}",
      "    secret_headers:", "      Authorization: Bearer cli-secret-value", "  - type: update_record", "    values:", "      job_title: stamped by cli",
    ].join("\n"));
    const refused = await crm(["automations", "create", "--file", file("auto.yaml"), "--no-input"]);
    expect(refused.code).toBe(6);
    expect(refused.err).toContain("https://hooks.example.com/cli-auto?c={{record.id}}");
    const made = await crm(["automations", "create", "--file", file("auto.yaml"), "--yes", "--json"]);
    expect(made.code, made.err).toBe(0);
    const id = JSON.parse(made.out).automation.id as string;
    expect(made.out + made.err).not.toContain("cli-secret-value");
    expect((await crm(["automations", "list"])).out).toContain(id);
    expect((await crm(["automations", "get", id])).out).not.toContain("cli-secret-value");
    writeFileSync(file("auto-patch.json"), JSON.stringify({ name: "CLI stamp 2" }));
    expect((await crm(["automations", "update", id, "--file", file("auto-patch.json"), "--yes"])).out).toContain(`Updated ${id}`);
    writeFileSync(file("auto-bad.yaml"), "name: x\ndry_run: false\n");
    expect((await crm(["automations", "create", "--file", file("auto-bad.yaml"), "--yes"])).code).toBe(2);
    expect((await crm(["automations", "pause", id, "--reason", "cli test"])).out).toContain("paused");
    expect((await crm(["automations", "resume", id, "--no-input"])).code).toBe(6);
    expect((await crm(["automations", "resume", id, "--yes"])).out).toContain("enabled");
    const c = await create(ws.keys.ops, "contact", { first_name: "Cli", email: uniqueEmail("cli-auto") });
    const dry = await crm(["automations", "run", id, "--record", c.id, "--dry-run"]);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`POST https://hooks.example.com/cli-auto?c=${c.id}`);
    expect((await crm(["automations", "run", id, "--record", c.id, "--no-input"])).code).toBe(6);
    const ran = await crm(["automations", "run", id, "--record", c.id, "--yes"]);
    expect(ran.code, ran.err).toBe(0);
    expect(ran.out).toContain("Queued run_");
    const runs = await crm(["automations", "runs", id, "--json"]);
    expect(JSON.parse(runs.out).data[0]).toMatchObject({ trigger: "manual", status: "queued" });
    expect((await crm(["automations", "get", "auto_nope"])).code).toBe(2);
  });

  it("access review and dead events", async () => {
    const review = await crm(["audit", "review", "--json"]);
    expect(JSON.parse(review.out).data.members.length).toBeGreaterThan(0);
    expect((await crm(["audit", "review"])).out).toContain("USABLE_KEYS");
    const dead = await crm(["events", "list", "--status", "dead", "--json"]);
    expect(dead.code).toBe(0);
    expect(JSON.parse(dead.out).data).toEqual([]);
  });
});

describe("crm audit verify", () => {
  const owner = postgres(process.env.TEST_MIGRATOR_URL!, { max: 1, onnotice: () => {} });
  afterAll(() => owner.end());

  it("exits 0 on a sealed, anchored log and 1 once a row is changed", async () => {
    // Its own workspace, sealed and anchored first, so the result doesn't depend on what else ran.
    const v = await newWorkspace("CLI verify");
    while ((await sealTenant(v.tenantId)) > 0) { /* seal everything */ }
    expect(await anchorTenant(v.tenantId)).toBe(true);
    const env = { HLCRM_CONFIG_DIR: join(home, "config"), HLCRM_API_URL: "http://localhost", HLCRM_API_KEY: v.keys.admin };
    const ok = await crm(["audit", "verify"], { env });
    expect(ok.code, ok.out + ok.err).toBe(0);
    expect(ok.out).toMatch(/^Audit log verified: \d+ sealed rows, 1 anchors/);
    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${v.tenantId}, true)`;
      await tx`ALTER TABLE audit_log DISABLE TRIGGER audit_log_guard`;
      await tx`UPDATE audit_log SET details = '{"x": 1}' WHERE audit_log.chain_pos = 1`;
      await tx`ALTER TABLE audit_log ENABLE TRIGGER audit_log_guard`;
    });
    const bad = await crm(["audit", "verify", "--json"], { env });
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out).data).toMatchObject({ ok: false, problem: expect.stringMatching(/position 1/) });
  });
});

describe("crm admin commands", () => {
  it("prints a new key's secret once, on stdout only, and never stores it", async () => {
    const r = await crm(["keys", "create", "--name", "ci", "--scopes", "ops:read"]);
    expect(r.code).toBe(0);
    const secret = r.out.trim();
    expect(secret).toMatch(/^hlcrm_live_[0-9A-Za-z]{52}$/);
    expect(r.err).toContain("shown once");
    expect(r.err).not.toContain(secret);
    expect(readFileSync(configFile(), "utf8")).not.toContain(secret);
    expect((await call("GET", "/v1/me", { key: secret })).status).toBe(200);

    const j = await crm(["keys", "create", "--name", "ci2", "--scopes", "ops:read", "--json"]);
    const created = JSON.parse(j.out).data;
    expect(created.secret).toMatch(/^hlcrm_live_/);
    expect(readFileSync(configFile(), "utf8")).not.toContain(created.secret);

    const rotated = await crm(["keys", "rotate", created.id, "--overlap-hours", "0", "--yes", "--json"]);
    expect(rotated.code).toBe(0);
    expect(readFileSync(configFile(), "utf8")).not.toContain(JSON.parse(rotated.out).data.secret);
    const list = await crm(["keys", "list", "--json"]);
    expect(list.out).not.toMatch(/hlcrm_live_[0-9A-Za-z]{52}/);
    expect((await crm(["keys", "revoke", created.id, "--yes"])).code).toBe(0);
  });

  it("manages members, reads roles and the audit log", async () => {
    const add = await crm(["members", "add", "--email", uniqueEmail("m"), "--name", "Member M", "--role", "read_only", "--json"]);
    expect(add.code).toBe(0);
    const id = JSON.parse(add.out).data.id;
    expect((await crm(["members", "update", id, "--role", "member"])).code).toBe(0);
    expect((await crm(["members", "update", id, "--disable", "--yes"])).code).toBe(0);
    expect((await crm(["members", "list", "--json"])).out).toContain(id);
    expect(JSON.parse((await crm(["roles", "list", "--json"])).out).data.map((r: { key: string }) => r.key)).toContain("read_only");
    expect((await crm(["roles", "get", "member"])).out).toContain("records:write");
    const log = await crm(["audit", "log", "--action", "schema.", "--json"]);
    expect(JSON.parse(log.out).data.length).toBeGreaterThan(0);
  });

  it("an ops key is refused admin commands with exit 3", async () => {
    const r = await crm(["members", "list"], { env: { HLCRM_CONFIG_DIR: join(home, "config"), HLCRM_API_URL: "http://localhost", HLCRM_API_KEY: ws.keys.ops } });
    expect(r.code).toBe(3);
    expect(r.err).toContain("members:manage");
  });

  it("logout forgets the key", async () => {
    expect((await crm(["auth", "logout"])).code).toBe(0);
    expect(readFileSync(configFile(), "utf8")).not.toContain(ws.keys.admin);
    expect((await crm(["auth", "status"])).code).toBe(3);
    expect(existsSync(configFile())).toBe(true);
  });
});

describe("crm sessions", () => {
  it("lists a member's sessions and revokes one or all of them, with confirmation", async () => {
    const env = { HLCRM_CONFIG_DIR: join(home, "config-sessions"), HLCRM_API_URL: "http://localhost", HLCRM_API_KEY: ws.keys.admin };
    const email = uniqueEmail("sess");
    const m = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email, name: "Session person", role: "member" } });
    const id = m.json.data.id as string;
    const [one, two] = [await signedIn(email), await signedIn(email)];
    const list = await crm(["sessions", "list", id, "--json"], { env });
    expect(list.code, list.err).toBe(0);
    const sessions = JSON.parse(list.out).data as { id: string }[];
    expect(sessions).toHaveLength(2);
    const table = await crm(["sessions", "list", id], { env });
    expect(table.out).toContain(sessions[0]!.id);
    expect((await crm(["sessions", "revoke", sessions[0]!.id], { env })).code).not.toBe(0); // needs --yes without a terminal
    expect((await crm(["sessions", "revoke", sessions[0]!.id, "--yes"], { env })).code).toBe(0);
    expect((await crm(["sessions", "list", id, "--json"], { env })).out).not.toContain(sessions[0]!.id);
    const all = await crm(["sessions", "revoke", "--member", id, "--all", "--yes"], { env });
    expect(all.out).toContain("Revoked 1 session(s)");
    for (const b of [one, two]) expect((await b.request("GET", "/v1/me")).status).toBe(401);
    expect((await crm(["sessions", "revoke"], { env })).code).toBe(2);
    expect((await crm(["sessions", "list", "nope"], { env })).code).toBe(2);
  });
});

describe("crm apps", () => {
  it("lists the caller's or a member's connected apps and disconnects one, with confirmation", async () => {
    const env = { HLCRM_CONFIG_DIR: join(home, "config-apps"), HLCRM_API_URL: "http://localhost", HLCRM_API_KEY: ws.keys.admin };
    const email = uniqueEmail("apps");
    const m = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email, name: "Apps person", role: "member" } });
    const id = m.json.data.id as string;
    // A connected app (the OAuth flow itself is tested in test/oauth.test.ts; here only the row matters).
    const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    const { encodeId, decodeId, uuidv7 } = await import("../src/lib/ids.js");
    const grant = uuidv7();
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
        await tx`INSERT INTO oauth_grants (tenant_id, id, user_id, client_id, client_name, client_kind, redirect_uri, scopes, resource, expires_at)
                 VALUES (${ws.tenantId}, ${grant}, ${decodeId(id)!.uuid}, 'https://client.example/c.json', 'Example Assistant', 'metadata_document',
                         'https://client.example/cb', ${["ops:read"]}, 'https://mcp.test/mcp/ops', now() + interval '1 day')`;
      });
    } finally {
      await sql.end();
    }
    const gid = encodeId("ogr", grant);
    expect(JSON.parse((await crm(["apps", "list", "--json"], { env })).out).data).toEqual([]);
    const list = await crm(["apps", "list", "--member", id], { env });
    expect(list.code, list.err).toBe(0);
    expect(list.out).toContain(gid);
    expect(list.out).toContain("Example Assistant");
    expect(list.out).toContain("client.example");
    expect((await crm(["apps", "revoke", gid], { env })).code).not.toBe(0); // needs --yes without a terminal
    expect((await crm(["apps", "revoke", gid, "--yes"], { env })).code).toBe(0);
    expect((await crm(["apps", "list", "--member", id], { env })).out).toContain("has no connected apps");
    expect((await crm(["apps", "revoke", "nope"], { env })).code).toBe(2);
  });
});

describe("hl-crm-db-server sign-in-link", () => {
  it("prints only the one-time link on stdout, and works without email", async () => {
    const { execFile } = await import("node:child_process");
    const run = (args: string[]) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
      execFile(join(process.cwd(), "node_modules/.bin/tsx"), ["src/cli.ts", "sign-in-link", ...args], {
        env: { ...process.env, SMTP_URL: "", LOG_LEVEL: "silent" }, timeout: 30_000,
      }, (e, out, err) => resolve({ code: (e as { code?: number } | null)?.code ?? 0, out, err }));
    });
    const ok = await run(["--email", ws.ownerEmail]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toMatch(/^https:\/\/crm\.test\/auth\/link\?token=[A-Za-z0-9_-]{43}\n$/);
    expect(ok.err).toContain("One-time sign-in link");
    expect(ok.err).not.toContain(new URL(ok.out.trim()).searchParams.get("token")!);
    const token = new URL(ok.out.trim()).searchParams.get("token")!;
    const r = await app.request("/auth/server-link", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://crm.test" },
      body: JSON.stringify({ token }) });
    expect((await r.json()).status).toBe("signed_in");
    const missing = await run(["--email", uniqueEmail("nobody")]);
    expect(missing.code).not.toBe(0);
    expect(missing.out).toBe("");
  });
});
