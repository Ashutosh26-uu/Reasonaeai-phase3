"use client";

import { Button } from "@reasonateai/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@reasonateai/ui/components/dialog";
import { Input } from "@reasonateai/ui/components/input";
import { Globe, Link2 } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";

export interface UrlDialogProps {
  onAddUrl: (url: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

const SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function normalizeAndValidateUrl(rawUrl: string): {
  error?: string;
  url?: string;
  valid: boolean;
} {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { error: "Please enter a web URL.", valid: false };
  }

  const hasScheme = SCHEME_REGEX.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        error: "URL protocol must be HTTP or HTTPS.",
        valid: false,
      };
    }
    if (!parsed.hostname?.includes(".")) {
      return {
        error: "Please enter a valid web domain (e.g. https://example.com).",
        valid: false,
      };
    }
    return { url: parsed.toString(), valid: true };
  } catch {
    return {
      error: "Please enter a valid HTTP or HTTPS URL.",
      valid: false,
    };
  }
}

export function UrlDialog({ open, onOpenChange, onAddUrl }: UrlDialogProps) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const resetState = useCallback(() => {
    setUrl("");
    setTitle("");
    setError(null);
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        resetState();
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, resetState]
  );

  const handleUrlChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setUrl(e.target.value);
      setError(null);
    },
    []
  );

  const handleTitleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setTitle(e.target.value);
    },
    []
  );

  const handleCancel = useCallback(() => {
    handleOpenChange(false);
  }, [handleOpenChange]);

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const validation = normalizeAndValidateUrl(url);
      if (!(validation.valid && validation.url)) {
        setError(validation.error ?? "Invalid URL.");
        return;
      }

      const trimmedTitle = title.trim();
      const formatted = trimmedTitle
        ? `[${trimmedTitle}](${validation.url})`
        : validation.url;

      onAddUrl(formatted);
      handleOpenChange(false);
    },
    [handleOpenChange, onAddUrl, title, url]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
              <Globe className="size-4" />
            </div>
            <DialogTitle>Add URL Reference</DialogTitle>
          </div>
          <DialogDescription>
            Attach a web page, documentation link, or repository URL into your
            CTO prompt draft.
          </DialogDescription>
        </DialogHeader>

        <form
          aria-label="Add URL reference"
          className="space-y-4 py-2"
          onSubmit={handleSubmit}
        >
          <div className="space-y-1.5">
            <label
              className="font-medium text-foreground text-sm leading-none"
              htmlFor="composer-url-input"
            >
              Web URL <span className="text-destructive">*</span>
            </label>
            <Input
              aria-describedby={error ? "composer-url-error" : undefined}
              aria-invalid={Boolean(error)}
              autoFocus
              id="composer-url-input"
              onChange={handleUrlChange}
              placeholder="https://docs.example.com/api..."
              type="text"
              value={url}
            />
            {error && (
              <p
                className="font-medium text-destructive text-xs"
                id="composer-url-error"
                role="alert"
              >
                {error}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label
              className="font-medium text-foreground text-sm leading-none"
              htmlFor="composer-url-title"
            >
              Link Title (Optional)
            </label>
            <Input
              id="composer-url-title"
              onChange={handleTitleChange}
              placeholder="e.g. Next.js Routing Docs"
              type="text"
              value={title}
            />
            <p className="text-muted-foreground text-xs">
              If provided, the URL will be formatted as markdown link text.
            </p>
          </div>

          <DialogFooter className="pt-2 sm:justify-end">
            <Button onClick={handleCancel} type="button" variant="outline">
              Cancel
            </Button>
            <Button className="gap-1.5" type="submit">
              <Link2 className="size-4" />
              Add to Prompt
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
