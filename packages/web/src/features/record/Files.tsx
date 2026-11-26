import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Paperclip, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { apiUrl, seg } from "@/lib/api/client";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import type { FileInfo } from "@/lib/api/types";
import { formatBytes, formatRelative } from "@/lib/format";
import { qk } from "@/lib/keys";

interface Limits { max_bytes: number; quota_bytes: number | null; max_files_per_record: number }

/** The files attached to one record, with attaching and removing for those who can change the record. */
export function useFiles(recordId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk.files(recordId), enabled,
    queryFn: async ({ signal }) => (await api.get<{ data: FileInfo[] }>(`/v1/records/${seg(recordId)}/files`, undefined, signal)).data,
  });
}

/**
 * A record's files. `compact` is the form used under a note: a plain list with a small attach button.
 * Files are always downloaded, never opened in the page: the server sends every one as an attachment.
 */
export function Files({ recordId, canWrite, compact = false, label = "Files" }: { recordId: string; canWrite: boolean; compact?: boolean; label?: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const files = useFiles(recordId);
  const limits = useQuery({ queryKey: ["file-limits"], staleTime: Infinity, queryFn: async ({ signal }) => (await api.get<{ data: Limits }>("/v1/files/limits", undefined, signal)).data });
  const input = useRef<HTMLInputElement>(null);
  const [removing, setRemoving] = useState<FileInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: qk.files(recordId) });

  const attach = useMutation({
    mutationFn: async (chosen: File[]) => {
      const max = limits.data?.max_bytes;
      for (const f of chosen) {
        // Checked here first, so a file that is too large isn't sent only to be refused.
        if (max !== undefined && f.size > max) throw new Error(`${f.name} is larger than ${formatBytes(max)}, the most one file may be.`);
        if (f.size === 0) throw new Error(`${f.name} is empty.`);
        await api.upload<{ data: FileInfo }>(`/v1/records/${seg(recordId)}/files`, f, { name: f.name });
      }
      return chosen.length;
    },
    onSuccess: (n) => {
      setProblem(null);
      toast.toast({ tone: "success", title: n === 1 ? "File attached" : `${n} files attached` });
    },
    onError: (e) => setProblem(e instanceof Error && !("status" in e) ? e.message : asProblem(e).detail),
    onSettled: () => {
      void refresh();
      if (input.current) input.current.value = "";
    },
  });
  const remove = useMutation({
    mutationFn: (f: FileInfo) => api.delete(`/v1/files/${seg(f.id)}`),
    onSuccess: () => {
      setRemoving(null);
      void refresh();
      toast.toast({ tone: "success", title: "File removed" });
    },
    onError: (e) => {
      setRemoving(null);
      toast.error(e, "Couldn't remove the file");
    },
  });

  const picker = canWrite ? (
    <>
      <input ref={input} type="file" multiple className="sr-only" aria-label={`Attach files to ${label.toLowerCase()}`} tabIndex={-1}
        onChange={(e) => e.target.files?.length && attach.mutate([...e.target.files])} />
      <Button size="sm" variant={compact ? "ghost" : undefined} busy={attach.isPending} onClick={() => input.current?.click()}>
        {compact ? <Paperclip /> : <Upload />} {compact ? "Attach" : "Attach files"}
      </Button>
    </>
  ) : null;
  const list = files.isPending ? <Skeleton className="h-8" />
    : files.error ? <ProblemView error={files.error} onRetry={() => files.refetch()} compact />
    : files.data.length === 0 ? (compact ? null : <p className="text-base text-muted">No files yet.</p>)
    : (
      <ul className="flex flex-col divide-y divide-line">
        {files.data.map((f) => (
          <li key={f.id} className="flex items-center gap-2 py-1.5">
            <FileText className="size-4 shrink-0 text-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <a href={apiUrl(`/v1/files/${seg(f.id)}/content`)} download={f.name} className="block truncate text-base font-medium hover:underline"><bdi>{f.name}</bdi></a>
              <p className="text-sm text-subtle">{formatBytes(f.size)} · added {formatRelative(f.created_at)}</p>
            </div>
            <Button asChild size="icon-sm" variant="subtle" aria-label={`Download ${f.name}`}><a href={apiUrl(`/v1/files/${seg(f.id)}/content`)} download={f.name}><Download /></a></Button>
            {canWrite ? <Button size="icon-sm" variant="subtle" aria-label={`Remove ${f.name}`} onClick={() => setRemoving(f)}><Trash2 /></Button> : null}
          </li>
        ))}
      </ul>
    );
  const alert = problem ? <p role="alert" className="mb-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-base text-danger-fg">{problem}</p> : null;
  const confirm = (
    <ConfirmDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)} danger busy={remove.isPending} confirmLabel="Remove file"
      title={`Remove ${removing?.name ?? "this file"}?`} description="The file is deleted and can't be brought back." onConfirm={() => removing && remove.mutate(removing)} />
  );

  if (compact) {
    return <div className="mt-2">{alert}{list}{picker ? <div className="mt-1">{picker}</div> : null}{confirm}</div>;
  }
  return (
    <section aria-label={label} className="rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h2 className="flex-1 text-md font-semibold">{label}{files.data?.length ? <span className="ml-2 text-sm font-normal text-subtle">{files.data.length}</span> : null}</h2>
        {picker}
      </div>
      <div className="px-4 py-3">{alert}{list}</div>
      {confirm}
    </section>
  );
}
