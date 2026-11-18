# 0012: SQL lives in per-domain query modules

Status: accepted (2026-11-17)

## Context

The server talks to Postgres through postgres.js tagged templates (`tx`…``), inside `withTenant`. A review asked for SQL to come out of route handlers and of business and policy code (a `SELECT` in the password rules, the identity lookup), and suggested importing raw `.sql` files. There are about 450 statements across about 50 files, and about 37 more are built at run time from the fields a workspace defines.

## Decision

SQL stays in tagged templates, but each domain directory keeps it in one query module: `auth/queries.ts`, `api/queries.ts` (the request pipeline: readiness and idempotent replay), and so on. A directory may split its module into a `queries/` folder if one file gets unwieldy.

- Each query is one exported function. It takes the transaction (or pool) first and plain typed arguments after, and returns typed rows, or the one row, count or boolean every caller wants. It is named for what it does in domain terms (`revokeSessionsOf`, `countPasswordAttempt`), not after the SQL.
- Row types are declared in the module. Optional conditions stay postgres.js fragments inside the function, chosen by its arguments.
- The calling code keeps its checks, errors, audit entries and the order of statements in its transaction. Moving a query never changes its SQL.
- A query that a handler needs from a directory not yet converted goes in a small module next to the core file it belongs with (`core/events-queries.ts`, `core/audit-queries.ts`), until that directory is converted.
- In converted directories ESLint refuses a tagged template or `.unsafe()` outside the query module (`no-restricted-syntax` in `eslint.config.js`, run by `pnpm lint` in CI).

## Why not raw .sql files

- Some SQL can't be a static file: queries over records, filters, sorts, aggregates and imports are built at run time from the fields each workspace defines.
- postgres.js's `sql.file(path, args)` (checked in the installed 4.1.1 source) reads the file again on every call (its typed `cache` option is not used), takes only positional `$1, $2` arguments, and runs as a "simple" query without a prepared statement when given no arguments. The file is one string, so it can't hold fragments: optional conditions, the shared column list of sign-in flows, `IN` lists and identifiers would all need string building again.
- Its row type is whatever the caller asserts, with nothing tying it to the file, so a renamed column fails at run time, not at type-check. Tagged templates are no better checked, but the type sits next to the SQL it describes, in the same file.

Query modules give the reviewer's goal (no SQL in handlers or policy code, one place per domain to read a table's queries) without losing parameter binding, fragments or row types.

## What would change this

Adopting a typed-SQL generator, such as pgtyped, that checks queries and their row types against the schema. That would favour `.sql` files (or checked templates) for the static queries, with the run-time ones staying as builders. The query modules are the step before it: each function's signature would stay, and only its body would change.

## Migration

Incremental, one or a few directories per pull request, adding each to the ESLint rule's `files` as it lands.

- Done: `auth/` (every query, including the five `.unsafe()` calls that spliced the flow column list, now a fragment), and the queries written in handlers in `api/` and `web/`.
- Remaining, counted as tagged templates and `.unsafe()` calls, fragments included: `core/` (about 400, including the run-time generated queries), `oauth/` (about 65), `worker/` (about 16) and `db/` (about 8, the role checks and migration runner).
