import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { navObjects } from "@/meta/hooks";
import { field, objectMeta, renderRoute, type Call } from "./utils";

const STATUS = [
  { key: "draft", label: "Draft", category: "draft" }, { key: "sent", label: "Sent", category: "sent" }, { key: "accepted", label: "Accepted", category: "accepted" },
  { key: "rejected", label: "Rejected", category: "rejected" },
];
const quoteMeta = objectMeta({ name: "quote", label: "Quote", plural_label: "Quotes", standard: true, fields: [
  field({ name: "name", type: "text" }), field({ name: "number", type: "text", read_only: true }),
  field({ name: "status", type: "status", values: STATUS }), field({ name: "total", type: "currency", read_only: true }),
] });
const OBJECTS = [{ name: "quote", label: "Quote", plural_label: "Quotes", standard: true, access: { read: true, write: true, archive: true } }];
const quote = (status: string) => ({ id: "quote_1", object: "quote", version: 2, display_name: "Fleet renewal", name: "Fleet renewal", number: "Q-0007", status, total: 1200 });

function page(status: string, meta = quoteMeta) {
  let current = status;
  return renderRoute("/o/quote/quote_1", (c: Call) => {
    if (c.method === "GET" && c.path === "/v1/objects/quote") return { body: { data: meta } };
    if (c.method === "GET" && c.path === "/v1/objects/quote/records/quote_1") return { body: { data: quote(current) } };
    if (c.method === "POST" && c.path === "/v1/ops/send_quote") {
      current = "sent";
      return { body: { dry_run: false, result: quote("sent") } };
    }
    if (c.method === "POST" && c.path === "/v1/ops/accept_quote") {
      current = "accepted";
      return { body: { dry_run: false, result: { quote: quote("accepted"), order: { id: "ord_1", object: "order", number: "O-0003" } } } };
    }
    if (c.method === "POST" && c.path === "/v1/ops/revise_quote") return { body: { dry_run: false, result: { ...quote("draft"), id: "quote_2", number: "Q-0007-2" } } };
    if (c.path === "/v1/records/quote_1/files") return { body: { data: [] } };
    if (c.path === "/v1/records/quote_1/timeline") return { body: { data: { items: [] } } };
    return undefined;
  }, { objects: OBJECTS });
}

describe("a quote's page", () => {
  it("sends a draft through send_quote, after saying it can't be changed afterwards", async () => {
    const { calls } = page("draft");
    await userEvent.click(await screen.findByRole("button", { name: "Send quote" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Send Q-0007?" });
    expect(confirm).toHaveTextContent("can't be changed");
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole("button", { name: "Send quote" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/ops/send_quote")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/ops/send_quote")!.body).toEqual({ quote: "quote_1" });
    // Now sent: it can be accepted or revised, not sent again.
    expect(await screen.findByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revise" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send quote" })).not.toBeInTheDocument();
  });

  it("accepts a sent quote through accept_quote and opens the order it made", async () => {
    const { calls, router } = page("sent");
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Accept Q-0007?" });
    expect(confirm).toHaveTextContent("can't be undone");
    await userEvent.click(within(confirm).getByRole("button", { name: "Accept and make the order" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/ops/accept_quote")).toBe(true));
    await waitFor(() => expect(router.state.location.pathname).toBe("/o/order/ord_1"));
  });

  it("revises a sent quote into a new draft and opens it; an accepted quote offers nothing; neither does a read-only status", async () => {
    const first = page("sent");
    await userEvent.click(await screen.findByRole("button", { name: "Revise" }));
    await waitFor(() => expect(first.router.state.location.pathname).toBe("/o/quote/quote_2"));
    first.unmount();

    const accepted = page("accepted");
    expect(await screen.findByRole("heading", { level: 1, name: "Fleet renewal" })).toBeInTheDocument();
    for (const name of ["Send quote", "Accept", "Revise"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    accepted.unmount();

    page("draft", { ...quoteMeta, fields: quoteMeta.fields.map((f) => (f.name === "status" ? { ...f, access: "read" as const } : f)) });
    expect(await screen.findByRole("heading", { level: 1, name: "Fleet renewal" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send quote" })).not.toBeInTheDocument();
  });

  it("quotes and orders sit after deals in the navigation, and their lines are not starting points", () => {
    const o = (name: string) => ({ name, label: name, plural_label: name, standard: true, access: { read: true, write: true, archive: true } });
    const nav = navObjects(["order", "task", "quote", "contact", "deal"].map(o) as never).standard.map((x) => x.name);
    expect(nav).toEqual(["contact", "deal", "quote", "order", "task"]);
  });
});

describe("Settings → Quotes and orders", () => {
  it("shows how quotes behave and changes one setting at a time, for someone who manages the schema", async () => {
    let settings = { quote_requires_deal: true, accept_quote_marks_deal_won: true };
    const admin = { ...(await import("./utils")).SESSION, permissions: ["records:read", "schema:manage"] };
    const { calls, unmount } = renderRoute("/settings/commerce", (c: Call) => {
      if (c.method === "GET" && c.path === "/v1/commerce-settings") return { body: { data: settings } };
      if (c.method === "PATCH" && c.path === "/v1/commerce-settings") {
        settings = { ...settings, ...(c.body as object) };
        return { body: { data: settings } };
      }
      return undefined;
    }, { session: admin });
    const needsDeal = await screen.findByRole("switch", { name: "Quotes are made for a deal" });
    expect(needsDeal).toBeChecked();
    expect(screen.getByText(/takes its account, contact and name from it/)).toBeInTheDocument();
    await userEvent.click(needsDeal);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ quote_requires_deal: false });
    expect(await screen.findByText(/can also stand alone/)).toBeInTheDocument();
    unmount();

    renderRoute("/settings/commerce", (c: Call) => (c.path === "/v1/commerce-settings" ? { body: { data: settings } } : undefined));
    expect(await screen.findByRole("switch", { name: "Accepting a quote marks its deal won" })).toBeDisabled();
    expect(screen.getByText(/needs permission to manage the schema/)).toBeInTheDocument();
  });
});
