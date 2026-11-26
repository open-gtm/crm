import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { afterMerge, chosenFields, defaultSource, defaultSurvivor, mergeRecordsOf } from "@/features/settings/data-health/merge";
import type { DuplicateGroup } from "@/features/settings/data-health/types";
import type { RecordData } from "@/lib/api/types";
import { field, objectMeta, renderRoute, SESSION, type Call } from "./utils";

const owner = field({ name: "owner", type: "relation", relation: { to: "user", cardinality: "many_to_one" } });
const METAS = {
  contact: objectMeta({ name: "contact", label: "Contact", plural_label: "Contacts", owned: true, fields: [
    field({ name: "first_name", type: "text" }), field({ name: "email", type: "email" }), field({ name: "phone", type: "phone" }), owner] }),
  account: objectMeta({ name: "account", label: "Account", plural_label: "Accounts", owned: true, fields: [field({ name: "name", type: "text" }), field({ name: "domain", type: "text" }), owner] }),
  deal: objectMeta({ name: "deal", label: "Deal", plural_label: "Deals", owned: true, fields: [
    field({ name: "name", type: "text" }), field({ name: "status", type: "single_select", read_only: true, values: [{ key: "open", label: "Open" }, { key: "won", label: "Won" }] }),
    field({ name: "expected_close_date", type: "date" }), owner] }),
  lead: objectMeta({ name: "lead", label: "Lead", plural_label: "Leads", owned: true, fields: [field({ name: "status", type: "status", values: [{ key: "new", label: "New" }] }), owner] }),
};

const rec = (id: string, extra: Record<string, unknown>): RecordData => ({ id, object: "contact", display_name: String(extra.first_name ?? id), version: 1, ...extra });
const A = rec("con_A", { first_name: "Ines", email: "ines@acme.example", phone: null, created_at: "2024-03-04T10:00:00Z" });
const B = rec("con_B", { first_name: "Inês", email: "ines@acme.example", phone: "+351 21 555 0142", created_at: "2026-11-19T10:00:00Z" });
const C = rec("con_C", { first_name: "Omar", email: "omar@harbor.example", created_at: "2025-01-01T10:00:00Z" });
const D = rec("con_D", { first_name: "Omar H.", email: "omar@harbor.example", created_at: "2025-02-01T10:00:00Z" });
const GROUPS: DuplicateGroup[] = [
  { reason: { fields: ["email"], match: "normalized" }, count: 2, records: [A, B] },
  { reason: { fields: ["email"], match: "exact" }, count: 2, records: [C, D] },
];

function api(calls: Call[], extra: (c: Call) => { status?: number; body?: unknown } | undefined = () => undefined) {
  return (c: Call) => {
    calls.push(c);
    const o = /^\/v1\/objects\/(contact|account|deal|lead)$/.exec(c.path);
    if (o) return { body: { data: METAS[o[1] as keyof typeof METAS] } };
    return extra(c);
  };
}
const open = async () => {
  await screen.findByRole("button", { name: "Run Possible duplicate contacts" });
};

