import type { Tx } from "../../db/pool.js";
import type { FieldMeta, ObjectMeta } from "../schema.js";

/**
 * The SQL of workspace metadata (ADR 0012): objects, fields, modules and the schema change log
 * (core/schema.ts, core/schemadoc.ts, core/describe.ts). The schema writers keep their checks, errors,
 * audits, events and the order of statements in their transaction.
 *
 * core/schema.ts's statements over record tables, whose table and column names are quoted with its own
 * quoteIdent, stay there: importing quoteIdent here would make this module and core/schema.ts import
 * each other.
 */

// --- Loading and locking ----------------------------------------------------------------------------

/** Locks the workspace row (NO KEY UPDATE): every schema writer takes this before it reads the schema. */
export async function lockWorkspaceSchema(tx: Tx): Promise<void> {
  await tx`SELECT 1 FROM tenants FOR NO KEY UPDATE`;
}

export interface SchemaHeadRow { tenant_id: string; schema_version: string; schema_token: string; currency: string; modules: string[] }

/** The workspace's schema version and cache token, currency and modules. */
export async function schemaHead(tx: Tx): Promise<SchemaHeadRow | undefined> {
  const [t] = await tx<SchemaHeadRow[]>`
    SELECT tenant_id, schema_version::text, schema_token::text, currency, modules FROM tenants`;
  return t;
}

/** Every live object's metadata. */
export async function liveObjects(tx: Tx): Promise<Omit<ObjectMeta, "fields" | "byName">[]> {
  return tx<Omit<ObjectMeta, "fields" | "byName">[]>`
    SELECT id, api_name, label, plural_label, description, id_prefix, module, is_system, table_name, display_field, owned, hidden
    FROM objects WHERE archived_at IS NULL`;
}

/** Every live field's metadata, in position order. */
export async function liveFields(tx: Tx): Promise<(FieldMeta & { create_only?: boolean })[]> {
  return tx<(FieldMeta & { create_only?: boolean })[]>`
    SELECT id, object_id, api_name, storage_key, label, description, type, is_system, column_name, read_only, required,
           is_unique, default_value, validation, options, sensitivity, hidden, position
    FROM fields WHERE archived_at IS NULL ORDER BY position, created_at`;
}

// --- Standard objects -------------------------------------------------------------------------------

/** Adds a standard object to a new workspace. */
export async function insertStandardObject(tx: Tx, o: { tenantId: string; id: string; apiName: string; label: string; pluralLabel: string;
  description: string; idPrefix: string; module: string | null; table: string; owned: boolean }): Promise<void> {
  await tx`
      INSERT INTO objects (tenant_id, id, api_name, label, plural_label, description, id_prefix, module, is_system, table_name, owned)
      VALUES (${o.tenantId}, ${o.id}, ${o.apiName}, ${o.label}, ${o.pluralLabel}, ${o.description}, ${o.idPrefix},
              ${o.module}, true, ${o.table}, ${o.owned})`;
}

/** Adds a standard field (stored in a column of the object's table) to a new workspace. */
export async function insertStandardField(tx: Tx, f: { tenantId: string; id: string; objectId: string; apiName: string; storageKey: string;
  label: string; description: string; type: string; column: string; readOnly: boolean; required: boolean; options: unknown; sensitivity: string;
  position: number }): Promise<void> {
  await tx`
        INSERT INTO fields (tenant_id, id, object_id, api_name, storage_key, label, description, type, is_system, column_name,
                            read_only, required, options, sensitivity, position)
        VALUES (${f.tenantId}, ${f.id}, ${f.objectId}, ${f.apiName}, ${f.storageKey}, ${f.label}, ${f.description},
                ${f.type}, true, ${f.column}, ${f.readOnly}, ${f.required}, ${tx.json(f.options as never)},
                ${f.sensitivity}, ${f.position})`;
}

// --- The schema change log --------------------------------------------------------------------------

/** Bumps the schema version, which also gives the workspace a new schema token. */
export async function bumpSchemaVersion(tx: Tx): Promise<{ schema_version: string; schema_token: string }> {
  const [row] = await tx<{ schema_version: string; schema_token: string }[]>`
    UPDATE tenants SET schema_version = schema_version + 1 RETURNING schema_version::text, schema_token::text`;
  return row!;
}

/** Logs a schema change. `before` and `after` are stored as JSON; undefined stores NULL. */
export async function insertSchemaChange(tx: Tx, c: { tenantId: string; version: number; actorType: string; actorId: string | null; surface: string;
  change: string; objectId: string | null; fieldId: string | null; before: unknown; after: unknown; via: string | null; pack: string | null }): Promise<void> {
  await tx`
    INSERT INTO schema_changes (tenant_id, version, actor_type, actor_id, surface, via, pack, change_type, object_id, field_id, before, after)
    VALUES (${c.tenantId}, ${c.version}, ${c.actorType}, ${c.actorId}, ${c.surface}, ${c.via}, ${c.pack}, ${c.change},
            ${c.objectId}, ${c.fieldId},
            ${c.before === undefined ? null : tx.json(c.before as never)},
            ${c.after === undefined ? null : tx.json(c.after as never)})`;
}

