import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import type { Role } from "@/lib/api/types";

/** The key a copy starts with: the source's key plus _copy, within the 40 characters the API allows. */
export const copyKey = (key: string) => `${key.slice(0, 35)}_copy`;

/**
 * Duplicate a role or a permission set. The server copies the permissions and the object and field
 * rules (`copy_from`), so the copy is exactly what is shown; it needs only a new key and name.
 */
export function DuplicateDialog({ api: path, source, noun, onClose, onCreated }: {
  api: string; source: Role; noun: string; onClose: () => void; onCreated: (r: Role) => void;
}) {
  const api = useApi();
  const [key, setKey] = useState(copyKey(source.key));
  const [name, setName] = useState(`${source.name} copy`);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async () => (await api.post<{ data: Role }>(path, { key: key.trim(), name: name.trim(), copy_from: source.key })).data,
    onSuccess: onCreated,
    onError: (e) => setError(asProblem(e).detail),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Duplicate ${source.name}`} description={`Makes a new ${noun} with the same permissions and rules. You can change it afterwards.`}
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="duplicate-form" busy={create.isPending} disabled={!name.trim() || !key.trim()}>Duplicate</Button></>}>
        <form id="duplicate-form" className="grid gap-3.5" onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate();
        }}>
          {error ? <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-base text-danger-fg">{error}</p> : null}
          <FormField label="Name" required>{(p) => <Input {...p} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</FormField>
          <FormField label="Key" required hint="2 to 40 lowercase letters, digits or underscores">{(p) => <Input {...p} value={key} pattern="[a-z][a-z0-9_]{1,39}" onChange={(e) => setKey(e.target.value)} />}</FormField>
        </form>
      </DialogContent>
    </Dialog>
  );
}