describe("Settings → Data health", () => {
  it("is shown only to members who can write records", async () => {
    renderRoute("/settings/data-health", () => undefined, { session: { ...SESSION, permissions: ["records:read"] } });
    expect(await screen.findByText(/don't have access to data health/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Data health" })).not.toBeInTheDocument();
  });

  it("runs nothing on load, and says nothing about a schedule or stored results", async () => {
    const calls: Call[] = [];
    renderRoute("/settings/data-health", api(calls));
    await open();
    expect(screen.getAllByText("Not run yet").length).toBeGreaterThan(3);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(document.body.textContent).not.toMatch(/every \d+ minutes|last run|undo/i);
    // Left out for lack of an endpoint: bounced or invalid emails, dismissals, owner tasks, rules.
    expect(screen.queryByText(/invalid email|not duplicates|send owners|edit rules/i)).not.toBeInTheDocument();
  });

  it("runs a duplicates check on demand and reports the groups, a full scan window and more groups", async () => {
    const calls: Call[] = [];
    renderRoute("/settings/data-health", api(calls, (c) => (c.path === "/v1/objects/contact/duplicates"
      ? { body: { object: "contact", scanned: 10000, window_full: true, groups: GROUPS, more_groups: true } } : undefined)));
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Run Possible duplicate contacts" }));
    expect(await screen.findByText("2 groups of possible duplicates found.")).toBeInTheDocument();
    expect(screen.getByText(/more groups than this/i)).toBeInTheDocument();
    expect(screen.getByText(/scan window was full: only the newest 10,000 contacts/i)).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith("/duplicates")).map((c) => c.path)).toEqual(["/v1/objects/contact/duplicates"]);
    expect(document.querySelector("time")).not.toBeNull();
  });

  it("counts open deals without a close date through a query with the same filter the list is opened with", async () => {
    const calls: Call[] = [];
    renderRoute("/settings/data-health", api(calls, (c) => (c.path === "/v1/query" ? { body: { data: [], next_cursor: null, total: 10000, total_capped: true } } : undefined)));
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Run Open deals without an expected close date" }));
    expect(await screen.findByText("More than 10,000")).toBeInTheDocument();
    const q = calls.find((c) => c.path === "/v1/query")!.body as { object: string; where: unknown; count: boolean; limit: number };
    expect(q).toMatchObject({ object: "deal", count: true, limit: 1, where: { and: [{ field: "status", op: "eq", value: "open" }, { field: "expected_close_date", op: "is_null", value: true }] } });
    const link = screen.getByRole("link", { name: "Show in list" });
    expect(link.getAttribute("href")).toMatch(/^\/o\/deal\?filter=/);
    expect(JSON.parse(new URL(link.getAttribute("href")!, "http://x").searchParams.get("filter")!)).toEqual({ o: "and", c: [["status", "eq", "open"], ["expected_close_date", "empty"]] });
  });

  it("counts records without an owner per object, and contacts without an email", async () => {
    const calls: Call[] = [];
    renderRoute("/settings/data-health", api(calls, (c) => {
      if (c.path !== "/v1/query") return undefined;
      const b = c.body as { object: string };
      return { body: { data: [], next_cursor: null, total: b.object === "contact" ? 3 : 0 } };
    }));
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Run Records without an owner" }));
    const item = (await screen.findByRole("heading", { name: "Records without an owner" })).closest("li")!;
    await waitFor(() => expect(within(item).getByText("Contacts")).toBeInTheDocument());
    expect(within(item).getAllByText("none found")).toHaveLength(3);
    expect(calls.filter((c) => c.path === "/v1/query").map((c) => (c.body as { object: string }).object)).toEqual(["contact", "account", "deal", "lead"]);
    expect((calls.find((c) => c.path === "/v1/query")!.body as { where: unknown }).where).toEqual({ field: "owner", op: "is_null", value: true });
    await userEvent.click(screen.getByRole("button", { name: "Run Contacts without an email" }));
    await waitFor(() => expect(calls.some((c) => JSON.stringify((c.body as { where?: unknown } | undefined)?.where) === JSON.stringify({ field: "email", op: "is_null", value: true }))).toBe(true));
  });

  it("drops a check whose field isn't there", async () => {
    const noClose = { ...METAS.deal, fields: METAS.deal.fields.filter((f) => f.name !== "expected_close_date") };
    renderRoute("/settings/data-health", (c) => (c.path === "/v1/objects/deal" ? { body: { data: noClose } } : api([])(c)));
    await open();
    expect(screen.queryByRole("heading", { name: "Open deals without an expected close date" })).not.toBeInTheDocument();
  });

  it("reviews groups one at a time, previews a merge with the chosen fields, and merges with the preview's token", async () => {
    const calls: Call[] = [];
    renderRoute("/settings/data-health", api(calls, (c) => {
      if (c.path === "/v1/objects/contact/duplicates") return { body: { object: "contact", scanned: 4, window_full: false, groups: GROUPS, more_groups: false } };
      if (c.path === "/v1/ops/merge_records") {
        const b = c.body as { dry_run: boolean };
        return { body: { dry_run: b.dry_run, survivor: { ...A, first_name: "Inês", phone: "+351 21 555 0142", version: 2 }, merged: ["con_B"],
          changes: [{ field: "first_name", before: "Ines", after: "Inês", from: "con_B" }, { field: "phone", before: null, after: "+351 21 555 0142", from: "con_B" }],
          references: [{ object: "deal", field: "primary_contact", moved: 2, archived: 0, dropped: 0, cleared: 0 }],
          ...(b.dry_run ? { confirm_token: "tok_1" } : {}) } };
      }
      return undefined;
    }));
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Run Possible duplicate contacts" }));
    await userEvent.click(await screen.findByRole("button", { name: "Review 2 groups" }));
    expect(await screen.findByText("Group 1 of 2")).toBeInTheDocument();
    // The oldest record starts as the survivor, and its values are the defaults; the blank phone is filled from B.
    expect(screen.getByRole("radio", { name: "Record A survives" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "first name: keep the value from Record A" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "phone: keep the value from Record B" })).toBeChecked();
    expect(screen.getByRole("button", { name: /^Merge$/ })).toBeDisabled();
    expect(screen.getByText(/A merge can't be undone/)).toBeInTheDocument();

    // Skip goes to the next group and stores nothing.
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(await screen.findByText("Group 2 of 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(await screen.findByText("Group 1 of 2")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/v1/ops/merge_records")).toEqual([]);

    await userEvent.click(screen.getByRole("radio", { name: "first name: keep the value from Record B" }));
    await userEvent.click(screen.getByRole("button", { name: "Preview merge" }));
    expect(await screen.findByText("What this merge will do")).toBeInTheDocument();
    const dry = calls.find((c) => c.path === "/v1/ops/merge_records")!;
    expect(dry.body).toEqual({ survivor: "con_A", duplicates: ["con_B"], fields: { first_name: "con_B" }, dry_run: true });
    expect(screen.getByText(/primary contact, 2 moved/)).toBeInTheDocument();

    // A changed choice puts the preview out of date: the token no longer fits.
    await userEvent.click(screen.getByRole("radio", { name: "first name: keep the value from Record A" }));
    expect(screen.queryByText("What this merge will do")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Merge$/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: "first name: keep the value from Record B" }));
    await userEvent.click(screen.getByRole("button", { name: "Preview merge" }));
    await screen.findByText("What this merge will do");

    await userEvent.click(screen.getByRole("button", { name: /^Merge$/ }));
    expect(await screen.findByText("Group 1 of 1")).toBeInTheDocument();
    const real = calls.filter((c) => c.path === "/v1/ops/merge_records").at(-1)!;
    expect(real.body).toEqual({ survivor: "con_A", duplicates: ["con_B"], fields: { first_name: "con_B" }, dry_run: false, confirm_token: "tok_1" });
    expect(screen.getByText("1 group of possible duplicates found.")).toBeInTheDocument();
  });
});

