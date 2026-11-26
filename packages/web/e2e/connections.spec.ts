import { expect, test, type Page } from "@playwright/test";
import { readState } from "./env";
import { signIn } from "./helpers";

/** Settings → Connections against the real API: create from a preset, see it stored without its secret, change it, archive it. */
test.describe("connections", () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ colorScheme: "light" });
    await signIn(page, readState().owner);
  });
  test.afterAll(async () => page.close());

  test("create a HubSpot connection, change it and archive it", async () => {
    const token = "pat-na1-e2e-secret-token-0001";
    await page.goto("/settings/connections");
    await expect(page.getByText("No connections yet.")).toBeVisible();
    await page.getByRole("button", { name: /new connection/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "Set up for" }).selectOption("hubspot");
    await expect(dialog.getByRole("textbox", { name: "Base URL" })).toHaveValue("https://api.hubapi.com");
    await dialog.getByLabel(/^Token/).fill(token);
    await dialog.getByRole("button", { name: "Create connection" }).click();

    // The detail page: what is stored, never the token.
    await page.waitForURL((u) => u.pathname.startsWith("/settings/connections/conn_"));
    await expect(page.getByRole("heading", { name: "HubSpot" })).toBeVisible();
    await expect(page.getByText("https://api.hubapi.com")).toBeVisible();
    await expect(page.getByText(/Not shown\./)).toBeVisible();
    await expect(page.getByText("No automation uses it yet.")).toBeVisible();
    expect(await page.content()).not.toContain(token);

    // A new name needs no secret; the key can't be changed.
    await page.getByRole("button", { name: "Change…" }).click();
    const edit = page.getByRole("dialog");
    await expect(edit.getByRole("textbox", { name: "Key" })).toBeDisabled();
    await edit.getByRole("textbox", { name: "Name" }).fill("HubSpot (marketing)");
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name: "HubSpot (marketing)" })).toBeVisible();

    await page.goto("/settings/connections");
    await expect(page.getByRole("link", { name: /HubSpot \(marketing\)/ })).toBeVisible();
    await page.getByRole("link", { name: /HubSpot \(marketing\)/ }).click();
    await page.getByRole("button", { name: "Archive…" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Archive connection" }).click();
    await page.waitForURL((u) => u.pathname === "/settings/connections");
    await expect(page.getByText("No connections yet.")).toBeVisible();
  });
});
