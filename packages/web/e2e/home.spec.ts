import { expect, test, type Page } from "@playwright/test";
import { readState } from "./env";
import { signIn } from "./helpers";

/** Home by team against the real API: the numbers come from the member's own records, and the admin Home from the summaries. */
test.describe("home by team", () => {
  let page: Page;
  const setTeam = async (team: string | null) => {
    const { adminKey } = readState();
    const r = await page.request.put("/v1/me/preferences", { headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" }, data: { "home.team": team } });
    expect(r.status()).toBe(200);
  };
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ colorScheme: "light" });
    await signIn(page, readState().owner);
  });
  test.afterAll(async () => {
    await setTeam(null);
    await page.close();
  });

  test("sales shows the member's pipeline, and admin shows runs, changes and agent activity", async () => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /Choose your team/ })).toBeVisible();

    await setTeam("sales");
    await page.goto("/");
    await expect(page.getByText("Open pipeline")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your open deals" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your agents" })).toBeVisible();
    await expect(page.getByText(/mention/i)).toHaveCount(0);

    await setTeam("admin");
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Needs attention/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Automation runs/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Agent and API activity/ })).toBeVisible();
    await expect(page.getByText(/every \d+ minutes/)).toHaveCount(0);
  });
});
