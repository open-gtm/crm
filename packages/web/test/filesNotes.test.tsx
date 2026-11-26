import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Files } from "@/features/record/Files";
import { Notes } from "@/features/record/Notes";
import type { FileInfo } from "@/lib/api/types";
import { formatBytes } from "@/lib/format";
import { Markdown, parseMarkdown } from "@/lib/markdown";
import { field, objectMeta, renderApp, type Call } from "./utils";

const file = (id: string, name: string, size = 2048): FileInfo => ({
  id, record: "deal_1", name, size, content_type: "application/pdf", sha256: "0".repeat(64), scan_status: "unscanned", uploaded_by: "usr_ME",
  created_at: new Date(Date.now() - 60_000).toISOString(),
});
const LIMITS = { max_bytes: 10 * 1024 * 1024, quota_bytes: 1024 * 1024 * 1024, max_files_per_record: 100 };

describe("Markdown", () => {
  it("formats what notes use, as elements", () => {
    const { container } = render(<Markdown source={"## Next steps\n\nCall **Ana** about the *pilot*, see [the plan](https://example.com/plan).\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n```\ncode <b>here</b>\n```\n`inline`"} />);
    expect(screen.getByRole("heading", { name: "Next steps" })).toBeInTheDocument();
    expect(container.querySelector("strong")).toHaveTextContent("Ana");
    expect(container.querySelector("em")).toHaveTextContent("pilot");
    const link = screen.getByRole("link", { name: "the plan" });
    expect(link).toHaveAttribute("href", "https://example.com/plan");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelector("blockquote")).toHaveTextContent("quoted");
    expect(container.querySelector("pre")).toHaveTextContent("code <b>here</b>");
    expect(container.querySelector("code.font-mono")).toBeInTheDocument();
  });

  it("never turns a note's text into markup or an unsafe link", () => {
    const { container } = render(<Markdown source={'<img src=x onerror="alert(1)"> <script>alert(2)</script>\n\n[click](javascript:alert(3)) and [data](data:text/html,x) and https://ok.example/a.'} />);
    expect(container.querySelector("img, script")).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror="alert(1)">');
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["https://ok.example/a"]);
    expect(container).toHaveTextContent("[click](javascript:alert(3))");
  });

  it("splits a note into blocks", () => {
    expect(parseMarkdown("# A\ntext\nmore\n\n- x\n- y\nafter").map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "paragraph"]);
    expect(parseMarkdown("")).toEqual([]);
  });
});

