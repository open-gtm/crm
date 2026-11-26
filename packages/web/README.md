# hl-crm-db web UI

A generic web app for hl-crm-db: the reference front end that works out of the box against any workspace, and that self-hosters can use as it is, fork, or replace. It talks to the API over HTTP only (no server code), and every screen that shows records is built from the workspace's metadata at runtime, so custom objects and fields appear without any change here.

What it does:

- **Records:** a list per object (sort on up to three columns, a filter builder with AND/OR groups and filters through relations, columns to show and order, saved views personal or shared, a total count, thousands of rows scrolled smoothly, inline editing, bulk change and archive), a record page (fields edited in place, related lists found from metadata, the timeline with activities and tasks, archive and restore), and a create form for any object.
- **Deals:** a board per pipeline with totals per stage (per currency when they mix) and drag-and-drop between stages through the stage-move operation.
- **Me:** my open tasks, the inbox (alerts and automation messages: acknowledge, snooze, resolve) and email preferences.
- **Settings,** each shown only when the role allows it: account, sessions and password, and **connected apps** (MCP clients such as Claude connected through OAuth: see and disconnect them); the workspace's sign-in methods, including whether members may connect apps and with which scopes (owner only); members, with each member's connected apps for whoever has `members:manage`; roles with object and field rules and the effective access; API keys; webhooks with deliveries; the audit log; objects and fields (add a field after seeing the server's dry run, with each field's origin and the source of its last change, and the schema's change history); **Automations** (with `automations:manage`: make and change them with the server's dry run before each save, test one against a record, run it, and read each run's step log); **Data health** (checks run on demand, and duplicate review with a field-by-field merge previewed by the server); and a read-only **Installed packs** list. Packs are installed with the `crm` CLI or the API (docs/packs.md).
- **Everywhere:** a command palette (⌘K / Ctrl+K) to search records and run commands, light and dark themes (following the system, or chosen and saved to your account), keyboard support, readable error messages with the request ID.

## Lists and record pages

Every screen is built from the workspace's metadata, so these work for custom objects and fields with no change ([ADR 0015](../../docs/decisions/0015-record-ui-layouts.md)):

- **A list** can be shown as a table (optionally grouped by a field, with counts and totals per group), as a board with a column per value of a select or status field, or as a calendar by a date field. The choice is in the address (`?layout=board&by=status`, `?layout=calendar&by=due_at&month=2027-02`, `?group=owner`) and is remembered per object for each member. `src/features/list/layouts.ts` decides which fields each can use.
- **A record page** shows the object's fields in sections. Someone who manages the schema arranges them under Settings → Schema → the object → Record page layout; without a layout, the object's own fields are under Details and custom ones under Custom fields. Notes, files, related records and the timeline follow.

## Running it in development

The app is a Vite + React single-page app. In development Vite serves it on `http://localhost:5173` and forwards `/v1` and `/auth` to the API, so the browser sees one origin.

```sh
pnpm install
# 1. An API with people sign-in on, whose PUBLIC_URL is the Vite address (cookies and the CSRF origin check use it):
PUBLIC_URL=http://localhost:5173 pnpm --filter @hl-crm-db/server dev api        # plus DATABASE_URL etc., as for the server
# 2. The app, pointed at that API (default http://localhost:8787):
API_URL=http://localhost:8787 pnpm --filter @hl-crm-db/web dev
# 3. Sign in: a one-time link from the server (it opens the API's own page, then lands in the app)
pnpm --filter @hl-crm-db/server dev sign-in-link --email you@example.com
```

A member who signs in by such a link and has no password first sees a short welcome step offering to set one (skippable; Home and Settings → Account keep offering it, `src/features/shell/FirstRun.tsx`).

With email set up on the server (`SMTP_URL`), you can also sign in with an emailed code, a password, or single sign-on from the app's own sign-in page.

## How it is served in production

`pnpm --filter @hl-crm-db/web build` writes static files to `packages/web/dist`. The API serves them itself, from the same origin as `/v1`, whenever they are present: the Docker image includes them (in `/app/web`), and a source checkout finds `packages/web/dist`. Nothing else is needed: no CORS, and the session cookie and CSRF checks work as they do for any same-origin page.

| Setting | Default | Meaning |
|---|---|---|
| `WEB_UI` | `true` | `false` or `0` (any case) turns the UI off: the API answers exactly as it did before, `/` included |
| `WEB_UI_DIR` | `web/` next to the server, else `packages/web/dist` | Where the built files are, for a fork's own build |
| `PUBLIC_URL` | unset | People sign-in needs it (docs/sign-in.md); the app is at this address |
| `VITE_DOCS_URL` (build time) | this repository's `docs/` on GitHub | Where the app's links to the documentation point (`src/lib/docs.tsx`): set it when building a fork that publishes its own docs. https only |

What the server does (`packages/server/src/web/static.ts`):

- `/assets/*` (file names carry a content hash) are cached for a year, `immutable`. Other top-level files (the icon) are revalidated with `ETag` and `Last-Modified` (a `304` when unchanged). Files are held in memory and re-read when a rebuild changes them.
- The app's HTML shell answers only the app's own client routes, so links to any screen work on reload: the top-level paths in **`src/app-routes.json`** (`/`, `/sign-in`, `/o`, `/board`, `/settings`, …), which the build copies to `dist/app-routes.json` for the server. Only `GET`/`HEAD` from a browser asking for HTML get it. Everything else, including anything the API owns or may own (`/v1`, `/auth`, `/oauth`, `/mcp`, `/.well-known`, …) and any odd spelling of those (`/V1/me`, `/v1%2fme`), gets the API's JSON 404. A missing asset is a 404, never the shell. **Adding a top-level route in `src/router.tsx` means adding it to `src/app-routes.json`**; `test/routes.test.ts` fails until you do.
- The server logs at startup whether it serves the UI and from where, and warns when `WEB_UI_DIR` is set but holds no build.
- The shell is sent with `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and this Content-Security-Policy:

  ```
  default-src 'self'; script-src 'self'; style-src 'self' 'nonce-<per response>'; img-src 'self' data:;
  font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'
  ```

  No inline script and no third-party origin: fonts are the system's and icons are bundled. The nonce, new on every response, is written into the page's `<meta name="hlcrm-style-nonce">`; the app hands it to the libraries that insert a `<style>` element (scroll locking under dialogs).

## Signing in

The app has its own sign-in screens (`/sign-in`) that use the server's JSON sign-in endpoints: password, emailed code, single sign-on, and the workspace choice when an email belongs to several. Links from email and from `sign-in-link` go through the server's own pages under `/auth` and then land in the app. After signing in, the app goes back to `return_to` when it is one of its own pages, the server's OAuth consent page (`/oauth/authorize?…`, when an MCP client sent a signed-out browser to sign in, up to 2,048 characters) or the server's connected-apps page, always with a full page load, so a server page is loaded as one; anything else lands on `/`. The same holds for `/sign-in?reauth=1&return_to=…`, which an admin connection's consent needs when the last sign-in is more than 10 minutes old. The app follows docs/sign-in.md: it never handles an API key for its own requests; it reads the CSRF token from `GET /v1/auth/session` and keeps it in memory only; every write goes through one request helper (`src/lib/api/client.ts`) that adds `X-CSRF-Token` and an `Idempotency-Key`, sends `If-Match` for record edits, waits out `Retry-After`, runs at most two heavy requests (counts, aggregates, bulk changes) at a time, and treats a 401 as "your session has ended" with a way to sign in again and come back to the same page.

## Retheming

Every colour, the type scale, radii and shadows are CSS variables in **`src/styles/tokens.css`**: light values on `:root`, dark ones on `.dark`. Edit that one file. Components use Tailwind utilities that point at the tokens (`bg-surface`, `text-muted`, `border-line`, `bg-accent`, …; the mapping is in `src/styles/app.css`), and Tailwind's own palette is switched off so nothing drifts from them. A unit test (`test/safe.test.ts`) checks the text and control pairs for WCAG AA contrast in both themes, so a retheme that breaks contrast fails `pnpm test`. The icon is `public/favicon.svg`; the product name is in `index.html` and `src/features/auth/SignInPage.tsx`.

## Forking it

- `src/meta/` is the heart: `fields.ts` decides, from describe output alone, what each of the 19 field types supports (operators, sorting, writing, form values, client-side checks); `registry.tsx` renders each type (value, input, filter input). Add a field type there and every screen follows. Addresses filter and sort by part (`field.city`), JSON by "is empty" only. A type the app doesn't know (a server newer than the app) is shown read-only as its raw value, filters by "is empty" only and never sorts, so it can't break a screen.
- `src/lib/writes.ts` (`applyWrite`) is what every write to records does to the cache: the server's record into the record's query and every loaded row, then the lists, counts, aggregates, board, related lists, timelines, search and inbox it can affect are refreshed. A new write path calls it.
- **Field types.** Besides text, numbers, dates, selects, relations and the rest, the app renders, edits, filters and sorts the five newer types as the server defines them (docs/data-model.md): an **address** (edited by part; shown laid out from its parts; filtered and sorted by part, e.g. `hq.city`, `hq.country`; the whole address only by "is empty"), **json** (edited as JSON text, filtered by "is empty" only, never sorted), a **rating** (stars, 1 to the field's `max`, 5 by default and at most 10), a **percent** (percentage points, within the field's `min`/`max`, 0 to 100 by default, up to 4 decimals) and a **duration** (whole seconds, entered as `1h 30m` or `90m`). Values the server refuses come back as 422 with a message per field, shown on that field.
- Actions that need a recent sign-in (creating or rotating an API key, a password change without the current password) are handled by the request helper: it asks the person to confirm it's them (`src/features/shell/Reauth.tsx`) and retries; `/sign-in?reauth=1&return_to=…` is the same from the sign-in page. Both offer only the methods that can work for that member (`src/lib/signin.ts`, from `/auth/capabilities` and the session's `member.has_password`); with none (no password, no email, no single sign-on) they show the `sign-in-link … --return-to <this page>` command to run, and the dialog carries on once the new link has been opened in the same browser.
- Search params are plain text in the URL (`reauth=1`, `sort=-amount,name`); only structured ones (a filter) are compact JSON (`parseSearch`/`stringifySearch` in `src/router.tsx`). Older bookmarks with JSON-quoted values still open.
- Whether connecting apps over OAuth is on comes from the session (`server.connected_apps`); the app never probes a discovery document for it. Descriptions of the standard objects and fields name API operations for agents (`move_deal_stage`); `forPeople` in `src/lib/text.ts` says them in words in forms and dialogs.
- Labels from the schema lose Unicode bidi controls as they arrive (`src/meta/hooks.ts`); record values render inside `<bdi>`.
- `src/features/` holds the screens, one folder each, loaded on demand. `src/components/ui/` holds the small component set (Radix primitives, Tailwind classes, copied into the repo rather than imported from a kit).
- `src/lib/api/` is the HTTP layer and the response types. Record shapes are never typed per object: describe is the source of truth at runtime.
- Server state lives in TanStack Query: everything about an object's records sits under the key `["records", object]`, so one invalidation refreshes its lists, record pages, related lists and board totals (`src/lib/keys.ts`). The URL is the source of truth for navigation, filters, sort, columns and the view.

**Types.** The static API surface is typed by hand in `src/lib/api/types.ts` (plus the SDK's record, page, aggregate and view types) rather than generated from `/openapi.json`: most admin routes declare open `{data: object}` responses there, so generated types would add little, and generating them needs a running server or server code at build time.

## Tests

```sh
pnpm --filter @hl-crm-db/web test        # unit and component tests (Vitest, Testing Library, jsdom)
pnpm --filter @hl-crm-db/web build && pnpm --filter @hl-crm-db/web test:e2e
```

The end-to-end tests (Playwright, Chromium: `pnpm --filter @hl-crm-db/web exec playwright install chromium` once) migrate the database named by `E2E_DB_NAME` (default `hlcrm_dev_web`; `hlcrm` and `hlcrm_test` are refused), bootstrap a fresh workspace, add sample data, a custom object and a member with a field-limited role through the API, start the API serving the built app on `E2E_PORT` (default 8791), and drive it: sign in with a server-printed link, list, filter and sort, save a view, edit in place (in the list, then on the record), create a record with a relation, search and create from the command palette by keyboard alone, move a deal on the board (by its menu and by keyboard drag), complete a task and watch the inbox count, confirm it's you before creating a key, check the main screens' accessibility in both themes, check a phone-width header, sign out, and check that the limited member sees no hidden field, can't edit a read-only one and gets one plain "no access" state for pages their role doesn't reach. It also covers the newer field types (an object with an address, json, rating, percent and duration field: create, edit, filter and sort), Settings → Connected apps, Automations (pause and resume) and Installed packs, and the board and counted lists in four tabs of one member at once (heavy requests queue and retry, no error shown). The first run on a fresh install (`e2e/first-run.spec.ts`: `bootstrap`'s next steps, the welcome step and setting a password, then signing in with it; and "Confirm it's you" for a member with no usable method, showing the command, running it, opening the link in another tab and the action carrying on) runs in Chromium. The OAuth consent flow (`e2e/oauth-consent.spec.ts`: an MCP client registered in the test, a signed-out browser sent to sign in and back to consent, Allow as a form post with `Origin: null`, the code and `state` reaching the client's loopback redirect with no `Referer`; and the app's own sign-in, plain and `reauth=1`, coming back to consent) and the server-printed sign-in link flow (`e2e/signin-link.spec.ts`) also run in Firefox and WebKit (`playwright install firefox webkit`). The API runs with OAuth for MCP on (`MCP_PUBLIC_URL` is the next port; no MCP process is started). Runs on different ports (`E2E_PORT`) keep separate state files; give each its own `--output` too if they run at the same time. Database URLs are built from the root `.env` the way the server's tests build theirs. Teardown revokes the fixture's admin key.

The screenshots in `docs/screenshots/` are refreshed only on request: `pnpm --filter @hl-crm-db/web screenshots` (the Chromium suite with `E2E_SCREENSHOTS=1`). An ordinary test run leaves them alone.

**Accessibility checks.** The end-to-end suite checks each main screen in both themes for the problems an axe run found here (nested interactive controls, unnamed table headers and controls, a visible label missing from a control's name, scrollable regions the keyboard can't reach, one `main` landmark and an `h1`). axe-core itself (`@axe-core/playwright`) is MPL-2.0, which isn't a permissive licence, so it isn't a dependency; running it once by hand (`npx @axe-core/cli`) is still a good idea before a release.

## Licence

AGPL-3.0-only, like the server (see the repository's `LICENSE`). Every production dependency must be under a permissive licence (MIT, Apache-2.0, BSD, ISC and similar); `pnpm check:licenses` at the repository root (it runs `packages/web/scripts/check-licenses.mjs`) lists them and fails on anything else, copyleft or unknown. CI should run `pnpm check:licenses`.