describe("merge choices", () => {
  const fields = METAS.contact.fields;
  const phone = fields.find((f) => f.name === "phone")!;
  const first = fields.find((f) => f.name === "first_name")!;

  it("start from the oldest record and fill blanks the way the server does", () => {
    expect(defaultSurvivor([B, A])).toBe("con_A");
    expect(defaultSource(phone, A, [B])).toBe("con_B");
    expect(defaultSource(first, A, [B])).toBe("con_A");
    expect(defaultSource(phone, A, [rec("con_X", { phone: "[restricted]" })].map((r) => ({ ...r, phone: "" })))).toBe("con_A");
  });

  it("send only the fields where the choice differs from the default", () => {
    expect(chosenFields(fields, A, [B], {})).toEqual({});
    expect(chosenFields(fields, A, [B], { first_name: "con_B", phone: "con_B" })).toEqual({ first_name: "con_B" });
    expect(chosenFields(fields, A, [B], { phone: "con_A" })).toEqual({ phone: "con_A" });
  });

  it("take at most 11 records, and drop merged records and finished groups afterwards", () => {
    const many = Array.from({ length: 14 }, (_, i) => rec(`con_${i}`, {}));
    expect(mergeRecordsOf({ reason: { fields: ["email"], match: "exact" }, count: 14, records: many })).toHaveLength(11);
    const left = afterMerge(GROUPS, { ...A, version: 2 }, ["con_B"]);
    expect(left.map((g) => g.records.map((r) => r.id))).toEqual([["con_C", "con_D"]]);
  });
});
