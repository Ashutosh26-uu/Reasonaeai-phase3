"use client";

import { cn } from "@reasonateai/ui/lib/utils";
import type { CSSProperties, ElementType } from "react";
import { memo } from "react";
import styles from "./shimmer.module.css";

// AI Elements Shimmer API/gradient, adapted to CSS instead of adding Motion.
// https://elements.ai-sdk.dev/components/shimmer (Apache-2.0)
export interface TextShimmerProps {
  as?: ElementType;
  children: string;
  className?: string;
  duration?: number;
  spread?: number;
}

export const Shimmer = memo(function ShimmerComponent({
  as: Component = "p",
  children,
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) {
  const style: CSSProperties & {
    "--shimmer-duration": string;
    "--shimmer-spread": string;
  } = {
    "--shimmer-duration": `${duration}s`,
    "--shimmer-spread": `${children.length * spread}px`,
  };
  return (
    <Component className={cn(styles.shimmer, className)} style={style}>
      {children}
    </Component>
  );
});
