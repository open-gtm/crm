# Contributing

- Work on a branch and open a pull request. CI must pass: tests, lint, type-check, and secret, dependency, SAST and container scans.
- Sign the [Contributor License Agreement](CLA.md) once, by commenting on your first pull request as the CLA bot asks. You keep the copyright in your work. The CLA lets the project offer contributions under its open-source licenses and in commercial editions, and commits to keeping them available as open source.
- New API routes must be added to the cross-tenant harness (`packages/server/test/cross-tenant.test.ts`). A meta-test fails until they are.
- Write SQL in the directory's query module (`auth/queries.ts` and the like), never inline in handlers or business logic ([ADR 0012](docs/decisions/0012-sql-in-query-modules.md)). Lint enforces this in the directories converted so far.
- Never commit secrets, real customer data or production values, including in tests and fixtures.
- Record significant design choices in `docs/decisions/`.

## Licenses

Everything is [AGPL-3.0](LICENSE) except the SDK in `packages/sdk`, the `crm` CLI in `packages/cli` and the example schema packs in `packs/`, which are MIT ([SDK](packages/sdk/LICENSE), [CLI](packages/cli/LICENSE), [packs](packs/LICENSE)). Contributions to each part are licensed the same way.
