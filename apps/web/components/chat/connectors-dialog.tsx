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
  Bell,
  Check,
  CheckCircle2,
  FileText,
  FolderGit2,
  GitBranch,
  Kanban,
  Layers,
  LayoutGrid,
  MessageSquare,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type React from "react";
import { useCallback, useId, useMemo, useState } from "react";

export interface WorkspaceConnector {
  author: string;
  category: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  id: string;
  name: string;
  permissions: string[];
  status: "preview" | "planned";
  statusLabel: string;
  useCase: string;
  verified: boolean;
}

export const WORKSPACE_CONNECTORS: readonly WorkspaceConnector[] = [
  {
    author: "GitHub Inc.",
    category: "Version Control",
    description:
      "Inspect repository branches, pull request diffs, issues, and commit trees directly in your workspace.",
    icon: GitBranch,
    id: "github",
    name: "GitHub",
    permissions: ["repo:read", "pull_requests:read", "issues:read"],
    status: "preview",
    statusLabel: "Coming Soon",
    useCase: "Branch analysis, PR synchronization, and automated bug intake.",
    verified: true,
  },
  {
    author: "Atlassian",
    category: "Project Management",
    description:
      "Access Jira backlog issues, sprint items, and board tickets to align CTO implementations with team tasks.",
    icon: Kanban,
    id: "jira",
    name: "Jira",
    permissions: ["read:jira-work", "read:jira-user"],
    status: "planned",
    statusLabel: "Coming Soon",
    useCase: "Sprint backlog reading and issue requirement imports.",
    verified: true,
  },
  {
    author: "Linear Orbit",
    category: "Project Management",
    description:
      "Streamline task execution by linking Linear cycles, projects, and active tickets to workspace runs.",
    icon: Layers,
    id: "linear",
    name: "Linear",
    permissions: ["read", "issues:read"],
    status: "preview",
    statusLabel: "Coming Soon",
    useCase: "Ticket triage, cycle tracking, and acceptance verification.",
    verified: true,
  },
  {
    author: "Figma",
    category: "Design System",
    description:
      "Extract design tokens, layer trees, component properties, and layout specs to generate pixel-accurate code.",
    icon: LayoutGrid,
    id: "figma",
    name: "Figma",
    permissions: ["file:read", "variables:read"],
    status: "preview",
    statusLabel: "Coming Soon",
    useCase:
      "Design-to-code generation, CSS token alignment, and icon asset extraction.",
    verified: true,
  },
  {
    author: "Notion Labs",
    category: "Knowledge Base",
    description:
      "Search workspace docs, product specifications, architecture decision records, and technical specs.",
    icon: FileText,
    id: "notion",
    name: "Notion",
    permissions: ["read_content", "read_user_info"],
    status: "planned",
    statusLabel: "Coming Soon",
    useCase:
      "Product spec ingestion, architectural guide review, and roadmap lookup.",
    verified: true,
  },
  {
    author: "Slack Technologies",
    category: "Communication",
    description:
      "Bring thread discussions, technical decisions, and bug reports from Slack channels into run context.",
    icon: MessageSquare,
    id: "slack",
    name: "Slack",
    permissions: ["channels:history", "groups:history"],
    status: "planned",
    statusLabel: "Coming Soon",
    useCase: "Incident thread ingestion and real-time team context retrieval.",
    verified: true,
  },
  {
    author: "Google",
    category: "Cloud Storage",
    description:
      "Search and reference team documents, spreadsheets, and shared architecture assets in Google Drive.",
    icon: FolderGit2,
    id: "gdrive",
    name: "Google Drive",
    permissions: ["drive.readonly", "drive.metadata.readonly"],
    status: "planned",
    statusLabel: "Coming Soon",
    useCase:
      "PRD ingestion, architecture diagram reference, and shared asset access.",
    verified: true,
  },
];

export interface ConnectorsDialogProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

interface ConnectorCardProps {
  connector: WorkspaceConnector;
  onSelect: (connector: WorkspaceConnector) => void;
}

function ConnectorCard({ connector, onSelect }: ConnectorCardProps) {
  const IconComponent = connector.icon;

  const handleSelect = useCallback(() => {
    onSelect(connector);
  }, [connector, onSelect]);

  return (
    <div className="group relative flex flex-col justify-between rounded-xl border border-border bg-card p-4 shadow-xs transition-all hover:border-border/80 hover:bg-accent/20 hover:shadow-sm">
      <div>
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-foreground shadow-xs">
            <IconComponent className="size-5 text-foreground" />
          </div>
          <div className="flex items-center gap-1.5">
            <Badge className="text-[11px]" variant="outline">
              {connector.statusLabel}
            </Badge>
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <h4 className="font-semibold text-card-foreground text-sm">
              {connector.name}
            </h4>
            {connector.verified && (
              <CheckCircle2
                aria-label="Verified connector"
                className="size-3.5 text-primary"
              />
            )}
          </div>
          <p className="line-clamp-2 text-muted-foreground text-xs leading-relaxed">
            {connector.description}
          </p>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between border-border/60 border-t pt-3">
        <span className="font-medium text-[11px] text-muted-foreground/75">
          {connector.category}
        </span>
        <Button
          aria-label={`View details for ${connector.name}`}
          className="h-7 px-2.5 text-xs"
          onClick={handleSelect}
          size="sm"
          variant="ghost"
        >
          Details
        </Button>
      </div>
    </div>
  );
}

