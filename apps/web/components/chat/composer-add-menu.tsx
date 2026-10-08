"use client";

import {
  PromptAttachMenu,
  type PromptAttachMenuProps,
} from "./prompt-attach-menu";

export type ComposerAddMenuProps = PromptAttachMenuProps;

export function ComposerAddMenu(props: ComposerAddMenuProps) {
  return <PromptAttachMenu {...props} />;
}
