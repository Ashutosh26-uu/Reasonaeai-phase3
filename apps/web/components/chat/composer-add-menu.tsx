"use client";

import type { ProjectSummary } from "@reasonateai/contracts/auth";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@reasonateai/ui/components/dropdown-menu";
import { AtSign, Folder, Paperclip, Pencil, Plus } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import {
  PromptInputButton,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import styles from "./composer.module.css";
import { SketchEditor } from "./sketch-editor";

export function ComposerAddMenu({
  busy,
  filesAvailable,
  onErrorClear,
  onOpenFiles,
  onProjectSelect,
  projectId,
  projectPickerDisabled,
  projects,
}: {
  busy: boolean;
  filesAvailable: boolean;
  onErrorClear: () => void;
  onOpenFiles: () => void;
  onProjectSelect: (projectId: string) => void;
  projectId: string;
  projectPickerDisabled: boolean;
  projects: ProjectSummary[];
}) {
  const [open, setOpen] = useState(false);
  const [sketchOpen, setSketchOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { add, files, openFileDialog } = usePromptInputAttachments();
  const sketch = useCallback(() => setSketchOpen(true), []);
  const returnFocus = useCallback(() => trigger.current?.focus(), []);
  const attachSketch = useCallback(
    async (file: File) => {
      if (busy) {
        throw new Error(
          "Wait for the current message to finish sending, then attach the sketch."
        );
      }
      if (files.length >= 5) {
        throw new Error(
          "Remove an attachment before adding this sketch (five files maximum)."
        );
      }
      if (file.size > 4 * 1024 * 1024) {
        throw new Error(
          "The sketch is larger than 4 MiB. Remove some detail and try again."
        );
      }
      const sizes = await Promise.all(
        files.map(async (item) => {
          if (!(item.url.startsWith("blob:") || item.url.startsWith("data:"))) {
            throw new Error(
              "An attachment could not be read. Remove it and add it again."
            );
          }
          const response = await fetch(item.url);
          if (!response.ok) {
            throw new Error(
              "An attachment could not be read. Remove it and add it again."
            );
          }
          return (await response.blob()).size;
        })
      );
      if (
        sizes.reduce((sum, size) => sum + size, file.size) >
        12 * 1024 * 1024
      ) {
        throw new Error(
          "Attachments must total 12 MiB or less. Remove a file before adding the sketch."
        );
      }
      onErrorClear();
      add([file]);
    },
    [add, busy, files, onErrorClear]
  );
  const attach = useCallback(() => {
    onErrorClear();
    openFileDialog();
  }, [onErrorClear, openFileDialog]);
  const project = projects.find((item) => item.projectId === projectId);

  return (
    <>
      <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
        <DropdownMenuTrigger asChild>
          <PromptInputButton
            aria-label="Add to message"
            className={`prompt-mic ${styles.attach}`}
            disabled={busy}
            ref={trigger}
            type="button"
          >
            <Plus aria-hidden="true" size={20} />
          </PromptInputButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          aria-label="Add to message"
          className={styles.addMenu}
          collisionPadding={16}
          side="top"
          sideOffset={12}
        >
          <DropdownMenuLabel className={styles.addMenuLabel}>
            Add
          </DropdownMenuLabel>
          <DropdownMenuItem className={styles.addMenuItem} onSelect={attach}>
            <Paperclip aria-hidden="true" />
            <span>Files</span>
            <span className={styles.addMenuDescription}>
              Images and documents
            </span>
          </DropdownMenuItem>
          {filesAvailable && (
            <DropdownMenuItem
              className={styles.addMenuItem}
              onSelect={onOpenFiles}
            >
              <AtSign aria-hidden="true" />
              <span>Mention a file</span>
              <span className={styles.addMenuDescription}>Project files</span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className={styles.addMenuItem} onSelect={sketch}>
            <Pencil aria-hidden="true" />
            <span>Sketch</span>
            <span className={styles.addMenuDescription}>Draw a sketch</span>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              className={styles.addMenuItem}
              disabled={projectPickerDisabled}
            >
              <Folder aria-hidden="true" />
              <span>Work in a project</span>
              <span className={styles.addMenuDescription}>{project?.name}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              className={`${styles.addMenu} ${styles.projectMenu}`}
            >
              <DropdownMenuLabel className={styles.addMenuLabel}>
                Projects
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                onValueChange={onProjectSelect}
                value={projectId}
              >
                {projects.map((item) => (
                  <DropdownMenuRadioItem
                    className={styles.addMenuItem}
                    key={item.projectId}
                    value={item.projectId}
                  >
                    {item.name}
                  </DropdownMenuRadioItem>
                ))}
                <DropdownMenuRadioItem className={styles.addMenuItem} value="">
                  Don’t work in a project
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
      <SketchEditor
        onAttach={attachSketch}
        onOpenChange={setSketchOpen}
        onReturnFocus={returnFocus}
        open={sketchOpen}
      />
    </>
  );
}
