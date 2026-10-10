import { cn } from "cn";
import type * as React from "react";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "min-h-[48px] w-full min-w-0 rounded-[12px] border border-[var(--border)] bg-transparent px-[18px] py-[14px] font-mono text-[var(--text)] text-sm shadow-none outline-none transition-colors selection:bg-[var(--lime)]/30 selection:text-[var(--text)] file:inline-flex file:h-7 file:border-0 file:bg-transparent file:font-mono file:text-xs placeholder:text-[var(--text-faint)] focus-visible:border-[var(--lime)] focus-visible:outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40",
        className
      )}
      data-slot="input"
      type={type}
      {...props}
    />
  );
}

export { Input };