export interface SchemaChangeLogRow { version: string; changed_at: Date; actor_type: string; actor_id: string | null; surface: string;
  via: string | null; pack: string | null; change_type: string; before: unknown; after: unknown; object_name: string | null; field_name: string | null }

/** The newest schema changes, at most `limit`, with the names of the objects and fields they touched. */
export async function schemaChangeLog(tx: Tx, limit: number, objectId: string | null = null): Promise<SchemaChangeLogRow[]> {
  return tx<SchemaChangeLogRow[]>`
    SELECT sc.version::text, sc.changed_at, sc.actor_type, sc.actor_id, sc.surface, sc.via, sc.pack, sc.change_type, sc.before, sc.after,
           o.api_name AS object_name, f.api_name AS field_name
    FROM schema_changes sc
    LEFT JOIN objects o ON o.tenant_id = sc.tenant_id AND o.id = sc.object_id
    LEFT JOIN fields f ON f.tenant_id = sc.tenant_id AND f.id = sc.field_id
    WHERE ${objectId}::uuid IS NULL OR sc.object_id = ${objectId}::uuid
    ORDER BY sc.version DESC LIMIT ${limit}`;
}

export interface LastChangeRow { field_id: string | null; version: string; changed_at: Date; actor_type: string; actor_id: string | null; surface: string;
  via: string | null; pack: string | null; change_type: string }

/** The newest schema change of an object itself (field_id NULL) and of each of its fields. */
export async function lastChangesOf(tx: Tx, objectId: string): Promise<LastChangeRow[]> {
  return tx<LastChangeRow[]>`
    SELECT DISTINCT ON (field_id) field_id, version::text, changed_at, actor_type, actor_id, surface, via, pack, change_type
    FROM schema_changes WHERE object_id = ${objectId}
    ORDER BY field_id, version DESC`;
}

/** What installed packs own: object and field IDs by pack name. */
export async function packOwnership(tx: Tx): Promise<{ name: string; owned: { objects?: Record<string, string>; fields?: Record<string, string> } }[]> {
  return tx<{ name: string; owned: { objects?: Record<string, string>; fields?: Record<string, string> } }[]>`
    SELECT name, owned FROM installed_packs WHERE status = 'installed' ORDER BY name`;
}

export async function apiKeyName(tx: Tx, id: string): Promise<string | undefined> {
  const [row] = await tx<{ name: string }[]>`SELECT name FROM api_keys WHERE id = ${id}`;
  return row?.name;
}

export async function oauthClientName(tx: Tx, grantId: string): Promise<string | undefined> {
  const [row] = await tx<{ client_name: string }[]>`SELECT client_name FROM oauth_grants WHERE id = ${grantId}`;
  return row?.client_name;
}

export type DriftRow = { version: string; changed_at: Date; actor_type: string; actor_id: string | null; surface: string; change_type: string;
  object_id: string | null; field_id: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null;
  object_name: string | null; field_name: string | null };

/** Schema changes after `since`, oldest first, at most `limit`, with the names of the objects and fields they touched. */
export async function schemaChangesSince(tx: Tx, since: number, limit: number): Promise<DriftRow[]> {
  return tx<DriftRow[]>`
    SELECT sc.version::text, sc.changed_at, sc.actor_type, sc.actor_id, sc.surface, sc.change_type, sc.object_id, sc.field_id, sc.before, sc.after,
           o.api_name AS object_name, f.api_name AS field_name
    FROM schema_changes sc
    LEFT JOIN objects o ON o.tenant_id = sc.tenant_id AND o.id = sc.object_id
    LEFT JOIN fields f ON f.tenant_id = sc.tenant_id AND f.id = sc.field_id
    WHERE sc.version > ${since} ORDER BY sc.version LIMIT ${limit}`;
}

// --- Custom objects and fields ----------------------------------------------------------------------

/** Archived objects' names and ID prefixes (they stay reserved). */
export async function archivedObjectNames(tx: Tx): Promise<{ api_name: string; id_prefix: string }[]> {
  return tx<{ api_name: string; id_prefix: string }[]>`SELECT api_name, id_prefix FROM objects WHERE archived_at IS NOT NULL`;
}

/** Adds a custom object. */
export async function insertCustomObject(tx: Tx, o: { tenantId: string; id: string; apiName: string; label: string; pluralLabel: string;
  description: string; idPrefix: string; displayField: string | null; owned: boolean; createdBy: string | null }): Promise<void> {
  await tx`
    INSERT INTO objects (tenant_id, id, api_name, label, plural_label, description, id_prefix, display_field, owned, created_by)
    VALUES (${o.tenantId}, ${o.id}, ${o.apiName}, ${o.label}, ${o.pluralLabel}, ${o.description},
            ${o.idPrefix}, ${o.displayField}, ${o.owned}, ${o.createdBy})`;
}

