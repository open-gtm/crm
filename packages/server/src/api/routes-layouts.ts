import { z } from "zod";
import { getLayout, resetLayout, setLayout } from "../core/layouts.js";
import { route } from "./registry.js";
import { data, list, nullable, object, S } from "./responses.js";

// --- Record page layouts (core/layouts.ts) ----------------------------------------------------

const Layout = object({
  object: S.str,
  custom: { type: "boolean", description: "False when no layout is set: the record page is the default one, and sections is empty" },
  sections: list(object({ title: S.str, fields: { ...S.strs, description: "Field names, in order" } })),
  updated_at: nullable(S.time),
});

route({
  method: "GET", path: "/v1/objects/:object/layout", scope: "ops:read", tag: "schema",
  summary: "How the object's record page is arranged: sections of fields. Fields the layout leaves out are shown after its sections",
  response: data(Layout),
  handler: async ({ tx, ctx, params }) => ({ body: { data: await getLayout(tx, ctx, params.object!) } }),
});

route({
  method: "PUT", path: "/v1/objects/:object/layout", scope: "admin", permission: "schema:manage", tag: "schema",
  summary: "Arrange the object's record page: named sections, each an ordered list of field names. Replaces the layout it had",
  response: data(Layout),
  body: z.object({ sections: z.array(z.object({ title: z.string(), fields: z.array(z.string()).max(100) }).strict()).min(1).max(20) }).strict(),
  handler: async ({ tx, ctx, params, body }) => ({ body: { data: await setLayout(tx, ctx, params.object!, body) } }),
});

route({
  method: "DELETE", path: "/v1/objects/:object/layout", scope: "admin", permission: "schema:manage", tag: "schema",
  summary: "Remove the object's layout, so its record page is the default again",
  response: data(Layout),
  handler: async ({ tx, ctx, params }) => ({ body: { data: await resetLayout(tx, ctx, params.object!) } }),
});
