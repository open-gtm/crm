import { expect, test, type Page } from "@playwright/test";
import { readState } from "./env";
import { signIn } from "./helpers";

/** Settings → Objects & fields against the real API: add a field with a dry run first, and see where it came from. */
test.describe("objects and fields", () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ colorScheme: "light" });
    await signIn(page, readState().owner);
  });
  test.afterAll(async () => page.close());

  test("add a field to contacts after seeing the server's diff, then find it with its source", async () => {
    await page.goto("/settings/schema/contact");
    await expect(page.getByRole("heading", { name: "Contact" }).first()).toBeVisible();
    await page.getByRole("button", { name: /add field/i }).click();
    await page.getByRole("textbox", { name: "Label" }).fill("Favourite colour");
    await page.getByRole("button", { name: /preview|review|check/i }).click();
    // Nothing is written yet: the server's dry run says what would change.
    await expect(page.getByText(/favourite_colour/).first()).toBeVisible();
    await page.getByRole("button", { name: /^apply/i }).click();
    const row = page.getByRole("row").filter({ hasText: "favourite_colour" });
    await expect(row).toContainText("Custom");
    await expect(row).toContainText("Web");
    await page.getByRole("tab", { name: "Changes" }).click();
    await expect(page.getByRole("tabpanel", { name: "Changes" })).toContainText("favourite_colour");
  });
});
