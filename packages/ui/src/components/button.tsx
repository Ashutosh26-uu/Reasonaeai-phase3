import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";
import type * as React from "react";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium font-sans text-sm tracking-normal outline-none transition-all duration-400 ease-[cubic-bezier(0.16,1,0.3,1)] hover:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3.5",
        icon: "size-9 rounded-full",
        "icon-lg": "size-10 rounded-full",
        "icon-sm": "size-8 rounded-full",
        "icon-xs": "size-6 rounded-full [&_svg:not([class*='size-'])]:size-3",
        lg: "h-11 px-6 py-2.5 has-[>svg]:px-5",
        sm: "h-8 gap-1.5 px-3 text-xs has-[>svg]:px-2.5",
        xs: "h-6 gap-1 px-2 text-[11px] has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
      },
      variant: {
        default:
          "border border-transparent bg-[var(--lime)] font-semibold text-[#050507] hover:bg-[#d6ff57]/90 active:scale-95",
        destructive:
          "border border-[var(--orange)] bg-transparent text-[var(--orange)] hover:bg-[var(--orange)]/10",
        ghost:
          "bg-transparent text-[var(--text)] hover:bg-[rgba(255,255,255,0.06)] hover:text-white",
        link: "text-[var(--lime)] underline-offset-4 hover:underline",
        outline:
          "border border-[var(--border)] bg-[rgba(255,255,255,0.06)] text-[var(--text)] backdrop-blur-[24px] hover:border-[var(--border-strong)] hover:bg-[rgba(255,255,255,0.09)]",
        secondary:
          "border border-[var(--border)] bg-[rgba(255,255,255,0.04)] text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[rgba(255,255,255,0.08)]",
      },
    },
  }
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      className={cn(buttonVariants({ className, size, variant }))}
      data-size={size}
      data-slot="button"
      data-variant={variant}
      {...props}
    />
  );
}

export { Button, buttonVariants };
