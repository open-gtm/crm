import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { useTheme, type ThemeChoice } from "@/lib/theme";

/**
 * A miniature of the app drawn only with tokens. The `dark` class on the wrapper makes the tokens
 * resolve to their dark values inside it, whichever theme the page itself is in.
 */
function Mini({ dark }: { dark: boolean }) {
  return (
    <span aria-hidden className={cn(dark && "dark", "flex h-full min-w-0 flex-1 bg-bg")}>
      <span className="flex w-1/4 flex-col gap-1 border-r border-line bg-surface-2 p-1.5">
        <span className="h-1 rounded-sm bg-accent" />
        <span className="h-1 rounded-sm bg-line-strong" />
        <span className="h-1 rounded-sm bg-line-strong" />
      </span>
      <span className="flex flex-1 flex-col gap-1 p-1.5">
        <span className="h-1.5 w-1/2 rounded-sm bg-fg" />
        <span className="flex-1 rounded-sm border border-line bg-surface" />
      </span>
    </span>
  );
}

const CHOICES: { value: ThemeChoice; label: string; hint: string }[] = [
  { value: "system", label: "System", hint: "Matches your device" },
  { value: "light", label: "Light", hint: "Always light" },
  { value: "dark", label: "Dark", hint: "Always dark" },
];

/** Three cards for the theme preference (saved to the member's account by the theme provider). */
export function ThemeCards() {
  const theme = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className="grid max-w-xl gap-3 sm:grid-cols-3">
      {CHOICES.map((c) => {
        const on = theme.choice === c.value;
        return (
          <button key={c.value} type="button" role="radio" aria-checked={on} onClick={() => theme.setChoice(c.value)}
            className={cn("press flex flex-col gap-2 rounded-lg border p-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
              on ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong")}>
            <span aria-hidden className="flex h-16 overflow-hidden rounded-md border border-line">
              {c.value === "system" ? <><Mini dark={false} /><Mini dark /></> : <Mini dark={c.value === "dark"} />}
            </span>
            <span className="flex items-center justify-between gap-2 px-0.5">
              <span>
                <span className={cn("block text-base font-medium", on && "text-accent-soft-fg")}>{c.label}</span>
                <span className="block text-sm text-muted">{c.hint}</span>
              </span>
              {on ? <Check className="size-4 shrink-0 text-accent-soft-fg" aria-hidden /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
