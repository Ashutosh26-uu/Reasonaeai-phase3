"use client";

import { X } from "lucide-react";
import { useCallback, useState } from "react";
import { describeError, request } from "@/lib/product-api";

export interface SettingsProps {
  onClose: () => void;
  /** Called with the new name once the server has committed it. */
  onRenamed: () => void;
  organizationId: string;
  organizationName: string;
}

/**
 * Workspace settings.
 *
 * One real decision today — what this workspace is called — because a tenant's
 * name is the first thing a person wants to change and the product's own
 * default is a guess. Everything else the panel shows is read-only and says so
 * rather than offering a control that does nothing.
 */
export function Settings({
  onClose,
  onRenamed,
  organizationId,
  organizationName,
}: SettingsProps) {
  const [name, setName] = useState(organizationName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const change = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setName(event.currentTarget.value);
    setSaved(false);
  }, []);

  const save = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = name.trim();
      if (trimmed.length === 0 || trimmed === organizationName) {
        return;
      }
      setSaving(true);
      setError("");
      try {
        await request(`/v1/organizations/${organizationId}`, (value) => value, {
          body: JSON.stringify({ name: trimmed }),
          method: "PATCH",
        });
        setSaved(true);
        onRenamed();
      } catch (cause) {
        setError(describeError(cause, "Could not rename the workspace."));
      } finally {
        setSaving(false);
      }
    },
    [name, onRenamed, organizationId, organizationName]
  );

  return (
    <div className="sheet-backdrop" role="presentation">
      <div aria-label="Workspace settings" className="sheet" role="dialog">
        <div className="sheet-head">
          <h2>Settings</h2>
          <button
            aria-label="Close settings"
            className="panel-close"
            onClick={onClose}
            type="button"
          >
            <X size={15} />
          </button>
        </div>

        <form className="sheet-form" onSubmit={save}>
          <label className="sheet-label" htmlFor="organization-name">
            Workspace name
          </label>
          <p className="sheet-note">
            This is the tenant your projects, runs, and checkpoints belong to.
          </p>
          <div className="sheet-row">
            <input
              className="sheet-input"
              id="organization-name"
              maxLength={120}
              onChange={change}
              value={name}
            />
            <button
              className="sheet-save"
              disabled={saving || name.trim() === organizationName}
              type="submit"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          {error.length > 0 && <p className="sheet-error">{error}</p>}
          {saved && <p className="sheet-saved">Saved.</p>}
        </form>

        <div className="sheet-block">
          <div className="sheet-label">Model</div>
          <p className="sheet-note">
            Every run executes on an open-weight model behind the runtime's
            provider router. The identifier is pinned per deployment, not per
            conversation.
          </p>
        </div>
      </div>
    </div>
  );
}
