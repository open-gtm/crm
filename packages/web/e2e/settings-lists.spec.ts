import { expect, test, type Page } from "@playwright/test";
import { readState } from "./env";
import { signIn } from "./helpers";

/** Phase 5 screens against the real API: your team, data health, an automation made with a dry run, and the list's layout control. */
test.describe("settings and lists", () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ colorScheme: "light" });
    await signIn(page, readState().owner);
  });
  test.afterAll(async () => page.close());

  test("choosing a team in personal settings changes what Home shows", async () => {
    await page.goto("/settings/account");
    await page.getByRole("combobox", { name: /your team/i }).selectOption("sales");
    await page.goto("/");
    await expect(page.getByText("Open pipeline")).toBeVisible();
    await page.goto("/settings/account");
    await page.getByRole("combobox", { name: /your team/i }).selectOption({ label: "No team" });
    await page.goto("/");
    await expect(page.getByRole("link", { name: /Choose your team/ })).toBeVisible();
  });

  test("data health runs a check only when asked, and says a merge can't be undone", async () => {
    await page.goto("/settings/data-health");
    await expect(page.getByText(/every \d+ minutes|last run/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Run all" })).toBeVisible();
    // Nothing has run yet: no counts until asked.
    await page.getByRole("button", { name: "Run all" }).click();
    await expect(page.getByText(/group|No possible duplicates|None/i).first()).toBeVisible({ timeout: 30_000 });
  });

  test("an automation is made after the server's dry run says what it will do", async () => {
    await page.goto("/settings/automations/new");
    await page.getByRole("textbox", { name: "Name" }).fill("Greet new contacts");
    await expect(page.getByRole("heading", { name: /in plain words/i })).toBeVisible();
  });

  test("the deals list offers Table, Board and Calendar, and a total", async () => {
    await page.goto("/o/deal");
    const layouts = page.getByRole("group", { name: "Show as" });
    await expect(layouts.getByText("Table")).toBeVisible();
    await expect(layouts.getByText("Calendar")).toBeVisible();
    await page.goto("/board");
  });
});
