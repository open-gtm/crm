import { expect, test, type Page } from "@playwright/test";
import { readState } from "./env";
import { shot, signIn, watchErrors } from "./helpers";

/**
 * The main flows against the real API, in a real browser, as the workspace owner and as a member whose
 * role hides and freezes fields. Screenshots of the main screens, in both themes, go to docs/screenshots
 * when asked for (`pnpm screenshots`).
 */

/** Accessibility checks for what the app's own review found (axe-core itself is MPL-2.0, so it isn't used; see README). */
async function a11yChecks(page: Page, where: string) {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const interactive = "a[href], button, input, select, textarea, [role=button], [role=link], [role=checkbox], [role=menuitem], [tabindex]:not([tabindex='-1'])";
    // Nested interactive controls: a control inside another.
    for (const el of document.querySelectorAll<HTMLElement>("[role=button], button, a[href]")) {
      if (el.querySelector(interactive)) out.push(`nested interactive: ${el.outerHTML.slice(0, 120)}`);
    }
    // Table headers need a name.
    for (const th of document.querySelectorAll("th")) if (!th.textContent?.trim() && !th.querySelector("[aria-label]")) out.push(`empty table header in ${th.closest("table")?.getAttribute("aria-label")}`);
    // Scrollable regions must be reachable from the keyboard.
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const cs = getComputedStyle(el);
      const scrolls = (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) || (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1);
      if (!scrolls) continue;
      const focusable = el.tabIndex >= 0 || el.querySelector(interactive) !== null;
      if (!focusable) out.push(`scrollable region not focusable: ${el.className.slice(0, 80)}`);
    }
    // One main landmark and a top-level heading.
    if (document.querySelectorAll("main, [role=main]").length !== 1) out.push(`main landmarks: ${document.querySelectorAll("main, [role=main]").length}`);
    if (!document.querySelector("h1")) out.push("no h1");
    // Buttons and links need names.
    for (const el of document.querySelectorAll<HTMLElement>("button, a[href]")) {
      const name = el.getAttribute("aria-label") ?? el.textContent ?? "";
      if (!name.trim() && !el.getAttribute("aria-labelledby") && !el.querySelector("img[alt]:not([alt=''])")) out.push(`unnamed control: ${el.outerHTML.slice(0, 120)}`);
      // A visible label must be part of the accessible name (label-content-name-mismatch).
      const label = el.getAttribute("aria-label");
      const visible = (el.innerText ?? "").trim().split("\n")[0]!.trim();
      if (label && visible.length > 2 && !label.toLowerCase().includes(visible.toLowerCase())) out.push(`name doesn't contain visible text "${visible}": "${label}"`);
    }
    return out;
  });
  expect(problems, where).toEqual([]);
}

test.describe.configure({ mode: "serial" });

