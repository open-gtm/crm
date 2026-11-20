import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { HlCrmError } from "@hl-crm-db/sdk";
import { describe, expect, it } from "vitest";
import { aggregateBody, filterQuery, parseMappings } from "../src/commands/data.js";
import { keyHint, readConfig, writeConfig } from "../src/config.js";
import { chunkRecords, splitRecords } from "../src/csvsplit.js";
import { CliError, EXIT, exitForStatus, toCliError } from "../src/errors.js";
import { clean, Out } from "../src/output.js";
import { run } from "../src/program.js";
import { limits } from "../src/access.js";
import { configDir, type Runtime } from "../src/runtime.js";
import { terminalRuntime } from "../src/terminal.js";
import { describeChange, formatDoc, parseDoc } from "../src/schemafile.js";

/** A runtime with captured output and no terminal, unless the test says otherwise. */
function fakeRuntime(over: Partial<Runtime> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "crm-unit-"));
  const rt: Runtime = {
    stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), readStdin: async () => "", promptSecret: async () => "",
    confirm: async () => false, env: { HLCRM_CONFIG_DIR: join(dir, "config") }, interactive: false, stdoutIsTTY: false, cwd: dir,
    fetch: async () => { throw new Error("no network in unit tests"); }, ...over,
  };
  return { rt, out: () => out.join(""), err: () => err.join(""), dir };
}

const KEY = `hlcrm_live_abcdEFGH1234${"x".repeat(40)}`;

