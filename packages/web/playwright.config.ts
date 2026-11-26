import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests: the real API (packages/server) serving the built app (packages/web/dist) against a
 * real Postgres database, driven in Chromium. See e2e/README section in packages/web/README.md.
 *
 *   pnpm --filter @hl-crm-db/web build
 *   pnpm --filter @hl-crm-db/web test:e2e        # E2E_DB_NAME defaults to hlcrm_dev_web
 *   pnpm --filter @hl-crm-db/web screenshots     # the same, and refreshes docs/screenshots (E2E_SCREENSHOTS=1)
 */
const port = Number(process.env.E2E_PORT ?? 8791);

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1360, height: 860 },
    trace: "retain-on-failure",
  },
  // Everything in Chromium; the sign-in link, OAuth consent and sign-up flows (form posts under Referrer-Policy: no-referrer) in Firefox and WebKit too.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 860 } } },
    { name: "firefox", testMatch: /(signin-link|oauth-consent|sign-up)\.spec\.ts/, use: { ...devices["Desktop Firefox"], viewport: { width: 1360, height: 860 } } },
    { name: "webkit", testMatch: /(signin-link|oauth-consent|sign-up)\.spec\.ts/, use: { ...devices["Desktop Safari"], viewport: { width: 1360, height: 860 } } },
  ],
});
