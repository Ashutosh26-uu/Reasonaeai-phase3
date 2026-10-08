"use client";

import { Badge } from "@reasonateai/ui/components/badge";
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
import {
  FileCode,
  FilePlus,
  FileText,
  FolderTree,
  Globe,
  RotateCcw,
  Search,
  SearchCode,
  ShieldCheck,
  Terminal,
  Wrench,
} from "lucide-react";
import type React from "react";
import { useCallback, useId, useMemo, useState } from "react";

export interface CtoRuntimeToolDefinition {
  category: "execution" | "filesystem" | "search" | "verification";
  defaultEnabled: boolean;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  id: string;
  name: string;
  runtimeToolName: string;
}

export const CTO_RUNTIME_TOOLS: readonly CtoRuntimeToolDefinition[] = [
  {
    category: "execution",
    defaultEnabled: true,
    description:
      "Runs shell commands, builds, package managers, and verification tasks in the isolated sandbox.",
    icon: Terminal,
    id: "execute_command",
    name: "Terminal Execution",
    runtimeToolName: "execute_command",
  },
  {
    category: "filesystem",
    defaultEnabled: true,
    description:
      "Reads source code, configuration files, manifests, and documentation across the project workspace.",
    icon: FileText,
    id: "read_file",
    name: "Read Files",
    runtimeToolName: "read_file",
  },
  {
    category: "filesystem",
    defaultEnabled: true,
    description:
      "Performs hash-anchored, multi-line surgical code modifications to existing source files.",
    icon: FileCode,
    id: "edit_file",
    name: "Code Editor",
    runtimeToolName: "edit_file",
  },
  {
    category: "filesystem",
    defaultEnabled: true,
    description:
      "Creates new source files, templates, boilerplate modules, and directory assets.",
    icon: FilePlus,
    id: "write_file",
    name: "Write Files",
    runtimeToolName: "write_file",
  },
  {
    category: "filesystem",
    defaultEnabled: true,
    description:
      "Discovers directory listings, globs files, and traverses workspace directory hierarchies.",
    icon: FolderTree,
    id: "list_files",
    name: "Directory Discovery",
    runtimeToolName: "list_files",
  },
  {
    category: "search",
    defaultEnabled: true,
    description:
      "Executes fast ripgrep regular expression searches and literal pattern lookups across files.",
    icon: SearchCode,
    id: "grep",
    name: "Codebase Search",
    runtimeToolName: "grep",
  },
  {
    category: "verification",
    defaultEnabled: true,
    description:
      "Drives headless browser sessions, takes visual screenshots, and asserts UI DOM state.",
    icon: Globe,
    id: "browser_verify",
    name: "Browser Verification",
    runtimeToolName: "browser_verify",
  },
  {
    category: "verification",
    defaultEnabled: true,
    description:
      "Runs automated unit and integration test suites with self-debugging repair orchestration.",
    icon: ShieldCheck,
    id: "test_execution",
    name: "Test Runner & Repair",
    runtimeToolName: "test_execution",
  },
];

export interface ToolsDialogProps {
  onOpenChange: (open: boolean) => void;
  onResetDefaults?: (() => void) | undefined;
  onToggleTool?: ((toolId: string, enabled: boolean) => void) | undefined;
  open: boolean;
  selectedTools?: string[] | undefined;
}

interface ToolRowProps {
  isEnabled: boolean;
  onToggle: (toolId: string) => void;
  tool: CtoRuntimeToolDefinition;
}

