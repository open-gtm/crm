import type { MemberUser } from "@/lib/api/types";

export interface MemberFilter { search: string; role: string; status: "" | "active" | "disabled" }

/** Filters the members already loaded: name or email contains the search, role and status match. */
export function filterMembers(users: MemberUser[], f: MemberFilter): MemberUser[] {
  const q = f.search.trim().toLowerCase();
  return users.filter((m) =>
    (!q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
    && (!f.role || m.role === f.role)
    && (!f.status || (f.status === "active") === m.active));
}
