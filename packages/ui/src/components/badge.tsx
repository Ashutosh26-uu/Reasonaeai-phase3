import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";
import type * as React from "react";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border border-[var(--border-strong)] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors focus-visible:border-[var(--lime)] focus-visible:outline-none [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default:
          "border-[var(--border-strong)] bg-[rgba(255,255,255,0.06)] text-[var(--text)] backdrop-blur-md",
        destructive:
          "border-[var(--orange)]/40 bg-[rgba(255,77,0,0.1)] text-[var(--orange)]",
        ghost: "border-transparent bg-transparent text-[var(--text-muted)]",
        link: "border-transparent text-[var(--lime)] underline-offset-4 hover:underline",
        outline:
          "border-[var(--border-strong)] bg-transparent text-[var(--text)]",
        secondary:
          "border-[var(--border)] bg-[rgba(255,255,255,0.04)] text-[var(--text-muted)]",
      },
    },
  }
);

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      className={cn(badgeVariants({ variant }), className)}
      data-slot="badge"
      data-variant={variant}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
