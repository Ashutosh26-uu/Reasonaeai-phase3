"use client";

import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FolderClosed,
  FolderOpen,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

export interface FileTreeEntry {
  bytes: number;
  kind: "directory" | "file";
  path: string;
}

export interface FileTreeNode extends FileTreeEntry {
  children: FileTreeNode[];
  name: string;
}

/** Synthesize missing parent directories; preserve full paths as file identity. */
export function buildFileTree(entries: FileTreeEntry[]): FileTreeNode[] {
  const nodes = new Map<string, FileTreeNode>();
  const roots: FileTreeNode[] = [];
  const insert = (
    path: string,
    kind: FileTreeEntry["kind"],
    bytes: number
  ): FileTreeNode => {
    const existing = nodes.get(path);
    if (existing) {
      return existing;
    }
    const parts = path.split("/");
    const name = parts.pop() ?? path;
    const node: FileTreeNode = { bytes, children: [], kind, name, path };
    nodes.set(path, node);
    if (parts.length > 0) {
      insert(parts.join("/"), "directory", 0).children.push(node);
    } else {
      roots.push(node);
    }
    return node;
  };
  for (const entry of entries) {
    insert(entry.path, entry.kind, entry.bytes);
  }
  const sort = (children: FileTreeNode[]) => {
    children.sort((left, right) => {
      if (left.kind === right.kind) {
        return left.name.localeCompare(right.name);
      }
      return left.kind === "directory" ? -1 : 1;
    });
    for (const child of children) {
      sort(child.children);
    }
  };
  sort(roots);
  return roots;
}

interface BranchProps {
  depth: number;
  node: FileTreeNode;
  onOpen: (path: string) => void;
  selected: string | undefined;
}

const Branch = memo(function FileTreeBranch({
  depth,
  node,
  onOpen,
  selected,
}: BranchProps) {
  const directory = node.kind === "directory";
  const [open, setOpen] = useState(depth === 0);
  const groupId = useId();
  useEffect(() => {
    if (selected?.startsWith(`${node.path}/`)) {
      setOpen(true);
    }
  }, [node.path, selected]);
  const choose = useCallback(() => {
    if (directory) {
      setOpen((value) => !value);
    } else {
      onOpen(node.path);
    }
  }, [directory, node.path, onOpen]);
  const FolderIcon = open ? FolderOpen : FolderClosed;
  const Icon = directory ? FolderIcon : FileCode2;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div role="none">
      <button
        aria-expanded={directory ? open : undefined}
        aria-owns={directory && open ? groupId : undefined}
        aria-selected={!directory && selected === node.path}
        className="files-row"
        data-active={selected === node.path || undefined}
        data-depth={depth}
        data-kind={node.kind}
        data-path={node.path}
        onClick={choose}
        role="treeitem"
        style={{ paddingInlineStart: 8 + depth * 16 }}
        tabIndex={
          selected === node.path || (selected === undefined && depth === 0)
            ? 0
            : -1
        }
        title={node.path}
        type="button"
      >
        {directory ? (
          <Chevron aria-hidden="true" size={12} />
        ) : (
          <span className="files-tree-spacer" />
        )}
        <Icon aria-hidden="true" size={14} />
        <span className="files-name">{node.name}</span>
      </button>
      {directory && open && (
        <fieldset
          aria-label={node.name}
          className="files-tree-group"
          id={groupId}
        >
          {node.children.map((child) => (
            <Branch
              depth={depth + 1}
              key={child.path}
              node={child}
              onOpen={onOpen}
              selected={selected}
            />
          ))}
        </fieldset>
      )}
    </div>
  );
});

function horizontalTreeKey(
  target: HTMLButtonElement,
  buttons: HTMLButtonElement[],
  index: number,
  key: string
): HTMLButtonElement | undefined {
  const expanded = target.getAttribute("aria-expanded");
  if (
    (key === "ArrowRight" && expanded === "false") ||
    (key === "ArrowLeft" && expanded === "true")
  ) {
    target.click();
    return;
  }
  if (key === "ArrowRight") {
    return buttons.at(index + 1);
  }
  const depth = Number(target.dataset.depth);
  return buttons
    .slice(0, index)
    .findLast((button) => Number(button.dataset.depth) < depth);
}

export const FileTree = memo(function WorkspaceFileTree({
  entries,
  onOpen,
  selected,
}: {
  entries: FileTreeEntry[];
  onOpen: (path: string) => void;
  selected: string | undefined;
}) {
  const roots = useMemo(() => buildFileTree(entries), [entries]);
  const root = useRef<HTMLDivElement>(null);
  const keys = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLButtonElement)) {
      return;
    }
    const buttons = Array.from(
      root.current?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') ??
        []
    );
    const index = buttons.indexOf(event.target);
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown") {
      next = buttons.at(index + 1);
    } else if (event.key === "ArrowUp") {
      next = index > 0 ? buttons.at(index - 1) : undefined;
    } else if (event.key === "Home") {
      next = buttons.at(0);
    } else if (event.key === "End") {
      next = buttons.at(-1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      next = horizontalTreeKey(event.target, buttons, index, event.key);
    } else {
      return;
    }
    event.preventDefault();
    next?.focus();
  }, []);
  return (
    <div
      aria-label="Workspace files"
      className="files-tree-group"
      onKeyDown={keys}
      ref={root}
      role="tree"
    >
      {roots.map((node) => (
        <Branch
          depth={0}
          key={node.path}
          node={node}
          onOpen={onOpen}
          selected={selected}
        />
      ))}
    </div>
  );
});
