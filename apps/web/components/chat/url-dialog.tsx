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
  onReturnFocus?: (() => void) | undefined;
  open: boolean;
}

const SCHEME_WITH_SLASHES_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const SPECIAL_SCHEME_REGEX = /^(?:javascript|data|file|mailto|about|blob):/i;
const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
const TLD_REGEX = /^[a-zA-Z]{2,}$/;
const PUNYCODE_TLD_REGEX = /^xn--[a-zA-Z0-9]+$/;
const DOMAIN_LABEL_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function isHostValid(hostname: string): boolean {
  if (!hostname) {
    return false;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return true;
  }
  if (IPV4_REGEX.test(hostname)) {
    const parts = hostname.split(".").map(Number);
    return parts.every((p) => p >= 0 && p <= 255);
  }
  const parts = hostname.split(".");
  if (parts.length < 2) {
    return false;
  }
  return parts.every((p, idx) => {
    if (!p) {
      return false;
    }
    if (idx === parts.length - 1) {
      return TLD_REGEX.test(p) || PUNYCODE_TLD_REGEX.test(p);
    }
    return DOMAIN_LABEL_REGEX.test(p);
  });
}

export function normalizeAndValidateUrl(rawUrl: string): {
  error?: string;
  url?: string;
  valid: boolean;
} {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { error: "Please enter a web URL.", valid: false };
  }

  if (SPECIAL_SCHEME_REGEX.test(trimmed)) {
    return {
      error: "URL protocol must be HTTP or HTTPS.",
      valid: false,
    };
  }

  let candidate: string;
  if (SCHEME_WITH_SLASHES_REGEX.test(trimmed)) {
    candidate = trimmed;
  } else {
    const isLocal =
      trimmed.startsWith("localhost") ||
      trimmed.startsWith("127.0.0.1") ||
      trimmed.startsWith("[::1]");
    candidate = isLocal ? `http://${trimmed}` : `https://${trimmed}`;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        error: "URL protocol must be HTTP or HTTPS.",
        valid: false,
      };
    }
    if (!isHostValid(parsed.hostname)) {
      return {
        error:
          "Please enter a valid web domain (e.g. https://example.com) or host.",
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

export function UrlDialog({
  open,
  onOpenChange,
  onAddUrl,
  onReturnFocus,
}: UrlDialogProps) {
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

  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      if (onReturnFocus) {
        event.preventDefault();
        onReturnFocus();
      }
    },
    [onReturnFocus]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={handleCloseAutoFocus}
      >
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
