# 0013: Permission sets on top of roles

Status: accepted (2026-11-24)

## Context

ADR 0007 gave every member exactly one role, and noted that combining could come later. It has: workspaces want to give one person something extra (the deal desk's fields, the right to build automations) without inventing a role for every combination. With one role per member, three people who differ in one grant need three roles that are otherwise copies of each other, and the copies drift.

## Decision

**A member keeps one role and can also hold permission sets.** The role stays what it was: the baseline, the owner rules, the thing an automation's `run_roles` names. A permission set is extra access on top. A member can hold up to 20, and service accounts hold them too.

**A set is built like a custom role, in two areas.** Objects and fields: the record permissions (`records:read`, `records:write`, `records:archive`, `restricted:read`), which apply to every object, and rules per object and per field. Features: every other permission in the catalog (managing the schema, automations, members, …). `GET /v1/permissions` gives each permission its `category`, and roles and sets return `record_permissions` and `feature_permissions` beside the full list. The catalog itself is unchanged: finer features can be split out of `schema:manage` later without changing the model.

**Access is the union: the most permissive wins.** An action on an object is allowed when the role or any set allows it. A field gets the widest access any of them gives it. A deny, or a hidden or read-only field, only shapes the role or set it is written in; it never takes away what another part gives. The alternative, deny wins, would let adding a set remove access, which makes "what does this set do" depend on everything else a member holds. Permissions that aren't per object (`restricted:read`, the features) are a plain union: a member who holds `restricted:read` through one set sees restricted values on every object they can read, through whichever part.

**Sets are rows of `roles` with `kind = 'permission_set'`.** The rule tables, the `access_version` triggers, the catalog CHECKs and the unrestricted-managers constraint then cover sets with no second copy to keep in step, and the service code for creating, changing and archiving is the same code with a kind. Roles and sets have separate key namespaces and separate ID prefixes (`role_…`, `pset_…`); neither is found through the other's routes. `member_permission_sets` holds who has what, with real foreign keys to the member and (through the kind) to a set, so a role can never be assigned as a set. A trigger refuses a member whose role is a set, and one refuses changing a row's kind.

**One place combines.** `loadMemberAccess` in `core/access.ts` takes a role and the member's sets and returns one list of permissions and one set of rules, written the way a single role's rules are. Everything downstream (the record layer, the query compiler, search, notifications, key scopes, the escalation checks) reads a context as before. Every query that reads a member's role selects their sets with it (`memberSetsColumn`), so nothing decides a member's access from the role alone: API keys, browser sessions, connected apps, notification and email recipients, the member who caused an automation run, who is told when automations pause. With no sets the result is the role's own rules and version, exactly as before.

**The rules of roles hold for sets.**

- A set that holds a permission that reaches record data must hold the record permissions it reaches, and a set that manages automations, webhooks, alerts or the schema can't have denying object rules or field rules. Checked per set, so the member's combined access is unrestricted too.
- Creating or changing a set needs `roles:manage`, and the caller must hold every permission and all the record access it gives, before and after.
- Giving a set to a member needs `members:manage` and the same: nobody hands out, through a set, what they don't hold. Taking one away needs only the right to act on that member.
- Nobody changes their own sets, or changes or archives a set they hold.
- Acting on a member (changing, disabling, managing their keys or sign-in) compares the caller with everything the member holds, role and sets.
- A set can't be archived while an active member holds it.
- Changes are audited: `permission_set.created`, `.updated`, `.archived`, and `member.permission_sets_changed` (or `service_account.…`) with the sets added and removed.

## Consequences

- "What can this person do" is no longer one lookup. `GET /v1/me/access` shows the combined result for the caller, and the access review lists each member's role, each set with its permissions and rules, and `effective_permissions`.
- Authentication reads the member's sets in the same query as their role (one subquery), and loads each set's rules from the per-version cache.
- `run_roles` on an automation still names roles. A member allowed to run one through their role is then checked with their combined access.
- A warning on saving an automation or alert names roles whose members can't read what it depends on. A member of such a role who can read it through a set is still notified; the warning is conservative.
- Schema packs carry roles, not permission sets.
- The MCP servers have no tools for sets, as they have none for roles.
- Migration 019 adds `roles.kind` (existing rows are roles), replaces the unique index on keys with one per kind, and adds `member_permission_sets`. It changes no existing access.
