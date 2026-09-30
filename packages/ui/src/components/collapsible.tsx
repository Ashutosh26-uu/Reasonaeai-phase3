"use client";

import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import type { ComponentProps } from "react";

export function Collapsible(
  props: ComponentProps<typeof CollapsiblePrimitive.Root>
) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}
export function CollapsibleTrigger(
  props: ComponentProps<typeof CollapsiblePrimitive.Trigger>
) {
  return (
    <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />
  );
}
export function CollapsibleContent(
  props: ComponentProps<typeof CollapsiblePrimitive.Content>
) {
  return (
    <CollapsiblePrimitive.Content data-slot="collapsible-content" {...props} />
  );
}
