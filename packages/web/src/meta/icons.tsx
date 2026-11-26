import {
  Activity, Bookmark, Box, Briefcase, Building2, Calendar, CheckSquare, CircleDollarSign, ClipboardList, FileText, FolderKanban, Handshake,
  Home, Layers, Link2, MapPin, Package, Receipt, Shapes, Sparkles, Tag, Ticket, Truck, User, Users, type LucideIcon,
} from "lucide-react";

const STANDARD: Record<string, LucideIcon> = {
  contact: User, account: Building2, lead: Sparkles, deal: Handshake, task: CheckSquare, activity: Activity,
  account_contact: Link2, deal_contact: Users, quote: FileText, order: Receipt, quote_line_item: Layers, order_line_item: Layers,
};

/** Words in a custom object's name or label that suggest an icon. */
const KEYWORDS: [RegExp, LucideIcon][] = [
  [/propert|house|home|listing|real.?estate/, Home], [/project|board|sprint/, FolderKanban], [/ticket|issue|case|support/, Ticket],
  [/product|item|sku|inventory/, Package], [/invoice|receipt|payment|bill/, Receipt], [/event|meeting|booking|appointment|reservation/, Calendar],
  [/location|site|place|address|venue/, MapPin], [/contract|agreement|document|doc|policy/, FileText], [/shipment|delivery|order/, Truck],
  [/job|position|role|hire|candidate/, Briefcase], [/subscription|plan|price|quote|revenue/, CircleDollarSign], [/survey|form|checklist/, ClipboardList],
  [/tag|label|category/, Tag], [/team|member|people|partner|vendor|supplier/, Users],
];
const FALLBACK: LucideIcon[] = [Box, Layers, Shapes, Bookmark];

/** An icon for an object: fixed ones for standard objects, a guess from the name for custom ones, else a stable pick. */
export function objectIcon(o: { name: string; label?: string }): LucideIcon {
  if (Object.hasOwn(STANDARD, o.name)) return STANDARD[o.name]!;
  const text = `${o.name} ${o.label ?? ""}`.toLowerCase();
  for (const [re, icon] of KEYWORDS) if (re.test(text)) return icon;
  let h = 0;
  for (const ch of o.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK[h % FALLBACK.length]!;
}

export function ObjectIcon({ object, className }: { object: { name: string; label?: string }; className?: string }) {
  const Icon = objectIcon(object);
  return <Icon aria-hidden className={className ?? "size-4"} />;
}
