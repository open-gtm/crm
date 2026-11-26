import { expect, test, type Page } from "@playwright/test";
import { readState } from "./env";
import { signIn } from "./helpers";

/**
 * The layout editor and the record page against the real API: a person changes the shared draft, an agent
 * changes it too through the admin MCP surface, the person sees that, previews the diff and publishes, and
 * the record page shows the published layout.
 */
test.describe("record page layouts", () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ colorScheme: "light" });
    await signIn(page, readState().owner);
  });
  test.afterAll(async () => page.close());

  test("customize the deal page with an agent, publish it, and see it on a deal", async () => {
    const { ids, adminKey } = readState();
    await page.goto(`/o/deal/${ids.deal}`);
    await page.getByRole("link", { name: "Customize page" }).click();
    await page.waitForURL((u) => u.pathname === "/o/deal/customize");
    await expect(page.getByRole("heading", { name: /Customize the Deal page/ })).toBeVisible();
    await expect(page.getByText(/Just me/)).toHaveCount(0);

    // The person adds the "Changes by agents" component: the draft starts.
    await page.getByRole("button", { name: "Add Changes by agents" }).click();
    await expect(page.getByText(/^Draft · 1 change/)).toBeVisible();

    // An agent changes the same draft through the admin MCP surface, with a note of what it was asked.
    const mcp = { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json", "X-HLCRM-Surface": "admin-mcp" };
    const draft = (await (await page.request.get("/v1/objects/deal/layout/draft", { headers: mcp })).json()).data as { revision: number; layout: { header: { key_facts: string[] | null }; top: unknown[]; columns: Record<string, unknown[]> } };
    const next = { ...draft.layout, header: { key_facts: ["amount", "expected_close_date", "owner"] } };
    const put = await page.request.put("/v1/objects/deal/layout/draft", { headers: mcp, data: { layout: next, revision: draft.revision, note: "Put amount, close date and owner in the header." } });
    expect(put.status()).toBe(200);

    // Coming back to the tab shows the agent's change, with its source, and offers to keep or undo it.
    await page.reload();
    const banner = page.getByRole("status").filter({ hasText: /changed this draft|was changed/ });
    await expect(banner).toContainText("Admin MCP");
    await expect(banner).toContainText("Put amount, close date and owner in the header.");
    await banner.getByRole("button", { name: "Keep" }).click();
    await expect(banner).toHaveCount(0);

    // History names both sources.
    await page.getByRole("tab", { name: "History" }).click();
    const history = page.getByRole("tabpanel", { name: "History" });
    await expect(history).toContainText("Admin MCP");
    await expect(history).toContainText("Web");
    await page.getByRole("tab", { name: "As code" }).click();
    await expect(page.getByRole("tabpanel", { name: "As code" })).toContainText("set_page_layout");
    await expect(page.getByRole("tabpanel", { name: "As code" })).toContainText("/v1/objects/deal/layout/draft");

    // Publishing shows what will change first, then publishes.
    await page.getByRole("button", { name: "Publish to everyone" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Changes by agents");
    await expect(dialog).toContainText("header");
    await dialog.getByRole("button", { name: /^Publish/ }).click();
    await expect(page.getByText(/Published v1/)).toBeVisible();

    // The deal's page now has the component and the header facts in the layout's order.
    await page.goto(`/o/deal/${ids.deal}`);
    await expect(page.getByRole("heading", { name: "Changes by agents" })).toBeVisible();

    // Settings → Schema → Deal points at the editor and says what is published.
    await page.goto("/settings/schema/deal");
    await expect(page.getByText(/Published v1|version 1/i).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Customize page" })).toBeVisible();
  });
});