describe("a record's files", () => {
  it("lists them as downloads, attaches with the file's bytes and name, and removes after confirming", async () => {
    let files = [file("file_1", "Contract.pdf")];
    const { calls } = renderApp(<Files recordId="deal_1" canWrite />, (c: Call) => {
      if (c.path === "/v1/files/limits") return { body: { data: LIMITS } };
      if (c.method === "GET" && c.path === "/v1/records/deal_1/files") return { body: { data: files } };
      if (c.method === "POST" && c.path === "/v1/records/deal_1/files") {
        files = [...files, file("file_2", c.query.get("name")!)];
        return { status: 201, body: { data: files[1] } };
      }
      if (c.method === "DELETE" && c.path === "/v1/files/file_1") {
        files = files.filter((f) => f.id !== "file_1");
        return { body: { data: { id: "file_1", deleted: true } } };
      }
      return undefined;
    });
    const region = await screen.findByRole("region", { name: "Files" });
    const link = await within(region).findByRole("link", { name: "Contract.pdf" });
    // A download, never opened in the page.
    expect(link).toHaveAttribute("href", "/v1/files/file_1/content");
    expect(link).toHaveAttribute("download", "Contract.pdf");
    expect(within(region).getByText(/2 KB/)).toBeInTheDocument();

    await userEvent.upload(within(region).getByLabelText("Attach files to files"), new File(["hello"], "notes from call.txt", { type: "text/plain" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/records/deal_1/files")).toBe(true));
    const sent = calls.find((c) => c.method === "POST" && c.path === "/v1/records/deal_1/files")!;
    expect(sent.query.get("name")).toBe("notes from call.txt");
    expect(sent.headers["content-type"]).toBe("application/octet-stream");
    expect(sent.headers["idempotency-key"]).toBeTruthy();
    expect(await within(region).findByRole("link", { name: "notes from call.txt" })).toBeInTheDocument();

    await userEvent.click(within(region).getByRole("button", { name: "Remove Contract.pdf" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove file" }));
    await waitFor(() => expect(within(region).queryByRole("link", { name: "Contract.pdf" })).not.toBeInTheDocument());
  });

  it("refuses a file past the limit before sending it, and offers nothing to change without write access", async () => {
    const { calls, unmount } = renderApp(<Files recordId="deal_1" canWrite />, (c: Call) => {
      if (c.path === "/v1/files/limits") return { body: { data: { ...LIMITS, max_bytes: 4 } } };
      if (c.path === "/v1/records/deal_1/files") return { body: { data: [] } };
      return undefined;
    });
    const region = await screen.findByRole("region", { name: "Files" });
    await within(region).findByText("No files yet.");
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/files/limits")).toBe(true));
    await userEvent.upload(within(region).getByLabelText("Attach files to files"), new File(["too large"], "big.bin"));
    expect(await within(region).findByRole("alert")).toHaveTextContent("big.bin is larger than 4 B");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    unmount();

    renderApp(<Files recordId="deal_1" canWrite={false} />, (c: Call) => {
      if (c.path === "/v1/files/limits") return { body: { data: LIMITS } };
      if (c.path === "/v1/records/deal_1/files") return { body: { data: [file("file_1", "Contract.pdf")] } };
      return undefined;
    });
    const readOnly = await screen.findByRole("region", { name: "Files" });
    expect(await within(readOnly).findByRole("link", { name: "Contract.pdf" })).toBeInTheDocument();
    expect(within(readOnly).queryByRole("button", { name: /attach/i })).not.toBeInTheDocument();
    expect(within(readOnly).queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
  });

  it("formats sizes", () => {
    expect([0, 512, 2048, 3_500_000, 1024 ** 3].map(formatBytes)).toEqual(["0 B", "512 B", "2 KB", "3.3 MB", "1 GB"]);
  });
});

describe("a record's notes", () => {
  const activity = objectMeta({ name: "activity", label: "Activity", plural_label: "Activities", fields: [
    field({ name: "type", type: "single_select" }), field({ name: "subject", type: "text" }), field({ name: "body", type: "long_text" }),
  ] });
  const OBJECTS = [{ name: "activity", label: "Activity", plural_label: "Activities", access: { read: true, write: true, archive: true } }];
  const note = { id: "act_1", object: "activity", version: 3, type: "note", subject: "Kickoff", body: "## Agenda\n\n- **budget**\n- timeline",
    occurred_at: new Date(Date.now() - 3_600_000).toISOString() };

  function handler(extra: (c: Call) => { status?: number; body?: unknown } | undefined = () => undefined) {
    return (c: Call) => extra(c) ?? (
      c.path === "/v1/objects" ? { body: { data: OBJECTS } }
        : c.path === "/v1/objects/activity" ? { body: { data: activity } }
        : c.path === "/v1/records/deal_1/timeline" ? { body: { data: { items: [
          { kind: "activity", at: note.occurred_at, item: note },
          { kind: "activity", at: note.occurred_at, item: { id: "act_2", object: "activity", version: 1, type: "call_logged", subject: "Called", body: "not a note" } },
        ] } } }
        : c.path === "/v1/files/limits" ? { body: { data: LIMITS } }
        : /^\/v1\/records\/act_\d\/files$/.test(c.path) ? { body: { data: [] } }
        : undefined);
  }

  it("shows the notes formatted, and only the notes", async () => {
    renderApp(<Notes recordId="deal_1" />, handler());
    const region = await screen.findByRole("region", { name: "Notes" });
    expect(await within(region).findByRole("heading", { name: "Kickoff" })).toBeInTheDocument();
    expect(within(region).getByRole("heading", { name: "Agenda" })).toBeInTheDocument();
    expect(region.querySelector("strong")).toHaveTextContent("budget");
    expect(within(region).queryByText("not a note")).not.toBeInTheDocument();
    // Each note can carry files.
    expect(await within(region).findByRole("button", { name: "Attach" })).toBeInTheDocument();
  });

  it("writes a new note with the toolbar and a preview, as a note activity on the record", async () => {
    const { calls } = renderApp(<Notes recordId="deal_1" />, handler((c) =>
      (c.method === "POST" && c.path === "/v1/ops/log_activity" ? { status: 201, body: { result: { ...note, id: "act_9" } } } : undefined)));
    await userEvent.click(await screen.findByRole("button", { name: "New note" }));
    const dialog = await screen.findByRole("dialog", { name: "New note" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Title" }), "Pricing call");
    const area = within(dialog).getByRole("textbox", { name: "Note" });
    await userEvent.type(area, "They want");
    await userEvent.click(within(dialog).getByRole("button", { name: "Bold" }));
    expect(area).toHaveValue("They want**text**");
    await userEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect(within(dialog).getByRole("region", { name: "Preview" }).querySelector("strong")).toHaveTextContent("text");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/ops/log_activity")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/ops/log_activity")!.body).toEqual({ type: "note", related_to: ["deal_1"], subject: "Pricing call", body: "They want**text**" });
  });

  it("edits a note in place with its version, and shows nothing to someone who can't read activities", async () => {
    const { calls, unmount } = renderApp(<Notes recordId="deal_1" />, handler((c) =>
      (c.method === "PATCH" && c.path === "/v1/objects/activity/records/act_1" ? { body: { data: { ...note, version: 4 } } } : undefined)));
    await userEvent.click(await screen.findByRole("button", { name: "Edit note Kickoff" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit note" });
    const area = within(dialog).getByRole("textbox", { name: "Note" });
    expect(area).toHaveValue(note.body);
    await userEvent.type(area, "\n- owner");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const sent = calls.find((c) => c.method === "PATCH")!;
    expect(sent.body).toEqual({ subject: "Kickoff", body: `${note.body}\n- owner` });
    expect(sent.headers["if-match"]).toBe('"v3"');
    unmount();

    renderApp(<Notes recordId="deal_1" />, (c: Call) => (c.path === "/v1/objects" ? { body: { data: [{ ...OBJECTS[0], access: { read: false, write: false, archive: false } }] } } : undefined));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Notes" })).not.toBeInTheDocument());
  });
});
