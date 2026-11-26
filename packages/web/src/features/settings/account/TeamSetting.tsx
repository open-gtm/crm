import { FormField, NativeSelect } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { usePrefs, useSetPrefs } from "@/lib/prefs";
import { useSession } from "@/lib/session";
import { useObjects } from "@/meta/hooks";
import { TEAM_PREF, TEAMS, teamOf } from "@/features/home/teams";

/**
 * "Your team": a preference that picks which Home is shown first. A team is offered only when the
 * workspace has the object it needs and the member holds the permission it needs.
 */
export function TeamSetting() {
  const s = useSession();
  const objects = useObjects();
  const prefs = usePrefs();
  const set = useSetPrefs();
  const toast = useToast();
  const names = new Set((objects.data ?? []).map((o) => o.name));
  const available = TEAMS.filter((t) => {
    const needsObject = "needsObject" in t ? t.needsObject : undefined;
    const needsPermission = "needsPermission" in t ? t.needsPermission : undefined;
    return (!needsObject || names.has(needsObject)) && (!needsPermission || s.can(needsPermission));
  });
  const stored = teamOf(prefs.data?.[TEAM_PREF]);
  const value = stored && available.some((t) => t.key === stored) ? stored : "";
  return (
    <div className="grid max-w-md gap-2">
      <FormField label="Your team" hint="This only changes what Home shows first. It never changes what you can open or edit.">
        {(p) => (
          <NativeSelect {...p} value={value} disabled={prefs.isPending}
            onChange={(e) => set.mutate({ [TEAM_PREF]: e.target.value || null }, { onError: (err) => toast.error(err, "Couldn't save your team") })}>
            <option value="">No team</option>
            {available.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </NativeSelect>
        )}
      </FormField>
    </div>
  );
}