/** Changes an object's labels, description, visibility and display field. */
export async function updateObjectRow(tx: Tx, o: { id: string; label: string; pluralLabel: string; description: string; hidden: boolean;
  displayField: string | null }): Promise<void> {
  await tx`
    UPDATE objects SET label = ${o.label}, plural_label = ${o.pluralLabel},
      description = ${o.description}, hidden = ${o.hidden},
      display_field = ${o.displayField}, updated_at = now()
    WHERE id = ${o.id}`;
}

/** Adds a custom field. `defaultValue` is stored as JSON; undefined stores NULL. */
export async function insertCustomField(tx: Tx, f: { tenantId: string; id: string; objectId: string; apiName: string; storageKey: string;
  label: string; description: string; type: string; required: boolean; unique: boolean; defaultValue: unknown; validation: unknown;
  options: unknown; sensitivity: string; hidden: boolean; position: number; createdBy: string | null }): Promise<void> {
  await tx`
    INSERT INTO fields (tenant_id, id, object_id, api_name, storage_key, label, description, type, required, is_unique,
                        default_value, validation, options, sensitivity, hidden, position, created_by)
    VALUES (${f.tenantId}, ${f.id}, ${f.objectId}, ${f.apiName}, ${f.storageKey}, ${f.label},
            ${f.description}, ${f.type}, ${f.required}, ${f.unique},
            ${f.defaultValue === undefined ? null : tx.json(f.defaultValue as never)},
            ${tx.json(f.validation as never)}, ${tx.json(f.options as never)},
            ${f.sensitivity}, ${f.hidden}, ${f.position}, ${f.createdBy})`;
}

/** Fields an object has ever had, archived ones included. */
export async function countFieldsEver(tx: Tx, objectId: string): Promise<number> {
  const [ever] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM fields WHERE object_id = ${objectId}`;
  return ever?.n ?? 0;
}

/**
 * Changes a field's definition. `defaultValue` is null for no default (SQL NULL), or `{ json }` for a
 * default stored as JSON (which may be JSON null).
 */
export async function updateFieldRow(tx: Tx, f: { id: string; apiName: string; label: string; description: string; hidden: boolean; required: boolean;
  sensitivity: string; defaultValue: { json: unknown } | null; validation: unknown; options: unknown }): Promise<void> {
  await tx`
    UPDATE fields SET
      api_name = ${f.apiName},
      label = ${f.label},
      description = ${f.description},
      hidden = ${f.hidden},
      required = ${f.required},
      sensitivity = ${f.sensitivity},
      default_value = ${f.defaultValue === null ? null : tx.json(f.defaultValue.json as never)},
      validation = ${tx.json(f.validation as never)},
      options = ${tx.json(f.options as never)},
      updated_at = now()
    WHERE id = ${f.id}`;
}

/** Archives a field. */
export async function archiveFieldRow(tx: Tx, fieldId: string): Promise<void> {
  await tx`UPDATE fields SET archived_at = now() WHERE id = ${fieldId}`;
}

/** Records linking somewhere through a custom relation field. */
export async function countLinkingRecords(tx: Tx, fieldId: string): Promise<number> {
  const [r] = await tx<{ n: number }[]>`SELECT count(DISTINCT from_id)::int AS n FROM record_links WHERE field_id = ${fieldId}`;
  return r?.n ?? 0;
}

/** Changes a field's type, with its new default (null for none, otherwise stored as JSON), options and validation. */
export async function retypeFieldRow(tx: Tx, f: { id: string; type: string; defaultValue: unknown; options: unknown; validation: unknown }): Promise<void> {
  await tx`UPDATE fields SET type = ${f.type}, default_value = ${f.defaultValue === null ? null : tx.json(f.defaultValue as never)},
             options = ${tx.json(f.options as never)}, validation = ${tx.json(f.validation as never)}, updated_at = now()
           WHERE id = ${f.id}`;
}

export interface ViewDefinitionRow { name: string; shared: boolean; definition: { where?: unknown; sort?: { field?: unknown }[]; group_by?: { field?: unknown }[] } }

/** An object's saved views (at most 1,000), by name. */
export async function viewsOfObject(tx: Tx, objectId: string): Promise<ViewDefinitionRow[]> {
  return tx<ViewDefinitionRow[]>`
    SELECT name, shared, definition FROM views WHERE object_id = ${objectId} ORDER BY name LIMIT 1000`;
}

/** Sets which modules the workspace has turned on. */
export async function setWorkspaceModules(tx: Tx, modules: string[]): Promise<void> {
  await tx`UPDATE tenants SET modules = ${modules}`;
}

// --- describe_object --------------------------------------------------------------------------------

/** Activity types, standard ones first. */
export async function activityTypeList(tx: Tx): Promise<{ key: string; label: string; editable: boolean }[]> {
  return tx<{ key: string; label: string; editable: boolean }[]>`SELECT key, label, editable FROM activity_types ORDER BY is_system DESC, key`;
}

/** Active members by name, at most 100, for picking an owner or assignee. */
export async function activeMembersForPicking(tx: Tx): Promise<{ id: string; name: string; email: string }[]> {
  return tx<{ id: string; name: string; email: string }[]>`SELECT id, name, email FROM users WHERE disabled_at IS NULL ORDER BY name LIMIT 100`;
}
