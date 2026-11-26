import { SimpleTable } from "@/features/settings/SettingsLayout";
import { Badge } from "@/components/ui/misc";
import type { FieldMeta, ObjectMeta, ObjectSummary } from "@/lib/api/types";
import { formatRelative } from "@/lib/format";
import { optionLabel } from "@/meta/fields";
import { neverChanged, originLabel, originOf, surfaceLabel, typeLabel } from "./model";

const sensitivity = (f: FieldMeta) => (f.sensitivity === "restricted" ? <Badge tone="danger">Restricted</Badge> : f.sensitivity === "confidential" ? <Badge tone="warning">Confidential</Badge> : <span className="text-muted">Normal</span>);

function typeText(f: FieldMeta, objects: ObjectSummary[]) {
  if (f.type === "relation" && f.relation) {
    const to = f.relation.to === "user" ? "Member" : (objects.find((o) => o.name === f.relation!.to)?.label ?? f.relation.to);
    return `Relation → ${to}${f.relation.cardinality === "many_to_many" ? " (many)" : ""}`;
  }
  return typeLabel(f.type);
}

/** The fields of one object. Last change is shown only when the server sent it (audit:read callers, once a field was changed). */
export function FieldsTable({ meta, objects, who }: { meta: ObjectMeta; objects: ObjectSummary[]; who: (actor: string) => string }) {
  return (
    <div className="p-4">
      <SimpleTable label={`${meta.label} fields`} head={["Field", "API name", "Type", "Required", "Sensitivity", "Origin", "Last change", "Your access"]}>
        {meta.fields.map((f) => {
          const origin = originOf(f);
          const last = f.last_change;
          const never = last ? null : neverChanged(f);
          return (
            <tr key={f.name}>
              <td className="px-4 py-2 font-medium">{f.label}{f.hidden ? <Badge className="ml-2">Hidden</Badge> : null}</td>
              <td className="px-4 py-2"><code className="font-mono text-xs text-muted">{f.name}</code></td>
              <td className="px-4 py-2 text-sm text-muted">{typeText(f, objects)}
                {f.values?.length ? <span className="block text-xs">{f.values.slice(0, 6).map((v) => optionLabel(f, v.key)).join(", ")}{f.values.length > 6 ? "…" : ""}</span> : null}</td>
              <td className="px-4 py-2 text-sm"><span className="text-muted">{f.required ? "Yes" : "—"}</span>
                {f.unique || f.read_only || f.create_only ? <span className="mt-0.5 flex flex-wrap gap-1">
                  {f.unique ? <Badge>unique</Badge> : null}{f.read_only ? <Badge>system</Badge> : null}{f.create_only ? <Badge>set on create</Badge> : null}
                </span> : null}</td>
              <td className="px-4 py-2 text-sm">{sensitivity(f)}</td>
              <td className="px-4 py-2"><Badge tone={origin.origin === "custom" ? "info" : origin.origin === "pack" ? "warning" : "neutral"}>{originLabel(origin)}</Badge></td>
              <td className="px-4 py-2 text-sm text-muted">
                {last ? <>
                  <p>{who(last.actor)} · {surfaceLabel(last.surface)}{last.via ? ` · ${last.via}` : ""}{last.pack ? ` · ${last.pack} pack` : ""}</p>
                  <p className="text-xs text-subtle">{formatRelative(last.changed_at)}</p>
                </> : never}
              </td>
              <td className="px-4 py-2 text-sm">{f.access === "none" ? "hidden" : f.access === "read" ? "read only" : "read and write"}</td>
            </tr>
          );
        })}
      </SimpleTable>
    </div>
  );
}