export function ConnectorsDialog({
  open,
  onOpenChange,
}: ConnectorsDialogProps) {
  const [search, setSearch] = useState("");
  const [selectedConnector, setSelectedConnector] =
    useState<WorkspaceConnector | null>(null);
  const [notifiedConnectors, setNotifiedConnectors] = useState<Set<string>>(
    () => new Set()
  );
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [requestServiceName, setRequestServiceName] = useState("");
  const [requestNotes, setRequestNotes] = useState("");
  const [requestSubmitted, setRequestSubmitted] = useState<string | null>(null);

  const searchId = useId();

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleClearSearch = useCallback(() => {
    setSearch("");
  }, []);

  const handleOpenRequestModal = useCallback(() => {
    setRequestModalOpen(true);
  }, []);

  const handleCloseRequestModal = useCallback(() => {
    setRequestModalOpen(false);
  }, []);

  const handleRequestServiceNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setRequestServiceName(e.target.value);
    },
    []
  );

  const handleRequestNotesChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setRequestNotes(e.target.value);
    },
    []
  );

  const handleCloseDetails = useCallback(() => {
    setSelectedConnector(null);
  }, []);

  const handleDetailsOpenChange = useCallback((openDetails: boolean) => {
    if (!openDetails) {
      setSelectedConnector(null);
    }
  }, []);

  const handleRequestModalOpenChange = useCallback((reqOpen: boolean) => {
    setRequestModalOpen(reqOpen);
    if (!reqOpen) {
      setRequestSubmitted(null);
    }
  }, []);

  const filteredConnectors = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) {
      return WORKSPACE_CONNECTORS;
    }
    return WORKSPACE_CONNECTORS.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q)
    );
  }, [search]);

  const toggleNotification = useCallback((connectorId: string) => {
    setNotifiedConnectors((prev) => {
      const next = new Set(prev);
      if (next.has(connectorId)) {
        next.delete(connectorId);
      } else {
        next.add(connectorId);
      }
      return next;
    });
  }, []);

  const handleToggleCurrentNotification = useCallback(() => {
    if (selectedConnector) {
      toggleNotification(selectedConnector.id);
    }
  }, [selectedConnector, toggleNotification]);

  const handleRequestSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const service = requestServiceName.trim();
      if (!service) {
        return;
      }
      setRequestSubmitted(service);
      setRequestServiceName("");
      setRequestNotes("");
      setTimeout(() => {
        setRequestModalOpen(false);
        setRequestSubmitted(null);
      }, 1800);
    },
    [requestServiceName]
  );

  return (
    <>
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden border-border bg-background p-0 shadow-2xl sm:max-w-3xl md:max-w-4xl">
          <DialogHeader className="sticky top-0 z-10 space-y-4 border-border border-b bg-background/95 p-6 pb-4 text-left backdrop-blur-md">
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle className="font-bold text-2xl tracking-tight">
                  Workspace Connectors
                </DialogTitle>
                <DialogDescription className="mt-1 text-muted-foreground text-sm">
                  Preview external integrations planned for workspace runs.
                  Brokered securely via centralized OAuth without secret
                  leakage.
                </DialogDescription>
              </div>
            </div>

            <div className="flex flex-col justify-between gap-3 pt-2 sm:flex-row sm:items-center">
              <div className="relative max-w-sm flex-1">
                <Search
                  aria-hidden="true"
                  className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  aria-label="Search connectors"
                  className="h-9 rounded-full bg-muted/40 pl-9 transition-all focus-visible:ring-1"
                  id={searchId}
                  onChange={handleSearchChange}
                  placeholder="Search connectors by name, category, or author..."
                  type="search"
                  value={search}
                />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  className="h-9 gap-1.5 rounded-full px-4 text-xs"
                  onClick={handleOpenRequestModal}
                  size="sm"
                  variant="outline"
                >
                  <Plus className="size-3.5" />
                  Request Integration
                </Button>
              </div>
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto p-6">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-foreground text-sm">
                  Integrations Directory
                </h3>
                <Badge className="font-normal text-xs" variant="secondary">
                  {filteredConnectors.length} Available
                </Badge>
              </div>
              <span className="text-muted-foreground text-xs">
                Phase 4 Roadmap Previews
              </span>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredConnectors.map((connector) => (
                <ConnectorCard
                  connector={connector}
                  key={connector.id}
                  onSelect={setSelectedConnector}
                />
              ))}
            </div>

            {filteredConnectors.length === 0 && (
              <div className="py-12 text-center text-muted-foreground">
                <p className="text-sm">
                  No connectors found matching "{search}"
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
        </DialogContent>
      </Dialog>

      {/* Connector Details Modal */}
      {selectedConnector && (
        <Dialog
          onOpenChange={handleDetailsOpenChange}
          open={Boolean(selectedConnector)}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-muted text-foreground">
                  <selectedConnector.icon className="size-5" />
                </div>
                <div>
                  <DialogTitle className="flex items-center gap-1.5 text-lg">
                    {selectedConnector.name}
                    {selectedConnector.verified && (
                      <CheckCircle2 className="size-4 text-primary" />
                    )}
                  </DialogTitle>
                  <p className="text-muted-foreground text-xs">
                    by {selectedConnector.author} • {selectedConnector.category}
                  </p>
                </div>
              </div>
              <DialogDescription className="pt-2 text-sm">
                {selectedConnector.description}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-2 text-xs">
              <div className="rounded-lg border border-border bg-muted/40 p-3">
                <span className="font-semibold text-foreground">
                  Workspace CTO Capability:
                </span>
                <p className="mt-1 text-muted-foreground">
                  {selectedConnector.useCase}
                </p>
              </div>

              <div>
                <span className="font-semibold text-foreground">
                  OAuth Authorization Scopes:
                </span>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {selectedConnector.permissions.map((perm) => (
                    <Badge
                      className="font-mono text-[11px]"
                      key={perm}
                      variant="secondary"
                    >
                      {perm}
                    </Badge>
                  ))}
                </div>
              </div>

              <div className="flex items-start gap-2 rounded-lg border border-border bg-card p-3">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
                <p className="text-[11px] text-muted-foreground leading-tight">
                  <strong className="text-foreground">
                    Security Invariant:
                  </strong>{" "}
                  Brokered via centralized authorization. Secrets and access
                  tokens never leak into agent prompt context or logs.
                </p>
              </div>

              {notifiedConnectors.has(selectedConnector.id) && (
                <div
                  className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/10 p-2.5 text-primary text-xs"
                  role="status"
                >
                  <Check className="size-3.5" />
                  <span>
                    Notification active: You will be alerted when this connector
                    is enabled for your organization.
                  </span>
                </div>
              )}
            </div>

            <DialogFooter className="sm:justify-between">
              <Button
                className="gap-1.5 text-xs"
                onClick={handleToggleCurrentNotification}
                size="sm"
                variant={
                  notifiedConnectors.has(selectedConnector.id)
                    ? "outline"
                    : "secondary"
                }
              >
                <Bell className="size-3.5" />
                {notifiedConnectors.has(selectedConnector.id)
                  ? "Remove Notification Alert"
                  : "Notify Me When Available"}
              </Button>
              <Button onClick={handleCloseDetails} size="sm" variant="outline">
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Request Integration Modal */}
      <Dialog
        onOpenChange={handleRequestModalOpenChange}
        open={requestModalOpen}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <Sparkles className="size-5 text-primary" />
              <DialogTitle>Request Workspace Integration</DialogTitle>
            </div>
            <DialogDescription>
              Suggest a third-party service or custom MCP provider for your CTO
              agents.
            </DialogDescription>
          </DialogHeader>

          {requestSubmitted ? (
            <div className="space-y-2 py-6 text-center" role="status">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Check className="size-5" />
              </div>
              <h4 className="font-semibold text-foreground text-sm">
                Request Submitted
              </h4>
              <p className="text-muted-foreground text-xs">
                We recorded your request for{" "}
                <strong className="text-foreground">{requestSubmitted}</strong>.
                Our team prioritizes integrations based on workspace demand.
              </p>
            </div>
          ) : (
            <form
              aria-label="Request workspace integration"
              className="space-y-4 py-2"
              onSubmit={handleRequestSubmit}
            >
              <div className="space-y-1.5">
                <label
                  className="font-medium text-foreground text-sm"
                  htmlFor="connector-req-name"
                >
                  Integration or Tool Name{" "}
                  <span className="text-destructive">*</span>
                </label>
                <Input
                  autoFocus
                  id="connector-req-name"
                  onChange={handleRequestServiceNameChange}
                  placeholder="e.g. Sentry, Datadog, Supabase..."
                  required
                  type="text"
                  value={requestServiceName}
                />
              </div>

              <div className="space-y-1.5">
                <label
                  className="font-medium text-foreground text-sm"
                  htmlFor="connector-req-notes"
                >
                  Use Case & Desired Capabilities (Optional)
                </label>
                <Input
                  id="connector-req-notes"
                  onChange={handleRequestNotesChange}
                  placeholder="e.g. Ingest live error traces during verification runs..."
                  type="text"
                  value={requestNotes}
                />
              </div>

              <DialogFooter className="pt-2 sm:justify-end">
                <Button
                  onClick={handleCloseRequestModal}
                  type="button"
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button disabled={!requestServiceName.trim()} type="submit">
                  Submit Request
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
