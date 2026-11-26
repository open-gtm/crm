/**
 * "Your team": which Home a member sees. A UI preference (key `home.team` in /v1/me/preferences), chosen in
 * personal settings. It decides what Home shows first and nothing else: every number and list on Home is
 * still asked for with the member's own access, so a team is never a grant.
 */
export const TEAM_PREF = "home.team";
/** View IDs pinned to Home, in order (key `home.pinned`). */
export const PINNED_VIEWS_PREF = "home.pinned";
export const MAX_PINNED_VIEWS = 8;

export const TEAMS = [
  { key: "sales", label: "Sales" },
  { key: "marketing", label: "Marketing" },
  // Tickets come from the support-desk pack: offered only in a workspace that has the ticket object.
  { key: "support", label: "Customer support", needsObject: "ticket" },
  { key: "finance", label: "Finance", needsObject: "quote" },
  { key: "ops", label: "Operations", needsObject: "order" },
  // What an admin watches: automations, changes, and agent and API activity. Offered with audit:read.
  { key: "admin", label: "Admin", needsPermission: "audit:read" },
] as const;
export type TeamKey = (typeof TEAMS)[number]["key"];

/** The stored team, or null for anything else (unset, or a value from a newer or older version). */
export const teamOf = (value: unknown): TeamKey | null => (TEAMS.some((t) => t.key === value) ? (value as TeamKey) : null);
