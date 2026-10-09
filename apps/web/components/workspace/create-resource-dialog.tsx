"use client";
import type { OrganizationSummary } from "@reasonateai/contracts/auth";
import {
  ArrowRight,
  Building2,
  FolderPlus,
  LoaderCircle,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import "./create-resource-dialog.css";
export function CreateResourceDialog({
  kind,
  organizations,
  organizationId,
  onClose,
  onCreate,
  error,
}: {
  kind: "project" | "workspace";
  organizations: OrganizationSummary[];
  organizationId: string;
  onClose: () => void;
  onCreate: (name: string, organizationId: string) => Promise<boolean>;
  error: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const busyRef = useRef<boolean>(false);
  const [name, setName] = useState("");
  const [targetId, setTargetId] = useState(
    () =>
      organizations.find(
        (item) =>
          item.organizationId === organizationId &&
          ["owner", "admin", "builder"].includes(item.role)
      )?.organizationId ??
      organizations.find((item) =>
        ["owner", "admin", "builder"].includes(item.role)
      )?.organizationId ??
      ""
  );
  const [busy, setBusy] = useState(false);
  const available = organizations.filter((item) =>
    ["owner", "admin", "builder"].includes(item.role)
  );
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) {
      element.showModal();
      input.current?.focus();
    }
    return () => {
      element?.close();
    };
  }, []);
  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (busyRef.current || !name.trim()) {
        return;
      }
      busyRef.current = true;
      setBusy(true);
      try {
        if (await onCreate(name.trim(), targetId)) {
          onClose();
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [name, onClose, onCreate, targetId]
  );
  const cancel = useCallback(
    (event: React.SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      if (!busyRef.current) {
        onClose();
      }
    },
    [onClose]
  );
  const updateName = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setName(event.currentTarget.value),
    []
  );
  const updateWorkspace = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) =>
      setTargetId(event.currentTarget.value),
    []
  );
  const submitLabel =
    kind === "project" ? "Create project" : "Create workspace";

  return (
    <dialog
      aria-describedby="creation-description"
      aria-labelledby="creation-title"
      className="creation-dialog"
      onCancel={cancel}
      ref={dialog}
    >
      <button
        aria-label="Close creation dialog"
        className="creation-close"
        disabled={busy}
        onClick={onClose}
        type="button"
      >
        <X size={19} />
      </button>
      <div className="creation-icon">
        {kind === "project" ? (
          <FolderPlus size={23} />
        ) : (
          <Building2 size={23} />
        )}
      </div>
      <span className="creation-eyebrow">
        {kind === "project" ? "A NEW BEGINNING" : "ROOM TO GROW"}
      </span>
      <h2 id="creation-title">
        {kind === "project" ? "Create a project" : "Create a workspace"}
      </h2>
      <p id="creation-description">
        {kind === "project"
          ? "Give your next idea a place to take shape. Your CTO will build alongside you."
          : "Keep a team or a new venture in its own space. Each workspace has separate projects and permissions."}
      </p>
      <form onSubmit={submit}>
        <label htmlFor="creation-name">
          {kind === "project" ? "Project name" : "Workspace name"}
        </label>
        <input
          disabled={busy}
          id="creation-name"
          maxLength={120}
          onChange={updateName}
          placeholder={kind === "project" ? "My next big idea" : "Acme studio"}
          ref={input}
          required
          value={name}
        />
        {kind === "project" && (
          <>
            <label htmlFor="creation-workspace">Workspace</label>
            <select
              disabled={busy}
              id="creation-workspace"
              onChange={updateWorkspace}
              required
              value={targetId}
            >
              {available.map((item) => (
                <option key={item.organizationId} value={item.organizationId}>
                  {item.name}
                </option>
              ))}
            </select>
            <p className="creation-hint">
              Projects belong to one workspace. Its members' permissions apply.
            </p>
          </>
        )}
        {error && (
          <p className="creation-error" role="alert">
            {error}
          </p>
        )}
        {kind === "project" && available.length === 0 && (
          <p role="status">
            Your role does not allow creating projects. Ask a workspace owner
            for access.
          </p>
        )}
        <footer>
          <button
            className="creation-cancel"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="creation-submit"
            disabled={
              busy ||
              !name.trim() ||
              (kind === "project" &&
                !available.some((item) => item.organizationId === targetId))
            }
            type="submit"
          >
            {busy ? "Creating…" : submitLabel}
            {busy ? <LoaderCircle size={16} /> : <ArrowRight size={16} />}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