test.describe("as the owner", () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ colorScheme: "light" });
    watchErrors(page);
    await signIn(page, readState().owner);
  });
  test.afterAll(async () => page.close());

  test("home", async () => {
    await expect(page.getByRole("region", { name: /needs attention/i })).toBeVisible();
    await expect(page.getByRole("link", { name: "Send the pilot proposal" })).toBeVisible();
    await shot(page, "home-light");
  });

  test("list contacts, filter and sort", async () => {
    await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Contacts" }).click();
    await expect(page.getByText("300 contacts")).toBeVisible();
    await page.getByRole("button", { name: "Filter" }).click();
    await page.getByRole("button", { name: /add condition/i }).click();
    await page.getByRole("combobox", { name: "Condition 1 field" }).selectOption("job_title");
    await page.getByRole("combobox", { name: "Condition 1 operator" }).selectOption("eq");
    await page.getByRole("textbox", { name: "Condition 1 value" }).fill("CEO");
    await page.keyboard.press("Escape");
    await expect(page.getByText("60 contacts match")).toBeVisible();
    expect(new URL(page.url()).searchParams.get("filter")).toContain("job_title");
    await page.getByRole("button", { name: /^last name/i }).click();
    await expect(page.getByRole("columnheader", { name: /last name/i })).toHaveAttribute("aria-sort", "ascending");
    expect(new URL(page.url()).searchParams.get("sort")).toBe("last_name");
    await shot(page, "list-light");
  });

  test("save a view, and find it again after a reload", async () => {
    await page.getByRole("button", { name: /^View: All contacts/ }).click();
    await page.getByRole("menuitem", { name: /save as a new view/i }).click();
    await page.getByRole("textbox", { name: "Name" }).fill("CEOs by surname");
    const remembered = page.waitForResponse((r) => r.url().endsWith("/v1/me/preferences") && r.request().method() === "PUT");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: /^View: CEOs by surname/ })).toBeVisible();
    await remembered;
    await page.goto("/o/contact");
    await expect(page.getByRole("button", { name: /^View: CEOs by surname/ })).toBeVisible();
    await expect(page.getByText("60 contacts match")).toBeVisible();
  });

  test("open a record and edit a field in place", async () => {
    await page.getByRole("grid").getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const row = page.getByRole("region", { name: "Details" });
    await row.getByRole("button", { name: "Edit Job title" }).click();
    await row.getByRole("textbox").fill("Chief Executive");
    await row.getByRole("button", { name: "Save" }).click();
    await expect(row.getByText("Chief Executive")).toBeVisible();
    // A key fact shows once (in the header, editable there), not again under Details.
    await expect(page.getByText("Lifecycle stage", { exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Edit Lifecycle stage" })).toHaveCount(1);
    // Activities and tasks are on the timeline, not in a related list that could disagree with it.
    await expect(page.getByRole("region", { name: /^Activities/ })).toHaveCount(0);
    await expect(page.getByRole("region", { name: /^Tasks/ })).toHaveCount(0);
    await shot(page, "record-light");
  });

  test("create a record with a relation", async () => {
    await page.goto("/o/project");
    await page.getByRole("button", { name: "New project" }).click();
    const dialog = page.getByRole("dialog", { name: "New project" });
    await dialog.getByRole("textbox", { name: /title/i }).fill("Inventory audit");
    await dialog.getByRole("button", { name: "client" }).click();
    await page.getByRole("option", { name: /Cobalt Freight/ }).click();
    await dialog.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Inventory audit" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Cobalt Freight" }).first()).toBeVisible();
  });

  test("the newer field types: list, filter, sort, create and edit (address, json, rating, percent, duration)", async () => {
    await page.goto("/o/site");
    await expect(page.getByText("3 sites")).toBeVisible();
    const grid = page.getByRole("grid");
    // Shown as people read them: an address on one line, stars, a percentage, a duration.
    await expect(grid.getByText("500 Congress Ave, Austin, TX 78701, United States")).toBeVisible();
    await expect(grid.getByRole("img", { name: "4 out of 5" })).toBeVisible();
    await expect(grid.getByText("12.5%")).toBeVisible();
    await expect(grid.getByText("1h 30m")).toBeVisible();
    await expect(grid.getByText("30m", { exact: true })).toBeVisible();
    // JSON isn't a default column; a whole address and JSON don't sort (their headers aren't sort buttons).
    await expect(page.getByRole("columnheader", { name: /settings/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^headquarters/i })).toHaveCount(0);

    // Sort by a duration, then by an address part.
    await page.getByRole("button", { name: /^call length/i }).click();
    await expect(page.getByRole("columnheader", { name: /call length/i })).toHaveAttribute("aria-sort", "ascending");
    expect(new URL(page.url()).searchParams.get("sort")).toBe("call_length");
    await expect(grid.getByRole("row").nth(1).getByRole("link").first()).toHaveText("Berlin office");
    await page.goto("/o/site?sort=-hq.city");
    await expect(grid.getByRole("row").nth(1).getByRole("link").first()).toHaveText("Paris office");
    await page.goto("/o/site?sort=-discount");
    await expect(grid.getByRole("row").nth(1).getByRole("link").first()).toHaveText("Berlin office");

    // Filter: a rating as a number, an address's country part from the ISO list, an address part as text.
    await page.goto("/o/site");
    await page.getByRole("button", { name: "Filter" }).click();
    await page.getByRole("button", { name: /add condition/i }).click();
    await page.getByRole("combobox", { name: "Condition 1 field" }).selectOption("fit");
    await page.getByRole("combobox", { name: "Condition 1 operator" }).selectOption("gte");
    await page.getByRole("textbox", { name: "Condition 1 value" }).fill("4");
    await expect(page.getByText("2 sites match")).toBeVisible();
    await page.getByRole("combobox", { name: "Condition 1 field" }).selectOption("hq.country");
    await page.getByRole("combobox", { name: "Condition 1 operator" }).selectOption("eq");
    await page.getByRole("combobox", { name: "Condition 1 value" }).selectOption("DE");
    await expect(page.getByText("1 site match")).toBeVisible();
    await page.getByRole("combobox", { name: "Condition 1 field" }).selectOption("hq.city");
    await page.getByRole("combobox", { name: "Condition 1 operator" }).selectOption("starts_with");
    await page.getByRole("textbox", { name: "Condition 1 value" }).fill("Par");
    await expect(page.getByText("1 site match")).toBeVisible();
    expect(new URL(page.url()).searchParams.get("filter")).toContain("hq.city");
    await page.getByRole("combobox", { name: "Condition 1 field" }).selectOption("hq");
    await expect(page.getByRole("combobox", { name: "Condition 1 operator" }).locator("option")).toHaveText(["is empty", "is not empty"]);
    await page.keyboard.press("Escape");
    await page.goto("/o/site");
    await shot(page, "list-new-field-types");

    // Create one with every newer type.
    await page.getByRole("button", { name: "New site" }).click();
    const dialog = page.getByRole("dialog", { name: "New site" });
    await dialog.getByRole("textbox", { name: /^name/i }).fill("Lisbon office");
    const hq = dialog.getByRole("group", { name: "Headquarters" });
    await hq.getByRole("textbox", { name: "Address line 1" }).fill("Rua Augusta 10");
    await hq.getByRole("textbox", { name: "City" }).fill("Lisbon");
    await hq.getByRole("combobox", { name: "Country" }).selectOption("PT");
    await dialog.getByRole("radio", { name: "3 of 5" }).click();
    await dialog.getByRole("textbox", { name: /discount/i }).fill("7.5");
    await dialog.getByRole("textbox", { name: /call length/i }).fill("1h 15m");
    await dialog.getByRole("textbox", { name: /settings/i }).fill('{"timezone": "Europe/Lisbon"}');
    await dialog.getByRole("button", { name: "Create site" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Lisbon office" })).toBeVisible();
    const details = page.getByRole("region", { name: "Details" });
    await expect(details.getByText("Rua Augusta 10")).toBeVisible();
    await expect(details.getByText("Portugal")).toBeVisible();
    await expect(details.getByRole("img", { name: "3 out of 5" })).toBeVisible();
    await expect(details.getByText("7.5%")).toBeVisible();
    await expect(details.getByText("1h 15m")).toBeVisible();
    await expect(details.getByText(/"timezone": "Europe\/Lisbon"/)).toBeVisible();

    // Edit in place: a client-side check, then a value the server refuses lands on its field (422), then real edits.
    await details.getByRole("button", { name: "Edit Discount" }).click();
    await details.getByRole("textbox").fill("150");
    await details.getByRole("button", { name: "Save" }).click();
    await expect(details.getByText("Must be at most 100%")).toBeVisible();
    await details.getByRole("textbox").fill("20");
    await details.getByRole("button", { name: "Save" }).click();
    await expect(details.getByText("20%")).toBeVisible();
    await details.getByRole("button", { name: "Edit Settings" }).click();
    await details.getByRole("textbox").fill('{"__proto__": 1}');
    const refused = page.waitForResponse((r) => r.url().includes("/v1/objects/site/records/") && r.request().method() === "PATCH");
    await details.getByRole("button", { name: "Save" }).click();
    expect((await refused).status()).toBe(422);
    await expect(details.getByText(/key named "__proto__"/)).toBeVisible();
    await details.getByRole("textbox").fill('{"timezone": "Europe/Lisbon", "desks": 12}');
    await details.getByRole("button", { name: "Save" }).click();
    await expect(details.getByText(/"desks": 12/)).toBeVisible();
    await details.getByRole("button", { name: "Edit Headquarters" }).click();
    await details.getByRole("group", { name: "Headquarters" }).getByRole("textbox", { name: "City" }).fill("Porto");
    await details.getByRole("button", { name: "Save" }).click();
    await expect(details.getByText("Porto")).toBeVisible();
    await details.getByRole("button", { name: "Edit Call length" }).click();
    await details.getByRole("textbox").fill("2h");
    await details.getByRole("button", { name: "Save" }).click();
    await expect(details.getByText("2h", { exact: true })).toBeVisible();
    await details.getByRole("button", { name: "Edit Fit" }).click();
    await details.getByRole("radio", { name: "5 of 5" }).click();
    await details.getByRole("button", { name: "Save" }).click();
    await expect(details.getByRole("img", { name: "5 out of 5" })).toBeVisible();
    await shot(page, "record-new-field-types");
  });

  test("search from the command palette", async () => {
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("Warehouse");
    await page.getByRole("option", { name: /Warehouse robots/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Warehouse robots" })).toBeVisible();
  });

  test("move a deal on the board", async () => {
    await page.goto("/board");
    const discovery = page.getByRole("region", { name: /^Discovery/ });
    const card = discovery.locator("article").first();
    const name = (await card.getByRole("link").textContent())!;
    await card.getByRole("button", { name: `Move ${name}` }).click();
    await page.getByRole("menuitem", { name: "Proposal" }).click();
    await expect(page.getByRole("region", { name: /^Proposal/ }).getByRole("link", { name })).toBeVisible();
    await expect(page.getByText("Moved to Proposal").first()).toBeVisible();
    await shot(page, "board-light");
  });

  test("list layouts against the real API: a calendar month, a board and a grouped table", async () => {
    // The month of a seeded deal's close date, read from the API so the test doesn't depend on today's date.
    const { adminKey, ids } = readState();
    const deal = (await (await page.request.get(`/v1/objects/deal/records/${ids.deal}`, { headers: { Authorization: `Bearer ${adminKey}` } })).json()).data as { name: string; expected_close_date: string };
    await page.goto(`/o/deal?layout=calendar&by=expected_close_date&month=${deal.expected_close_date.slice(0, 7)}`);
    await expect(page.getByRole("table", { name: /^Deals in .*, by expected close date$/ }).getByRole("link", { name: deal.name })).toBeVisible();
    // The list remembers its layout, so put deals back to the table for the tests that follow.
    // The choice is saved a moment after it is made; wait for that, or leaving the page drops it.
    const saved = page.waitForResponse((r) => r.url().includes("/v1/me/preferences") && r.request().method() === "PUT" && (r.request().postData() ?? "").includes('"layout":null'));
    await page.getByRole("button", { name: "Table" }).click();
    await expect(page.getByRole("grid")).toBeVisible();
    await saved;

    await page.goto("/o/project?layout=board&by=phase");
    await expect(page.getByRole("region", { name: /^Planned/ }).getByRole("link", { name: "Warehouse robots" })).toBeVisible();

    await page.goto("/o/project?group=kind");
    // Groups start closed, with their count and totals; opening one loads its records.
    await page.getByRole("button", { name: /^Build 1 project Budget \$25,000\.00/ }).click();
    await expect(page.getByRole("table", { name: /^Projects: Build/ }).getByRole("link", { name: "Warehouse robots" })).toBeVisible();
  });

  test("the board and counted lists in several tabs at once: heavy requests queue and retry, no error toasts", async ({ browser }) => {
    // One session in four tabs: the board (an aggregate per pipeline and counted lists) and three counted lists, loaded at
    // once and twice over. The server allows a member 2 heavy requests at a time; each tab queues its own two and retries
    // the server's too_many_heavy_requests, so nothing surfaces as an error.
    // The member's sessions share one heavy-request budget: this tab's, and a second sign-in's three tabs.
    const ctx = await browser.newContext({ colorScheme: "light" });
    const first = await ctx.newPage();
    await signIn(first, readState().owner);
    const tabs = [page, first, await ctx.newPage(), await ctx.newPage()];
    const heavyRefused: string[] = [];
    const failed: string[] = [];
    for (const t of tabs) {
      t.on("response", (r) => {
        if (!new URL(r.url()).pathname.startsWith("/v1/")) return;
        if (r.status() === 429) heavyRefused.push(r.url());
        else if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
      });
    }
    const paths = ["/board", "/o/contact", "/o/deal", "/o/account"];
    for (let round = 0; round < 2; round++) {
      await Promise.all(tabs.map((t, i) => t.goto(paths[(i + round) % paths.length]!)));
      await Promise.all(tabs.map((t) => t.waitForLoadState("networkidle")));
    }
    for (const [i, t] of tabs.entries()) {
      await expect(t.getByRole("heading", { level: 1 }), paths[(i + 1) % paths.length]).toBeVisible();
      await expect(t.getByText(/Request ID/)).toHaveCount(0);
      await expect(t.getByText(/too many/i)).toHaveCount(0);
    }
    expect(failed).toEqual([]);
    test.info().annotations.push({ type: "heavy-gate", description: `${heavyRefused.length} too_many_heavy_requests answers, all retried` });
    await ctx.close();
  });

  test("edit in the list, then the record shows the new value and takes another edit", async () => {
    await page.goto("/o/contact");
    await page.getByRole("button", { name: /^View: / }).click();
    await page.getByRole("menuitem", { name: /^All contacts/ }).click();
    const grid = page.getByRole("grid");
    const headers = await grid.getByRole("columnheader").allTextContents();
    const col = headers.findIndex((h) => /job title/i.test(h));
    expect(col).toBeGreaterThan(0);
    const row = grid.getByRole("row").nth(1);
    const name = (await row.getByRole("link").first().textContent())!;
    await row.getByRole("gridcell").nth(col).dblclick();
    const editor = page.getByRole("dialog");
    await editor.getByRole("textbox").fill("Head of Operations");
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(row.getByRole("gridcell").nth(col)).toHaveText("Head of Operations");
    await row.getByRole("link", { name }).click();
    const details = page.getByRole("region", { name: "Details" });
    await expect(details.getByText("Head of Operations")).toBeVisible();
    // A second edit on the record goes through: no false "changed by someone else".
    await details.getByRole("button", { name: "Edit Job title" }).click();
    await details.getByRole("textbox").fill("COO");
    await details.getByRole("button", { name: "Save" }).click();
    await expect(details.getByText("COO", { exact: true })).toBeVisible();
    await expect(page.getByText(/changed this contact since you opened it/)).toHaveCount(0);
  });

  test("move a deal on the board by keyboard, then the list and the record agree", async () => {
    await page.goto("/board");
    await expect(page.getByText(/Space to pick the card up, Left and Right arrows to move it one stage/)).toBeVisible();
    const proposal = page.getByRole("region", { name: /^Proposal/ });
    const card = proposal.locator("article").first();
    const name = (await card.getByRole("link").textContent())!;
    await card.getByRole("button", { name: `Drag ${name}` }).focus();
    // Each step is announced (dnd-kit's live region); a person waits for it as the test does.
    await page.keyboard.press("Space");
    await expect(page.getByText("Over Proposal.")).toBeAttached();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText("Over Negotiation.")).toBeAttached();
    await page.keyboard.press("Space");
    await expect(page.getByText("Dropped in Negotiation.")).toBeAttached();
    const negotiation = page.getByRole("region", { name: /^Negotiation/ });
    await expect(negotiation.getByRole("link", { name })).toBeVisible();
    await expect(page.getByText("Moved to Negotiation").first()).toBeVisible();
    await a11yChecks(page, "board");
    // The list shows the new stage, and so does the record.
    await page.goto("/o/deal");
    const grid = page.getByRole("grid");
    const row = grid.getByRole("row").filter({ has: page.getByRole("link", { name, exact: true }) });
    await expect(row).toContainText("Negotiation");
    await row.getByRole("link", { name, exact: true }).click();
    // A deal's page shows its stage on the stage path (the default layout has one), with the current stage marked.
    await expect(page.locator('button[aria-current="step"]')).toHaveText(/Negotiation/);
  });

  test("complete a task, and the inbox count changes", async () => {
    await page.goto("/inbox");
    const count = page.getByRole("region", { name: "Needs attention" }).getByText("Overdue tasks").locator("xpath=following-sibling::p");
    await expect(count).toHaveText(/^\d+$/);
    const before = Number(await count.textContent());
    expect(before).toBeGreaterThan(0);
    const overdue = page.getByRole("region", { name: "Overdue tasks" });
    const first = overdue.getByRole("button", { name: /^Mark .* done$/ }).first();
    await first.click();
    await expect(count).toHaveText(String(before - 1));
    await expect(page.getByText("Task done").first()).toBeVisible();
  });

  test("command palette by keyboard only, typed before it has loaded", async () => {
    // The palette's code arrives slowly (a slow network), so the keys are typed before it is on screen.
    await page.route("**/assets/CommandPalette-*.js", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.fallback();
    });
    await page.goto("/o/contact");
    await expect(page.getByRole("heading", { level: 1, name: "Contacts" })).toBeVisible();
    await page.keyboard.press("Control+k");
    await page.keyboard.type("Warehouse", { delay: 5 });
    await expect(page.getByRole("combobox")).toHaveValue("Warehouse");
    await page.unroute("**/assets/CommandPalette-*.js");
    await expect(page.getByRole("option", { name: /Warehouse robots/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("No matches")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Warehouse robots" })).toBeVisible();
    // Create a custom object with "_" in its API name from the palette.
    await page.keyboard.press("Control+k");
    await page.keyboard.type("new customer onboarding");
    await expect(page.getByRole("option", { name: "New customer onboarding engagement" })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("confirm it's you: an action that needs a recent sign-in carries on after the password", async () => {
    // A password to confirm with (setting one needs no current password within 10 minutes of signing in).
    const password = `Tidal-Copper-${Date.now().toString(36)}`;
    await page.goto("/settings/account");
    const section = page.getByRole("region", { name: "Password" });
    await section.getByLabel("New password", { exact: true }).fill(password);
    await section.getByLabel("New password again").fill(password);
    await section.getByRole("button", { name: "Save password" }).click();
    await expect(page.getByText("Password saved").first()).toBeVisible();
    // The first key creation is answered as it would be 10 minutes after signing in.
    let refused = false;
    await page.route("**/v1/api-keys", async (route) => {
      if (route.request().method() === "POST" && !refused) {
        refused = true;
        await route.fulfill({ status: 403, contentType: "application/problem+json", body: JSON.stringify({ status: 403, code: "recent_sign_in_required", detail: "Sign in again to do this (your last sign-in was more than 10 minutes ago)" }) });
      } else await route.fallback();
    });
    await page.goto("/settings/api-keys");
    await page.getByRole("button", { name: "New key" }).click();
    await page.getByRole("textbox", { name: /^name/i }).fill("E2E reauth");
    await page.getByRole("button", { name: "Create key" }).click();
    const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
    await confirm.getByLabel("Password").fill(password);
    await confirm.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("dialog", { name: /Your new key: E2E reauth/ })).toBeVisible();
    await page.getByRole("checkbox", { name: /stored it somewhere safe/i }).click();
    await page.getByRole("button", { name: "Done" }).click();
    await page.unroute("**/v1/api-keys");
    // The sign-in page in reauth mode: methods shown with a live session, email filled in, back to the page after.
    await page.goto("/sign-in?reauth=1&return_to=%2Fsettings%2Fapi-keys");
    await expect(page.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue(readState().owner);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await page.waitForURL((u) => u.pathname === "/settings/api-keys");
    await expect(page.getByRole("heading", { level: 2, name: "API keys" })).toBeVisible();
  });

  test("accessibility of the main screens, in both themes", async () => {
    const { ids } = readState();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const path of ["/", "/o/contact", `/o/deal/${ids.deal}`, "/board", "/inbox", "/tasks", "/settings/roles/field_limited", "/settings/schema/contact", "/settings/audit", "/settings/api-keys", "/settings/no-such-page", "/o/contact/x/y/z"]) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await a11yChecks(page, `${path} (${scheme})`);
        if (/no-such-page|x\/y\/z/.test(path)) await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
      }
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    // The account menu is named by what it shows.
    const menu = page.getByRole("button", { name: /account menu/i });
    await expect(menu).toHaveAccessibleName(/Olivia Owner/);
  });

  test("other screens, in both themes", async () => {
    const { ids } = readState();
    for (const [path, name] of [["/inbox", "inbox"], ["/settings/roles/field_limited", "settings-roles"], ["/tasks", "tasks"]] as const) {
      await page.goto(path);
      await shot(page, `${name}-light`);
    }
    await page.emulateMedia({ colorScheme: "dark" });
    for (const [path, name] of [["/", "home"], ["/o/contact", "list"], [`/o/deal/${ids.deal}`, "record"], ["/board", "board"], ["/inbox", "inbox"], ["/settings/roles/field_limited", "settings-roles"]] as const) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveClass(/dark/);
      await shot(page, `${name}-dark`);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`/o/deal/${ids.deal}`);
    await shot(page, "deal-light");
  });

  test("settings: connected apps, automations and installed packs", async () => {
    // The user menu leads to Account → Connected apps.
    await page.goto("/");
    await page.getByRole("button", { name: /account menu/i }).click();
    await page.getByRole("menuitem", { name: "Connected apps" }).click();
    await page.waitForURL((u) => u.pathname === "/settings/account" && u.hash === "#connected-apps");
    const apps = page.getByRole("region", { name: "Connected apps" });
    await expect(apps).toBeVisible();
    await expect(apps.getByText(/No connected apps|Returns to/).first()).toBeVisible();
    await apps.scrollIntoViewIfNeeded();
    await shot(page, "settings-connected-apps");

    // Workspace sign-in shows the OAuth switch and scopes.
    await page.goto("/settings/workspace");
    await expect(page.getByRole("switch", { name: "Connecting apps" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /change the setup/i })).toBeVisible();

    // Automations: the fixture's one, paused and resumed.
    await page.goto("/settings/automations");
    const table = page.getByRole("table", { name: "Automations" });
    const row = table.getByRole("row").filter({ hasText: "Flag big deals" });
    await expect(row).toContainText("When a deal is created (deal.created)");
    await expect(row).toContainText("Enabled");
    await row.getByRole("button", { name: "Pause Flag big deals" }).click();
    await expect(row).toContainText("Paused");
    await shot(page, "settings-automations");
    await row.getByRole("button", { name: "Resume Flag big deals" }).click();
    await expect(row).toContainText("Enabled");

    // Installed packs: none in this workspace, said plainly, with the pointer to the CLI.
    await page.getByRole("link", { name: "Installed packs" }).click();
    await expect(page.getByRole("heading", { name: "Installed packs" })).toBeVisible();
    await expect(page.getByText(/No packs installed|recruiting/).first()).toBeVisible();
    await expect(page.getByText("crm pack", { exact: false }).first()).toBeVisible();
  });

  test("sign out", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: /account menu/i }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL("**/signed-out");
    await expect(page.getByRole("heading", { name: "You're signed out" })).toBeVisible();
    await page.goto("/o/contact");
    await page.waitForURL((u) => u.pathname === "/sign-in");
    expect(new URL(page.url()).searchParams.get("return_to")).toBe("/o/contact");
    await shot(page, "sign-in-light");
  });
});

test.describe("as a member with a field-limited role", () => {
  test("hidden fields are absent, read-only fields can't be edited, unreadable objects aren't offered", async ({ browser }) => {
    const page = await browser.newPage();
    await signIn(page, readState().limited);
    const nav = page.getByRole("navigation", { name: "Sections" });
    await expect(nav.getByRole("link", { name: "Contacts" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Deals", exact: true })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Deals board" })).toHaveCount(0);

    await nav.getByRole("link", { name: "Contacts" }).click();
    const grid = page.getByRole("grid");
    await expect(grid.getByRole("columnheader", { name: /job title/i })).toBeVisible();
    await expect(grid.getByRole("columnheader", { name: /^email/i })).toHaveCount(0);
    await expect(page.getByText(/@acme\.example/)).toHaveCount(0);
    await page.getByRole("button", { name: "Filter" }).click();
    await page.getByRole("button", { name: /add condition/i }).click();
    const options = await page.getByRole("combobox", { name: "Condition 1 field" }).locator("option").allTextContents();
    expect(options).not.toContain("Email");
    await page.keyboard.press("Escape");

    await grid.getByRole("link").first().click();
    const details = page.getByRole("region", { name: "Details" });
    await expect(details.getByText("Job title")).toBeVisible();
    await expect(details.getByRole("button", { name: "Edit Job title" })).toHaveCount(0);
    await expect(details.getByRole("button", { name: /Job title is read-only/ })).toBeVisible();
    await expect(details.getByRole("button", { name: "Edit First name" })).toBeVisible();
    await expect(details.getByText("Email", { exact: true })).toHaveCount(0);
    await shot(page, "limited-role-record-light");

    // Pages the role doesn't reach: one plain state each, nothing to click.
    await page.goto("/settings/audit");
    await expect(page.getByText("You don't have access to audit log")).toBeVisible();
    await expect(page.getByRole("button", { name: /load older|details/i })).toHaveCount(0);
    await expect(page.getByText(/This key lacks/)).toHaveCount(0);
    await page.goto("/board");
    await expect(page.getByText("You don't have access to deals")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.close();
  });
});

test.describe("on a phone", () => {
  test("a long object label doesn't push the New button off-screen", async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    watchErrors(page);
    await signIn(page, readState().owner);
    await page.goto("/o/onboarding_engagement");
    // The empty list shows a second "New …" button once it has loaded; the header's comes first.
    const button = page.getByRole("button", { name: "New customer onboarding engagement" }).first();
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await shot(page, "phone-list-light");
    await page.goto("/settings/roles/field_limited");
    await expect(page.getByRole("region", { name: "Effective access" })).toHaveAttribute("tabindex", "0");
    await page.close();
  });
});
