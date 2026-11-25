import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ProblemView } from "@/components/feedback";
import { Skeleton, Switch } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import { useSession } from "@/lib/session";
import { Section, useAdmin } from "./SettingsLayout";

interface Settings { quote_requires_deal: boolean; accept_quote_marks_deal_won: boolean }

const ROWS: { key: keyof Settings; label: string; on: string; off: string }[] = [
  { key: "quote_requires_deal", label: "Quotes are made for a deal",
    on: "Every quote belongs to a deal and takes its account, contact and name from it.",
    off: "A quote can also stand alone, for an account or a contact, with no deal." },
  { key: "accept_quote_marks_deal_won", label: "Accepting a quote marks its deal won",
    on: "When a quote is accepted, its deal moves to the pipeline's first won stage.",
    off: "Accepting a quote makes the order and leaves the deal's stage as it is." },
];

/** How quotes behave in this workspace. Anyone can see it; changing it needs permission to manage the schema. */
export function CommerceSettings() {
  const s = useSession();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useAdmin<{ data: Settings }>(["commerce-settings"], "/v1/commerce-settings");
  const editable = s.can("schema:manage");
  const save = useMutation({
    mutationFn: (patch: Partial<Settings>) => api.patch<{ data: Settings }>("/v1/commerce-settings", patch),
    onSuccess: (r) => {
      qc.setQueryData(["admin", "commerce-settings", {}], r);
      toast.toast({ tone: "success", title: "Setting saved" });
    },
    onError: (e) => toast.error(e, "Couldn't save the setting"),
  });
  return (
    <Section title="Quotes and orders" description="A quote is priced by its lines, sent, and accepted, which makes an order. These settings change how that works here.">
      {q.isPending ? <Skeleton className="h-20" /> : q.error ? <ProblemView error={q.error} onRetry={() => q.refetch()} compact /> : (
        <ul className="flex flex-col divide-y divide-line">
          {ROWS.map((row) => (
            <li key={row.key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <Switch checked={q.data.data[row.key]} disabled={!editable || save.isPending} aria-label={row.label}
                onCheckedChange={(v) => save.mutate({ [row.key]: v })} className="mt-0.5" />
              <div className="min-w-0">
                <p className="text-base font-medium">{row.label}</p>
                <p className="text-sm text-muted">{q.data.data[row.key] ? row.on : row.off}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editable ? null : <p className="mt-3 text-sm text-subtle">Changing these needs permission to manage the schema.</p>}
    </Section>
  );
}
