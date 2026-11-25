import type { Tx } from "../db/pool.js";
import { forbidden, unprocessable } from "../lib/errors.js";
import { assertObject } from "./access.js";
import { audit } from "./audit.js";
import { can, type Ctx } from "./context.js";
import { DISGUISING } from "./fieldtypes.js";
import { deletePageLayout, pageLayout, upsertPageLayout } from "./queries/layouts.js";
import { getObject, loadSchema, type ObjectMeta } from "./schema.js";

/**
 * Record page layouts: how the fields of an object's record page are arranged, as named sections of
 * ordered fields. One per object, for the whole workspace. A layout arranges; it grants nothing: a
 * field a member can't read stays hidden wherever the layout puts it, and a field the layout leaves
 * out is still shown (after the sections), so adding a field never needs the layout changed to be seen.
 */

export const LAYOUT_LIMITS = { sections: 20, fieldsPerSection: 100, title: 80 };

export interface LayoutSection { title: string; fields: string[] }
export interface LayoutOut {
  object: string;
  /** False: no layout is set, and the record page is the default one. */
  custom: boolean;
  sections: LayoutSection[];
  updated_at: string | null;
}

/** An object's layout by field name. Fields that were archived or removed since it was saved are left out. */
export async function getLayout(tx: Tx, ctx: Ctx, objectName: string): Promise<LayoutOut> {
  const obj = getObject(await loadSchema(tx), objectName);
  assertObject(ctx, obj, "read");
  const row = await pageLayout(tx, obj.id);
  if (!row) return { object: obj.api_name, custom: false, sections: [], updated_at: null };
  const byId = new Map(obj.fields.map((f) => [f.id, f.api_name]));
  return {
    object: obj.api_name, custom: true, updated_at: row.updated_at.toISOString(),
    sections: (row.layout.sections ?? []).map((s) => ({ title: s.title, fields: s.fields.map((id) => byId.get(id)).filter((n): n is string => n !== undefined) })),
  };
}

function checkSections(obj: ObjectMeta, raw: unknown): { title: string; fields: string[] }[] {
  if (!Array.isArray(raw) || raw.length === 0) throw unprocessable("sections must be a list with at least one section");
  if (raw.length > LAYOUT_LIMITS.sections) throw unprocessable(`A layout has at most ${LAYOUT_LIMITS.sections} sections`);
  const placed = new Set<string>();
  const titles = new Set<string>();
  return raw.map((s: unknown, i) => {
    if (typeof s !== "object" || s === null || Array.isArray(s)) throw unprocessable(`sections[${i}] must be an object with title and fields`);
    const { title, fields, ...rest } = s as Record<string, unknown>;
    if (Object.keys(rest).length) throw unprocessable(`sections[${i}]: unknown key "${Object.keys(rest)[0]}"`);
    const name = typeof title === "string" ? title.normalize("NFC").trim() : "";
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
    if (!name || name.length > LAYOUT_LIMITS.title || /[\x00-\x1f\x7f]/.test(name) || DISGUISING.test(name)) {
      throw unprocessable(`sections[${i}].title must be one line of 1 to ${LAYOUT_LIMITS.title} characters`);
    }
    if (titles.has(name.toLowerCase())) throw unprocessable(`Two sections are called "${name}"`);
    titles.add(name.toLowerCase());
    if (!Array.isArray(fields) || fields.some((f) => typeof f !== "string")) throw unprocessable(`sections[${i}].fields must be a list of field names`);
    if (fields.length > LAYOUT_LIMITS.fieldsPerSection) throw unprocessable(`A section has at most ${LAYOUT_LIMITS.fieldsPerSection} fields`);
    const ids = (fields as string[]).map((n) => {
      const f = obj.byName.get(n);
      if (!f) throw unprocessable(`sections[${i}]: "${n}" is not a field of ${obj.api_name}`);
      if (placed.has(f.id)) throw unprocessable(`"${n}" is in the layout twice`);
      placed.add(f.id);
      return f.id;
    });
    return { title: name, fields: ids };
  });
}

/** Sets an object's record page layout. Needs schema:manage: it changes what every member sees first. */
export async function setLayout(tx: Tx, ctx: Ctx, objectName: string, input: { sections?: unknown }): Promise<LayoutOut> {
  if (!can(ctx, "schema:manage")) throw forbidden("Changing a record page's layout needs the schema:manage permission");
  const obj = getObject(await loadSchema(tx), objectName);
  const sections = checkSections(obj, input.sections);
  await upsertPageLayout(tx, { tenantId: ctx.tenantId, objectId: obj.id, layout: { sections }, updatedBy: ctx.actor.id });
  await audit(tx, ctx, { action: "page_layout.updated", objectType: obj.api_name, details: { sections: sections.length, fields: sections.reduce((n, s) => n + s.fields.length, 0) } });
  return getLayout(tx, ctx, objectName);
}

/** Removes an object's layout: its record page is the default again. */
export async function resetLayout(tx: Tx, ctx: Ctx, objectName: string): Promise<LayoutOut> {
  if (!can(ctx, "schema:manage")) throw forbidden("Changing a record page's layout needs the schema:manage permission");
  const obj = getObject(await loadSchema(tx), objectName);
  if (await deletePageLayout(tx, obj.id)) await audit(tx, ctx, { action: "page_layout.reset", objectType: obj.api_name });
  return getLayout(tx, ctx, objectName);
}