describe("argument parsing", () => {
  it("turns --filter into the list route's filter parameters", () => {
    expect(filterQuery(["email=a@b.com", "amount[gt]=100", "account.domain=acme.com", "note=a=b"])).toEqual({
      "filter[email]": "a@b.com", "filter[amount][gt]": "100", "filter[account.domain]": "acme.com", "filter[note]": "a=b",
    });
    expect(() => filterQuery(["Bad Field=x"])).toThrow(CliError);
  });

  it("builds the aggregate request from --group-by, measures and filters", () => {
    expect(aggregateBody("deal", { groupBy: "stage,created_at:month", sum: ["amount"], max: ["amount"], filter: ["amount[gt]=100", "name=Big"], order: "count", limit: "5" })).toEqual({
      object: "deal", group_by: [{ field: "stage" }, { field: "created_at", bucket: "month" }], measures: [{ op: "sum", field: "amount" }, { op: "max", field: "amount" }],
      where: { and: [{ path: ["amount"], op: "gt", value: "100" }, { path: ["name"], op: "eq", value: "Big" }] }, order: "count", limit: 5,
    });
    // Values stay text for the server to type by field: a postcode keeps its leading zero, a "true" name stays a name.
    expect(aggregateBody("account", { filter: ["zip=02139"] }).where).toEqual({ path: ["zip"], op: "eq", value: "02139" });
    expect(aggregateBody("account", { filter: ["name=true", "domain[is_null]=false", "zip[in]=02139,10001"] }).where).toEqual({ and: [
      { path: ["name"], op: "eq", value: "true" }, { path: ["domain"], op: "is_null", value: false }, { path: ["zip"], op: "in", value: ["02139", "10001"] }] });
    expect(aggregateBody("deal", {})).toEqual({ object: "deal" });
    expect(() => aggregateBody("deal", { order: "size" })).toThrow(CliError);
    expect(() => aggregateBody("Bad Object", {})).toThrow(CliError);
  });

  it("splits --map at the last =, and allows ignoring a column", () => {
    expect(parseMappings(["Company domain=account.domain", "a=b=c", "Notes="])).toEqual({ "Company domain": "account.domain", "a=b": "c", Notes: "" });
    expect(() => parseMappings(["nofield"])).toThrow(/column=field/);
  });

  it("exits 2 on unknown commands and missing arguments, 0 on --help and --version", async () => {
    expect(await run(["nope"], fakeRuntime().rt)).toBe(EXIT.usage);
    expect(await run(["data", "get"], fakeRuntime().rt)).toBe(EXIT.usage);
    const h = fakeRuntime();
    expect(await run(["schema", "apply", "--help"], h.rt)).toBe(EXIT.ok);
    expect(h.out()).toContain("--accept-drift");
    const v = fakeRuntime();
    expect(await run(["--version"], v.rt)).toBe(EXIT.ok);
    expect(v.out()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("never takes a key as an argument", async () => {
    const f = fakeRuntime();
    expect(await run(["auth", "login", "--url", "https://crm.example.com", "--key", KEY], f.rt)).toBe(EXIT.usage);
    // Without a terminal and without --with-token there is nowhere to read the key from.
    const g = fakeRuntime();
    expect(await run(["auth", "login", "--url", "https://crm.example.com"], g.rt)).toBe(EXIT.usage);
    expect(g.err()).toContain("--with-token");
  });

  it("refuses plain http to a non-local host unless --insecure-http", async () => {
    const f = fakeRuntime({ readStdin: async () => KEY });
    expect(await run(["auth", "login", "--url", "http://crm.internal", "--with-token"], f.rt)).toBe(EXIT.usage);
    expect(f.err()).toContain("--insecure-http");
  });
});

describe("config file", () => {
  it("lives under XDG_CONFIG_HOME or ~/.config, or HLCRM_CONFIG_DIR", () => {
    expect(configDir({}, "darwin", "/home/u")).toBe("/home/u/.config/hl-crm-db");
    expect(configDir({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/u")).toBe("/x/hl-crm-db");
    expect(configDir({ HLCRM_CONFIG_DIR: "/c" }, "linux", "/home/u")).toBe("/c");
  });

  it("is written owner-only in an owner-only directory, and refused when others can read it", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "crm-cfg-")), "hl-crm-db");
    writeConfig(dir, { current: "a", remotes: { a: { url: "https://x.example", key: KEY } } });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
    expect(readConfig(dir).remotes.a!.key).toBe(KEY);
    chmodSync(join(dir, "config.json"), 0o644);
    expect(() => readConfig(dir)).toThrow(/chmod 600/);
    chmodSync(join(dir, "config.json"), 0o600);
    writeFileSync(join(dir, "config.json"), "{not json", { mode: 0o600 });
    expect(() => readConfig(dir)).toThrow(/not valid JSON/);
  });

  it("shows only a key's hint", () => {
    expect(keyHint(KEY)).toBe("hlcrm_live_abcd…");
    expect(keyHint(undefined)).toBe("(none)");
  });

  it("environment variables override the saved remote, and nothing at all means exit 3", async () => {
    const f = fakeRuntime();
    expect(await run(["auth", "status"], f.rt)).toBe(EXIT.auth);
    expect(f.err()).toContain("Not logged in");
    const j = fakeRuntime();
    expect(await run(["auth", "status", "--json"], j.rt)).toBe(EXIT.auth);
    expect(JSON.parse(j.err())).toMatchObject({ error: { code: "not_logged_in" }, exit_code: EXIT.auth });
  });
});

describe("schema files", () => {
  const doc = { format: "hl-crm-db/schema@1", schema_version: 7, modules: ["core", "sales"],
    objects: [{ id: "obj_x", name: "property", label: "Property: a \"home\"", fields: [{ name: "price", type: "currency", default: 0, values: [] }] }],
    pipelines: [{ name: "Sales", is_default: true, stages: [{ name: "New", category: "open", probability: null }] }] };

  it("round-trips through YAML and JSON unchanged", () => {
    const yaml = formatDoc(doc, "crm.schema.yaml");
    expect(yaml.startsWith("# hl-crm-db schema document")).toBe(true);
    expect(parseDoc(yaml, "crm.schema.yaml")).toEqual(doc);
    expect(parseDoc(formatDoc(doc, "s.json"), "s.json")).toEqual(doc);
  });

  it("rejects duplicate keys, invalid syntax and non-mappings", () => {
    expect(() => parseDoc("a: 1\na: 2\n", "x.yaml")).toThrow(CliError);
    expect(() => parseDoc("objects: [", "x.yaml")).toThrow(/not valid YAML/);
    expect(() => parseDoc("- 1\n", "x.yaml")).toThrow(/mapping/);
  });

  it("describes changes readably", () => {
    expect(describeChange({ change: "field_updated", object: "property", field: "notes", before: { api_name: "notes" }, after: { api_name: "remarks" } }))
      .toEqual({ sign: "~", text: "rename field property.notes → remarks" });
    expect(describeChange({ change: "field_archived", object: "property", field: "x" }).sign).toBe("-");
  });
});

describe("CSV chunking", () => {
  it("splits records without breaking quoted line breaks, and keeps line numbers", () => {
    const { header, records } = splitRecords('﻿a,b\r\n"x\r\ny",1\n\nz,2');
    expect(header).toEqual({ text: "a,b", line: 1 });
    expect(records).toEqual([{ text: '"x\r\ny",1', line: 2 }, { text: "z,2", line: 5 }]);
    expect(() => splitRecords('a\n"open')).toThrow(/not closed/);
  });

  it("chunks by rows and bytes, repeating the header", () => {
    const { header, records } = splitRecords(`h\n${Array.from({ length: 5 }, (_, i) => `r${i}`).join("\n")}`);
    const chunks = chunkRecords(header!, records, 2, 1_000);
    expect(chunks.map((c) => c.text)).toEqual(["h\r\nr0\r\nr1\r\n", "h\r\nr2\r\nr3\r\n", "h\r\nr4\r\n"]);
    expect(chunkRecords(header!, records, 100, 10).length).toBe(5);
    expect(() => chunkRecords(header!, [{ text: "x".repeat(50), line: 2 }], 10, 20)).toThrow(/too large/);
  });
});

describe("exit codes and errors", () => {
  it("maps API statuses to documented exit codes", () => {
    expect(exitForStatus(401)).toBe(3);
    expect(exitForStatus(403)).toBe(3);
    expect(exitForStatus(409)).toBe(4);
    expect(exitForStatus(412)).toBe(4);
    expect(exitForStatus(428)).toBe(4);
    expect(exitForStatus(422)).toBe(1);
    expect(EXIT).toEqual({ ok: 0, failure: 1, usage: 2, auth: 3, conflict: 4, changes: 5, notConfirmed: 6 });
  });

  it("keeps the API's code, detail and request ID", () => {
    const e = toCliError(new HlCrmError(412, "schema_drift", "The schema changed", [{ field: "x" }], "req-1"));
    expect(e).toMatchObject({ code: "schema_drift", message: "The schema changed", exit: 4, extra: { status: 412, requestId: "req-1" } });
  });

  it("prints problem detail and request ID, as text or as JSON on stderr", async () => {
    const env = { HLCRM_API_URL: "https://crm.example.com", HLCRM_API_KEY: KEY };
    const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({ code: "forbidden", detail: "This key lacks the \"audit:read\" permission", request_id: "r-42" }),
      { status: 403, headers: { "Content-Type": "application/problem+json" } });
    const t = fakeRuntime({ env, fetch });
    expect(await run(["audit", "log"], t.rt)).toBe(EXIT.auth);
    expect(t.err()).toContain('This key lacks the "audit:read" permission (403 forbidden)');
    expect(t.err()).toContain("Request ID: r-42");
    const j = fakeRuntime({ env, fetch });
    expect(await run(["audit", "log", "--json"], j.rt)).toBe(EXIT.auth);
    expect(JSON.parse(j.err())).toMatchObject({ error: { code: "forbidden", status: 403, request_id: "r-42" }, exit_code: 3 });
  });

  it("a confirmation that is needed is an error with --no-input, and never assumed", async () => {
    const env = { HLCRM_API_URL: "https://crm.example.com", HLCRM_API_KEY: KEY };
    let called = false;
    const fetch: typeof globalThis.fetch = async () => {
      called = true;
      return new Response("{}");
    };
    const t = fakeRuntime({ env, fetch, interactive: true, confirm: async () => true });
    expect(await run(["keys", "revoke", `key_${"0".repeat(26)}`, "--no-input"], t.rt)).toBe(EXIT.notConfirmed);
    expect(called).toBe(false);
    const no = fakeRuntime({ env, fetch, interactive: true, confirm: async () => false });
    expect(await run(["keys", "revoke", `key_${"0".repeat(26)}`], no.rt)).toBe(EXIT.notConfirmed);
    expect(called).toBe(false);
    const yes = fakeRuntime({ env, fetch });
    expect(await run(["keys", "revoke", `key_${"0".repeat(26)}`, "--yes"], yes.rt)).toBe(EXIT.ok);
    expect(called).toBe(true);
  });

  it("does not print a key it was given in the environment", async () => {
    const t = fakeRuntime({ env: { HLCRM_API_URL: "https://crm.example.com", HLCRM_API_KEY: KEY }, fetch: async () => new Response(JSON.stringify({
      workspace: { id: "ws_1", name: "W", schema_version: 1 }, actor: { type: "user", id: "usr_1", role: "owner" }, permissions: ["records:read"], scopes: ["ops:read"] })) });
    expect(await run(["auth", "status"], t.rt)).toBe(EXIT.ok);
    expect(t.out() + t.err()).not.toContain(KEY);
    expect(t.out()).toContain("hlcrm_live_abcd…");
  });
});

/**
 * main.ts's runtime, driven through PassThrough streams that say they are terminals. What stays
 * untested: a real TTY's raw mode (readline turns it on only for streams that have setRawMode).
 */
describe("terminal prompts", () => {
  function terminal(tty = true) {
    const stdin = Object.assign(new PassThrough(), { isTTY: tty });
    const stderr = Object.assign(new PassThrough(), { isTTY: tty });
    const stdout = Object.assign(new PassThrough(), { isTTY: false });
    let shown = "";
    stderr.on("data", (c: Buffer) => void (shown += c.toString()));
    const dir = mkdtempSync(join(tmpdir(), "crm-tty-"));
    return { rt: terminalRuntime({ stdin, stdout, stderr, env: { HLCRM_CONFIG_DIR: join(dir, "config") }, cwd: dir }), stdin, shown: () => shown };
  }

  it("reads an API key without echoing it", async () => {
    const t = terminal();
    const answer = t.rt.promptSecret("API key (input hidden): ");
    t.stdin.write(`${KEY}\r`);
    expect(await answer).toBe(KEY);
    expect(t.shown()).toContain("API key (input hidden): ");
    expect(t.shown()).not.toContain(KEY.slice(11));
  });

  it("confirms only on y or yes; anything else, or the end of input, is a no", async () => {
    for (const [typed, want] of [["y\n", true], ["YES\n", true], ["n\n", false], ["\n", false], ["yep\n", false]] as const) {
      const t = terminal();
      const answer = t.rt.confirm("Go? [y/N] ");
      t.stdin.write(typed);
      expect(await answer, JSON.stringify(typed)).toBe(want);
      expect(t.shown()).toContain("Go? [y/N] ");
    }
    const closed = terminal();
    const answer = closed.rt.confirm("Go? [y/N] ");
    closed.stdin.end();
    expect(await answer).toBe(false);
  });

  it("is interactive only when stdin and stderr are terminals", () => {
    expect(terminal(true).rt.interactive).toBe(true);
    expect(terminal(false).rt.interactive).toBe(false);
  });

  it("a command that needs confirmation asks on the terminal and does nothing on no", async () => {
    const t = terminal();
    const code = run(["keys", "revoke", `key_${"0".repeat(26)}`], t.rt);
    await new Promise((r) => setTimeout(r, 20));
    t.stdin.write("n\n");
    expect(await code).toBe(EXIT.notConfirmed);
    expect(t.shown()).toContain("Anything using it stops working now. [y/N] ");
    expect(t.shown()).toContain("Cancelled; nothing was changed");
  });

  it("login prompts for the key on the terminal and refuses something that isn't one", async () => {
    const t = terminal();
    const code = run(["auth", "login", "--url", "https://crm.example.com"], t.rt);
    await new Promise((r) => setTimeout(r, 20));
    t.stdin.write("not-a-key\r");
    expect(await code).toBe(EXIT.usage);
    expect(t.shown()).toContain("API key (input hidden): ");
    expect(t.shown()).not.toContain("not-a-key");
    expect(t.shown()).toContain("That is not an hl-crm-db API key");
  });
});

describe("record access summaries", () => {
  it("lists what is less than read, write and archive, and nothing for full access", () => {
    const full = { object: "contact", read: true, write: true, archive: true, fields: {} };
    expect(limits([full])).toEqual([]);
    expect(limits([{ ...full, fields: { phone: "read" } }, { object: "deal", read: false, write: false, archive: false, fields: { name: "none" } },
      { object: "lead", read: true, write: false, archive: false, fields: {} }])).toEqual(["contact.phone: read", "deal: none", "lead: read"]);
  });
});

describe("where a saved key may go", () => {
  const saved = (url = "https://crm.example.com") => {
    let sentTo: string[] = [];
    const f = fakeRuntime({ fetch: async (input) => {
      sentTo.push(String(input));
      return new Response(JSON.stringify({ workspace: { id: "ws_1", name: "W", schema_version: 1 }, actor: { type: "user", id: "usr_1", role: "owner" },
        permissions: [], scopes: [] }));
    } });
    writeConfig(join(f.dir, "config"), { current: "prod", remotes: { prod: { url, key: KEY } } });
    return { ...f, sent: () => sentTo, reset: () => void (sentTo = []) };
  };

  it("HLCRM_API_URL alone must name the saved remote's origin; with HLCRM_API_KEY it may be anywhere", async () => {
    const elsewhere = saved();
    elsewhere.rt.env.HLCRM_API_URL = "https://evil.example";
    expect(await run(["auth", "status"], elsewhere.rt)).toBe(EXIT.usage);
    expect(elsewhere.err()).toContain("HLCRM_API_KEY");
    expect(elsewhere.sent()).toEqual([]);
    const port = saved();
    port.rt.env.HLCRM_API_URL = "https://crm.example.com:8443";
    expect(await run(["auth", "status"], port.rt)).toBe(EXIT.usage);
    expect(port.sent()).toEqual([]);
    const same = saved();
    same.rt.env.HLCRM_API_URL = "https://crm.example.com/";
    expect(await run(["auth", "status"], same.rt)).toBe(EXIT.ok);
    expect(same.sent()).toEqual(["https://crm.example.com/v1/me"]);
    const both = saved();
    Object.assign(both.rt.env, { HLCRM_API_URL: "https://other.example", HLCRM_API_KEY: `hlcrm_test_${"y".repeat(52)}` });
    expect(await run(["auth", "status"], both.rt)).toBe(EXIT.ok);
    expect(both.sent()).toEqual(["https://other.example/v1/me"]);
  });

  it("crm api only takes paths on the API, never a URL to somewhere else", async () => {
    for (const path of ["https://evil.example/v1/me", "http://evil.example/v1/me", "/v1/me\\@evil.example"]) {
      const f = saved();
      expect(await run(["api", "GET", path], f.rt), path).toBe(EXIT.usage);
      expect(f.sent(), path).toEqual([]);
    }
    const f = saved();
    expect(await run(["api", "GET", "//evil.example/v1/me"], f.rt)).toBe(EXIT.ok);
    expect(new URL(f.sent()[0]!).origin).toBe("https://crm.example.com");
  });
});

describe("output that reaches a terminal", () => {
  /** The escape, bell, C1 CSI and bidi override characters left in `s`. */
  const unsafe = (s: string) => [..."\u001b\u0007\u009b\u202e"].filter((c) => s.includes(c));
  const evil = "a\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007\u009b31m‮b\tc\r\nd";

  it("clean and table drop control and bidi characters", () => {
    expect(clean(evil)).toBe("a]8;;https://evil.examplelink]8;;31mbc\nd");
    const t = fakeRuntime();
    new Out(t.rt, false).table([{ v: evil }], ["v"]);
    expect(unsafe(t.out())).toEqual([]);
  });

  it("raw text is stripped on a terminal and passed through untouched when piped", () => {
    const tty = fakeRuntime({ stdoutIsTTY: true });
    new Out(tty.rt, false).raw(evil);
    expect(tty.out()).toBe("a]8;;https://evil.examplelink]8;;31mb\tc\nd");
    const piped = fakeRuntime();
    new Out(piped.rt, false).raw(evil);
    expect(piped.out()).toBe(evil);
  });

  it("JSON output escapes C1 and bidi controls and stays the same JSON", () => {
    const t = fakeRuntime({ stdoutIsTTY: true });
    new Out(t.rt, true).data({ v: evil });
    expect(unsafe(t.out())).toEqual([]);
    expect(JSON.parse(t.out())).toEqual({ v: evil });
  });

  it("crm api prints a non-JSON response stripped on a terminal", async () => {
    const t = fakeRuntime({ stdoutIsTTY: true, env: { HLCRM_API_URL: "https://crm.example.com", HLCRM_API_KEY: KEY },
      fetch: async () => new Response(evil, { headers: { "Content-Type": "text/plain" } }) });
    expect(await run(["api", "GET", "/v1/objects/contact/export"], t.rt)).toBe(EXIT.ok);
    expect(unsafe(t.out())).toEqual([]);
  });
});

describe("files the CLI writes", () => {
  const env = { HLCRM_API_URL: "https://crm.example.com", HLCRM_API_KEY: KEY };
  const exportFetch: typeof fetch = async () => new Response("id,name\r\ncon_1,A\r\n", { headers: { "Content-Type": "text/csv", "X-Row-Count": "1" } });
  const exporter = (over: Partial<Runtime> = {}) => fakeRuntime({ env, fetch: exportFetch, ...over });

  it("exports to a new owner-only file, replaces an existing one only when confirmed, and never prompts with --no-input", async () => {
    const f = exporter();
    const out = join(f.dir, "out.csv");
    expect(await run(["data", "export", "contact", "-o", out], f.rt)).toBe(EXIT.ok);
    expect(readFileSync(out, "utf8")).toBe("id,name\r\ncon_1,A\r\n");
    expect(statSync(out).mode & 0o777).toBe(0o600);
    writeFileSync(out, "keep\n", { mode: 0o644 });
    let asked = false;
    const noInput = exporter({ interactive: true, confirm: async () => (asked = true) });
    expect(await run(["data", "export", "contact", "-o", out, "--no-input"], noInput.rt)).toBe(EXIT.notConfirmed);
    expect(asked).toBe(false);
    expect(readFileSync(out, "utf8")).toBe("keep\n");
    expect(await run(["data", "export", "contact", "-o", out, "--yes"], exporter().rt)).toBe(EXIT.ok);
    expect(readFileSync(out, "utf8")).toContain("con_1");
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it("refuses to write through a symlink, a dangling one included, even with --yes", async () => {
    const f = exporter();
    const target = join(f.dir, "elsewhere.txt");
    writeFileSync(target, "precious\n");
    const link = join(f.dir, "link.csv");
    symlinkSync(target, link);
    expect(await run(["data", "export", "contact", "-o", link, "--yes"], f.rt)).toBe(EXIT.usage);
    expect(f.err()).toContain("symbolic link");
    expect(readFileSync(target, "utf8")).toBe("precious\n");
    const dangling = join(f.dir, "dangling.csv");
    symlinkSync(join(f.dir, "not-yet.txt"), dangling);
    expect(await run(["data", "export", "contact", "-o", dangling, "--yes"], exporter().rt)).toBe(EXIT.usage);
    expect(existsSync(join(f.dir, "not-yet.txt"))).toBe(false);
  });

  it("asks before an import overwrites an existing error report, never under --no-input, and refuses a symlinked one", async () => {
    let sent = 0;
    const importer = (over: Partial<Runtime> = {}) => fakeRuntime({ env, fetch: async () => {
      sent++;
      return new Response(JSON.stringify({ counts: { create: 0, update: 0, skip: 0, error: 1 }, key: null, ignored_columns: [],
        rows: [{ row: 1, line: 2, action: "error", reason: "bad" }] }), { headers: { "Content-Type": "application/json" } });
    }, ...over });
    const f = importer();
    const csv = join(f.dir, "in.csv");
    writeFileSync(csv, "first_name\nA\n");
    writeFileSync(`${csv}.errors.csv`, "old report\n");
    // Asked only when there are errors to write; with --no-input it isn't asked, and the old file stays.
    expect(await run(["data", "import", "contact", csv, "--no-input", "--json"], f.rt)).toBe(EXIT.failure);
    expect(JSON.parse(f.out())).toMatchObject({ report: null, report_not_written: expect.stringContaining("--yes"), errors: [{ row: 1 }] });
    expect(readFileSync(`${csv}.errors.csv`, "utf8")).toBe("old report\n");
    let asked = "";
    const declined = importer({ interactive: true, confirm: async (q) => { asked = q; return false; } });
    expect(await run(["data", "import", "contact", csv], declined.rt)).toBe(EXIT.failure);
    expect(asked).toContain("errors.csv exists. Overwrite it?");
    expect(declined.err()).toContain("The error report was not written");
    expect(readFileSync(`${csv}.errors.csv`, "utf8")).toBe("old report\n");
    sent = 0;
    expect(await run(["data", "import", "contact", csv, "--yes"], importer().rt)).toBe(EXIT.failure);
    expect(readFileSync(`${csv}.errors.csv`, "utf8")).toMatch(/^row,line,action/);
    expect(statSync(`${csv}.errors.csv`).mode & 0o777).toBe(0o600);
    const link = join(f.dir, "report-link.csv");
    symlinkSync(join(f.dir, "victim.txt"), link);
    expect(await run(["data", "import", "contact", csv, "--report", link, "--yes"], importer().rt)).toBe(EXIT.usage);
    expect(existsSync(join(f.dir, "victim.txt"))).toBe(false);
    expect(sent).toBe(1); // refused before anything was sent
  });
});

describe("schema plan exit codes", () => {
  const plan = (over: Record<string, unknown>) => fakeRuntime({ env: { HLCRM_API_URL: "https://crm.example.com", HLCRM_API_KEY: KEY },
    fetch: async () => new Response(JSON.stringify({ schema_version: 9, document_version: 3, changes: [{ change: "object_updated", object: "x", after: {} }],
      unsupported: [], notes: [], matched_by_name: [], drift: [], ...over }), { headers: { "Content-Type": "application/json" } }) });

  it("exits 4 when drift could not all be listed, as apply would refuse it", async () => {
    const f = plan({});
    writeFileSync(join(f.dir, "schema.yaml"), "schema_version: 3\nobjects: []\n");
    f.rt.cwd = f.dir;
    const file = join(f.dir, "schema.yaml");
    expect(await run(["schema", "plan", "-f", file], f.rt)).toBe(EXIT.changes);
    const t = plan({ drift_truncated: true });
    expect(await run(["schema", "plan", "-f", file], t.rt)).toBe(EXIT.conflict);
    expect(t.out()).toContain("can't be told");
  });
});

describe("pack init", () => {
  it("writes the template files from templates/pack, and they pass validate", async () => {
    const t = fakeRuntime();
    const dir = join(t.dir, "my-pack");
    expect(await run(["pack", "init", dir], t.rt)).toBe(EXIT.ok);
    for (const file of ["pack.yaml", "schema.yaml", "views.yaml"]) {
      expect(readFileSync(join(dir, file), "utf8")).toBe(readFileSync(new URL(`../templates/pack/${file}`, import.meta.url), "utf8"));
    }
    expect(await run(["pack", "validate", dir], t.rt)).toBe(EXIT.ok);
  });
});
