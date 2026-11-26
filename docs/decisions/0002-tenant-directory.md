# 0002: A tenant directory without row-level security

Status: accepted (2026-10-30)

## Context

Background jobs (audit sealing and anchoring, and later the outbox and schedulers) must enumerate tenants, but every tenant table forces RLS. Creating a BYPASSRLS role needs superuser, which managed Postgres and self-hosters may not grant.

## Decision

`tenant_directory` holds only tenant IDs and creation times, with no RLS. (Since [ADR 0020](0020-data-disposal.md) it also holds `delete_after`, the time a requested deletion is due, so the worker finds due workspaces without entering each one. Still nothing of the customer's.) Workers read it, then open one tenant-scoped transaction per tenant. All tenant data, including names, stays in RLS-protected tables.

API-key authentication uses a separate, narrow exception: a `key_lookup` policy on `api_keys` lets a transaction read the one row whose public lookup value it presents. It cannot list keys, and the secret hash still has to match.

## Consequences

The app role can learn how many tenants exist and their opaque IDs. It cannot read anything else across tenants.