function ToolRow({ tool, isEnabled, onToggle }: ToolRowProps) {
  const IconComponent = tool.icon;

  const handleToggle = useCallback(() => {
    onToggle(tool.id);
  }, [onToggle, tool.id]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onToggle(tool.id);
      }
    },
    [onToggle, tool.id]
  );

  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card p-4 shadow-xs transition-all hover:border-border/80 hover:bg-accent/20">
      <div className="flex items-start gap-3.5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-foreground">
          <IconComponent className="size-5 text-foreground" />
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-card-foreground text-sm">
              {tool.name}
            </span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {tool.runtimeToolName}
            </code>
            <Badge className="text-[10px] capitalize" variant="outline">
              {tool.category}
            </Badge>
          </div>
          <p className="max-w-md text-muted-foreground text-xs leading-relaxed">
            {tool.description}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2.5 pt-1">
        <span
          className={`font-medium text-xs ${
            isEnabled ? "text-primary" : "text-muted-foreground"
          }`}
        >
          {isEnabled ? "Active" : "Disabled"}
        </span>
        <button
          aria-checked={isEnabled}
          aria-label={`Toggle ${tool.name}`}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
            isEnabled ? "bg-primary" : "bg-muted-foreground/30"
          }`}
          onClick={handleToggle}
          onKeyDown={handleKeyDown}
          role="switch"
          type="button"
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-background shadow-xs ring-0 transition duration-200 ease-in-out ${
              isEnabled ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </div>
    </div>
  );
}

export function ToolsDialog({
  open,
  onOpenChange,
  selectedTools,
  onToggleTool,
  onResetDefaults,
}: ToolsDialogProps) {
  const [search, setSearch] = useState("");
  const [internalSelected, setInternalSelected] = useState<Set<string>>(
    () =>
      new Set(
        CTO_RUNTIME_TOOLS.filter((t) => t.defaultEnabled).map((t) => t.id)
      )
  );

  const searchId = useId();

  const currentSelectedSet = useMemo(() => {
    if (selectedTools !== undefined) {
      return new Set(selectedTools);
    }
    return internalSelected;
  }, [internalSelected, selectedTools]);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleClearSearch = useCallback(() => {
    setSearch("");
  }, []);

  const handleDone = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleToggle = useCallback(
    (toolId: string) => {
      const isCurrentlyEnabled = currentSelectedSet.has(toolId);
      const nextState = !isCurrentlyEnabled;

      if (selectedTools === undefined) {
        setInternalSelected((prev) => {
          const next = new Set(prev);
          if (nextState) {
            next.add(toolId);
          } else {
            next.delete(toolId);
          }
          return next;
        });
      }

      onToggleTool?.(toolId, nextState);
    },
    [currentSelectedSet, onToggleTool, selectedTools]
  );

  const handleResetToDefaults = useCallback(() => {
    const defaultSet = new Set(
      CTO_RUNTIME_TOOLS.filter((t) => t.defaultEnabled).map((t) => t.id)
    );
    if (selectedTools === undefined) {
      setInternalSelected(defaultSet);
    }
    onResetDefaults?.();
    for (const tool of CTO_RUNTIME_TOOLS) {
      if (currentSelectedSet.has(tool.id) !== tool.defaultEnabled) {
        onToggleTool?.(tool.id, tool.defaultEnabled);
      }
    }
  }, [currentSelectedSet, onResetDefaults, onToggleTool, selectedTools]);

  const handleEnableAll = useCallback(() => {
    const allSet = new Set(CTO_RUNTIME_TOOLS.map((t) => t.id));
    if (selectedTools === undefined) {
      setInternalSelected(allSet);
    }
    for (const tool of CTO_RUNTIME_TOOLS) {
      if (!currentSelectedSet.has(tool.id)) {
        onToggleTool?.(tool.id, true);
      }
    }
  }, [currentSelectedSet, onToggleTool, selectedTools]);

  const filteredTools = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) {
      return CTO_RUNTIME_TOOLS;
    }
    return CTO_RUNTIME_TOOLS.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.runtimeToolName.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q)
    );
  }, [search]);

  const activeCount = CTO_RUNTIME_TOOLS.filter((t) =>
    currentSelectedSet.has(t.id)
  ).length;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden border-border bg-background p-0 shadow-2xl sm:max-w-2xl md:max-w-3xl">
        <DialogHeader className="sticky top-0 z-10 space-y-4 border-border border-b bg-background/95 p-6 pb-4 text-left backdrop-blur-md">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted/60 text-foreground">
                <Wrench className="size-4 text-foreground" />
              </div>
              <div>
                <DialogTitle className="font-bold text-2xl tracking-tight">
                  CTO Runtime Tools
                </DialogTitle>
                <DialogDescription className="mt-0.5 text-muted-foreground text-sm">
                  Active capabilities granted to the ReasonateAI CTO runtime for
                  this project workspace.
                </DialogDescription>
              </div>
            </div>
          </div>

          <div className="flex flex-col justify-between gap-3 pt-2 sm:flex-row sm:items-center">
            <div className="relative max-w-sm flex-1">
              <Search
                aria-hidden="true"
                className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="Search tools"
                className="h-9 rounded-full bg-muted/40 pl-9 transition-all focus-visible:ring-1"
                id={searchId}
                onChange={handleSearchChange}
                placeholder="Search tools by name or description..."
                type="search"
                value={search}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                className="h-8 gap-1 text-xs"
                onClick={handleResetToDefaults}
                size="sm"
                variant="outline"
              >
                <RotateCcw className="size-3" />
                Reset Defaults
              </Button>
              <Button
                className="h-8 text-xs"
                onClick={handleEnableAll}
                size="sm"
                variant="secondary"
              >
                Enable All
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-foreground text-sm">
                Capability Matrix
              </h3>
              <Badge className="font-normal text-xs" variant="secondary">
                {activeCount} of {CTO_RUNTIME_TOOLS.length} Active
              </Badge>
            </div>
            <span className="font-mono text-muted-foreground text-xs">
              @reasonateai/cto-runtime
            </span>
          </div>

          <div className="space-y-3">
            {filteredTools.map((tool) => (
              <ToolRow
                isEnabled={currentSelectedSet.has(tool.id)}
                key={tool.id}
                onToggle={handleToggle}
                tool={tool}
              />
            ))}
          </div>

          {filteredTools.length === 0 && (
            <div className="py-12 text-center text-muted-foreground">
              <p className="text-sm">
                No runtime tools found matching "{search}"
              </p>
              <Button
                className="mt-3 text-xs"
                onClick={handleClearSearch}
                size="sm"
                variant="outline"
              >
                Clear search filter
              </Button>
            </div>
          )}
        </div>

        <DialogFooter className="border-border border-t bg-muted/20 p-4 sm:justify-between">
          <p className="text-muted-foreground text-xs">
            Tool permissions are enforced via short-lived sandbox grants.
          </p>
          <Button onClick={handleDone} size="sm" variant="outline">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
