import { cn } from "cn";
import type * as React from "react";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "field-sizing-content flex min-h-16 w-full rounded-[12px] border border-[var(--border)] bg-transparent px-[18px] py-[14px] font-sans text-[var(--text)] text-sm shadow-none outline-none transition-colors selection:bg-[var(--lime)]/30 selection:text-[var(--text)] placeholder:text-[var(--text-faint)] focus-visible:border-[var(--lime)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-[var(--orange)] md:text-sm",
        className
      )}
      data-slot="textarea"
      {...props}
    />
  );
}

export { Textarea };
