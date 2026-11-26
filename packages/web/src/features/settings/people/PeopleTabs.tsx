import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";

const tab = "-mb-px inline-flex items-center border-b-2 px-2.5 py-1.5 text-base focus-visible:outline-2 focus-visible:outline-focus";

/** Members and Roles & permission sets are two pages of one area; these links move between the existing routes. */
export function PeopleTabs({ current }: { current: "members" | "roles" }) {
  const s = useSession();
  return (
    <nav aria-label="People and access" className="mb-4 flex gap-1 border-b border-line">
      {s.can("members:manage") ? (
        <Link to="/settings/members" aria-current={current === "members" ? "page" : undefined}
          className={cn(tab, current === "members" ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg")}>Members</Link>
      ) : null}
      <Link to="/settings/roles" aria-current={current === "roles" ? "page" : undefined}
        className={cn(tab, current === "roles" ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg")}>Roles &amp; permission sets</Link>
    </nav>
  );
}
