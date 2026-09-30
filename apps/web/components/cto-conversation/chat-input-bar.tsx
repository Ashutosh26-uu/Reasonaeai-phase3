"use client";

import { Button } from "@reasonateai/ui/components/button";
import { cn } from "@reasonateai/ui/lib/utils";
import { ArrowUp, Mic, Paperclip } from "lucide-react";
import type React from "react";
import { useCallback, useRef, useState } from "react";

export interface ChatInputBarProps {
  className?: string;
  disabled?: boolean;
  onSendMessage: (text: string) => void;
  placeholder?: string;
}

export function ChatInputBar({
  onSendMessage,
  disabled = false,
  placeholder = "Reply to the CTO or give instructions...",
  className,
}: ChatInputBarProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      const trimmed = text.trim();
      if (!trimmed || disabled) {
        return;
      }

      onSendMessage(trimmed);
      setText("");

      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    },
    [text, disabled, onSendMessage]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      e.target.style.height = "auto";
      e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
    },
    []
  );

  return (
    <form
      className={cn(
        "relative rounded-2xl border bg-card/90 p-2 shadow-sm transition-all focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/20",
        className
      )}
      onSubmit={handleSubmit}
    >
      <textarea
        className="max-h-48 w-full resize-none bg-transparent px-3 py-1.5 text-foreground text-sm outline-none placeholder:text-muted-foreground"
        disabled={disabled}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        ref={textareaRef}
        rows={1}
        value={text}
      />

      <div className="flex items-center justify-between border-border/40 border-t px-2 pt-2">
        <div className="flex items-center gap-1">
          <Button
            className="size-7 rounded-full text-muted-foreground hover:text-foreground"
            size="icon-sm"
            title="Voice input (speech-to-text)"
            type="button"
            variant="ghost"
          >
            <Mic className="size-4" />
          </Button>

          <Button
            className="size-7 rounded-full text-muted-foreground hover:text-foreground"
            size="icon-sm"
            title="Attach visual wireframe / architecture flowchart"
            type="button"
            variant="ghost"
          >
            <Paperclip className="size-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">
            Press Enter ↵
          </span>
          <Button
            className="size-8 rounded-full bg-primary text-primary-foreground shadow-xs transition-transform active:scale-95 disabled:opacity-40"
            disabled={disabled || !text.trim()}
            size="icon"
            type="submit"
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </div>
    </form>
  );
}
