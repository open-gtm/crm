import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md font-medium select-none " +
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-50 " +
    "[&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "press bg-accent text-accent-fg hover:bg-accent-hover shadow-sm",
        secondary: "press border border-line bg-surface text-fg hover:bg-surface-2 shadow-sm",
        ghost: "press text-fg hover:bg-surface-2",
        subtle: "press text-muted hover:bg-surface-2 hover:text-fg",
        danger: "press bg-danger text-surface hover:opacity-90 shadow-sm",
        "danger-ghost": "press text-danger-fg hover:bg-danger-soft",
        link: "text-accent underline-offset-2 hover:underline px-0 h-auto transition-colors",
      },
      size: {
        sm: "h-7 px-2.5 text-sm",
        md: "h-8 px-3 text-base",
        lg: "h-10 px-4 text-md",
        icon: "size-8",
        "icon-sm": "size-7 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Shows a busy indicator and disables the button. */
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild, busy, disabled, children, type, ...props },
  ref,
) {
  const cls = cn(buttonVariants({ variant, size }), className);
  if (asChild) {
    return <Slot.Root ref={ref} className={cls} {...props}>{children}</Slot.Root>;
  }
  return (
    <button ref={ref} className={cls} disabled={disabled || busy} aria-busy={busy || undefined} type={type ?? "button"} {...props}>
      {busy ? <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" /> : null}
      {children}
    </button>
  );
});
