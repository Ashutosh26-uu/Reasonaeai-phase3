"use client";

import {
  type AccountProfile,
  AccountProfileSchema,
  type OrganizationPlanUsage,
  OrganizationPlanUsageSchema,
  type SessionView,
} from "@reasonateai/contracts/auth";
import {
  Activity,
  Check,
  ChevronRight,
  CircleHelp,
  CreditCard,
  Laptop,
  LogOut,
  Moon,
  Sun,
  UserRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { describeError, request } from "@/lib/product-api";
import {
  applyThemePreference,
  readThemePreference,
  type ThemePreference,
} from "@/lib/theme";

type SettingsSection =
  | "account"
  | "appearance"
  | "workspace"
  | "plan"
  | "security";

const settingsSections: SettingsSection[] = [
  "account",
  "appearance",
  "workspace",
  "plan",
  "security",
];
const INITIALS_SEPARATOR = /[\s@._-]+/;

function isSettingsSection(value: string): value is SettingsSection {
  return settingsSections.some((item) => item === value);
}

export interface SettingsProps {
  onClose: () => void;
  onProfileUpdated: (profile: AccountProfile) => void;
  /** Called with the new name once the server has committed it. */
  onRenamed: (name: string) => void;
  onSignOut: () => Promise<void>;
  organizationId: string;
  organizationName: string;
  organizationRole: string;
  projectCount: number;
  session: SessionView;
}

const sectionLabels: Record<SettingsSection, string> = {
  account: "Account",
  appearance: "Appearance",
  plan: "Plan & usage",
  security: "Security",
  workspace: "Workspace",
};

function QuotaRow({
  label,
  used,
  limit,
  detail,
  formatValue = (value) => value.toLocaleString(),
}: {
  label: string;
  used: number;
  limit: number;
  detail?: string;
  formatValue?: (value: number) => string;
}) {
  return (
    <div className="settings-quota">
      <div className="settings-quota-head">
        <span>{label}</span>
        <span>
          {formatValue(used)} / {formatValue(limit)}
          {detail ? ` ${detail}` : ""}
        </span>
      </div>
      <progress
        aria-label={`${label}: ${formatValue(used)} of ${formatValue(limit)}`}
        className="settings-quota-track"
        max={limit}
        value={Math.min(used, limit)}
      />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  if (bytes < 1024 ** 3) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unavailable"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This page intentionally composes five independent preference panels from one selected section.
export function Settings({
  onClose,
  onProfileUpdated,
  onRenamed,
  onSignOut,
  organizationId,
  organizationName,
  organizationRole,
  projectCount,
  session,
}: SettingsProps) {
  const [section, setSection] = useState<SettingsSection>("account");
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [usage, setUsage] = useState<OrganizationPlanUsage | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [workspaceName, setWorkspaceName] = useState(organizationName);
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const canRenameWorkspace =
    organizationRole === "owner" || organizationRole === "admin";
  const initials = useMemo(() => {
    const label = displayName || profile?.email || "Account";
    return label
      .split(INITIALS_SEPARATOR)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toLocaleUpperCase())
      .join("");
  }, [displayName, profile?.email]);

  useEffect(() => {
    setTheme(readThemePreference());
    let active = true;
    setLoading(true);
    Promise.allSettled([
      request("/v1/auth/profile", AccountProfileSchema.parse),
      request(
        `/v1/organizations/${organizationId}/usage`,
        OrganizationPlanUsageSchema.parse
      ),
    ]).then(([profileResult, usageResult]) => {
      if (!active) {
        return;
      }
      const failures: string[] = [];
      if (profileResult.status === "fulfilled") {
        setProfile(profileResult.value);
        setDisplayName(profileResult.value.displayName ?? "");
      } else {
        failures.push(
          describeError(profileResult.reason, "Could not load account details.")
        );
      }
      if (usageResult.status === "fulfilled") {
        setUsage(usageResult.value);
      } else {
        failures.push(
          describeError(usageResult.reason, "Could not load plan and usage.")
        );
      }
      setError(failures.join(" "));
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [organizationId]);

  useEffect(() => {
    setWorkspaceName(organizationName);
  }, [organizationName]);

  const saveProfile = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (savingProfile) {
        return;
      }
      setSavingProfile(true);
      setError("");
      setSaved("");
      try {
        const updated = await request(
          "/v1/auth/profile",
          AccountProfileSchema.parse,
          {
            body: JSON.stringify({ displayName }),
            method: "PATCH",
          }
        );
        setProfile(updated);
        setDisplayName(updated.displayName ?? "");
        onProfileUpdated(updated);
        setSaved("Your profile was saved.");
      } catch (cause) {
        setError(describeError(cause, "Could not save your profile."));
      } finally {
        setSavingProfile(false);
      }
    },
    [displayName, onProfileUpdated, savingProfile]
  );

  const saveWorkspace = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = workspaceName.trim();
      if (!(canRenameWorkspace && trimmed) || savingWorkspace) {
        return;
      }
      setSavingWorkspace(true);
      setError("");
      setSaved("");
      try {
        await request(`/v1/organizations/${organizationId}`, (value) => value, {
          body: JSON.stringify({ name: trimmed }),
          method: "PATCH",
        });
        setSaved("Workspace name saved.");
        onRenamed(trimmed);
      } catch (cause) {
        setError(describeError(cause, "Could not rename the workspace."));
      } finally {
        setSavingWorkspace(false);
      }
    },
    [
      canRenameWorkspace,
      onRenamed,
      organizationId,
      savingWorkspace,
      workspaceName,
    ]
  );

  const changeTheme = useCallback((next: ThemePreference) => {
    setTheme(next);
    applyThemePreference(next);
    setSaved("Appearance preference saved on this device.");
    setError("");
  }, []);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    setError("");
    try {
      await onSignOut();
    } catch (cause) {
      setError(describeError(cause, "Could not sign out."));
      setSigningOut(false);
    }
  }, [onSignOut]);

  const changeDisplayName = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setDisplayName(event.currentTarget.value),
    []
  );
  const changeWorkspaceName = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setWorkspaceName(event.currentTarget.value),
    []
  );
  const selectSection = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const nextSection = event.currentTarget.value;
      if (isSettingsSection(nextSection)) {
        setSection(nextSection);
        setError("");
        setSaved("");
      }
    },
    []
  );
  const selectTheme = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const nextTheme = event.currentTarget.value;
      if (
        nextTheme === "system" ||
        nextTheme === "light" ||
        nextTheme === "dark"
      ) {
        changeTheme(nextTheme);
      }
    },
    [changeTheme]
  );

  return (
    <div className="settings-backdrop">
      <section
        aria-label="Settings"
        aria-modal="true"
        className="settings-page"
        role="dialog"
      >
        <header className="settings-header">
          <div>
            <p className="settings-eyebrow">RESONATEAI</p>
            <h1>Settings</h1>
          </div>
          <button
            aria-label="Close settings"
            className="panel-close"
            onClick={onClose}
            type="button"
          >
            <X size={17} />
          </button>
        </header>

        <div className="settings-layout">
          <nav aria-label="Settings sections" className="settings-nav">
            {(
              [
                ["account", UserRound],
                ["appearance", Sun],
                ["workspace", Laptop],
                ["plan", CreditCard],
                ["security", Activity],
              ] as const
            ).map(([key, Icon]) => (
              <button
                aria-current={section === key ? "page" : undefined}
                className="settings-nav-item"
                key={key}
                onClick={selectSection}
                type="button"
                value={key}
              >
                <Icon aria-hidden="true" size={17} />
                <span>{sectionLabels[key]}</span>
                <ChevronRight
                  aria-hidden="true"
                  className="settings-nav-chevron"
                  size={15}
                />
              </button>
            ))}
            <div className="settings-nav-account">
              <span aria-hidden="true" className="settings-avatar">
                {initials || "U"}
              </span>
              <span className="settings-nav-account-copy">
                <strong>
                  {displayName || profile?.email || "Your account"}
                </strong>
                <span>{profile?.email ?? "Account profile"}</span>
              </span>
            </div>
          </nav>

          <main className="settings-content">
            <div className="settings-section-heading">
              <div>
                <h2>{sectionLabels[section]}</h2>
                <p>
                  {section === "plan"
                    ? "See your current limits and usage for this workspace."
                    : "Manage the details and preferences for your ReasonateAI account."}
                </p>
              </div>
            </div>

            {error && (
              <p className="settings-message is-error" role="alert">
                {error}
              </p>
            )}
            {saved && (
              <p className="settings-message is-saved" role="status">
                <Check size={15} />
                {saved}
              </p>
            )}
            {loading && (
              <p className="settings-loading" role="status">
                Loading your settings…
              </p>
            )}

            {!loading && section === "account" && (
              <>
                <form className="settings-card" onSubmit={saveProfile}>
                  <div className="settings-profile-head">
                    <span
                      aria-hidden="true"
                      className="settings-avatar is-large"
                    >
                      {initials || "U"}
                    </span>
                    <div>
                      <h3>{displayName || "Your profile"}</h3>
                      <p>Personal information for your account.</p>
                    </div>
                  </div>
                  <label
                    className="settings-field-label"
                    htmlFor="settings-display-name"
                  >
                    Display name
                  </label>
                  <input
                    autoComplete="name"
                    className="settings-field"
                    id="settings-display-name"
                    maxLength={80}
                    onChange={changeDisplayName}
                    placeholder="Add your name"
                    value={displayName}
                  />
                  <p className="settings-help">
                    This name appears in your account menu.
                  </p>
                  <div className="settings-field-label settings-label-spaced">
                    Sign-in email
                  </div>
                  <div className="settings-readonly">
                    <span>{profile?.email ?? "Unavailable"}</span>
                    {profile?.email && (
                      <span className="settings-verified">
                        <Check size={13} /> Verified
                      </span>
                    )}
                  </div>
                  <p className="settings-help">
                    Your email is managed by secure email sign-in and cannot be
                    changed here.
                  </p>
                  <div className="settings-form-footer">
                    <span>
                      {profile?.userId ? `Account ID · ${profile.userId}` : ""}
                    </span>
                    <button
                      className="settings-primary"
                      disabled={
                        savingProfile ||
                        displayName === (profile?.displayName ?? "")
                      }
                      type="submit"
                    >
                      {savingProfile ? "Saving…" : "Save profile"}
                    </button>
                  </div>
                </form>
                <div className="settings-card settings-note-card">
                  <CircleHelp aria-hidden="true" size={18} />
                  <div>
                    <h3>Need to change your sign-in email?</h3>
                    <p>
                      Email changes and account recovery are handled by your
                      organization’s identity administrator.
                    </p>
                  </div>
                </div>
              </>
            )}

            {!loading && section === "appearance" && (
              <div className="settings-card">
                <h3>Theme</h3>
                <p className="settings-help settings-top-help">
                  Choose how ReasonateAI looks on this device.
                </p>
                <fieldset className="settings-theme-options">
                  <legend className="sr-only">Theme preference</legend>
                  {(
                    [
                      ["system", Laptop, "System"],
                      ["light", Sun, "Light"],
                      ["dark", Moon, "Dark"],
                    ] as const
                  ).map(([value, Icon, label]) => (
                    <button
                      aria-pressed={theme === value}
                      className="settings-theme-option"
                      key={value}
                      onClick={selectTheme}
                      type="button"
                      value={value}
                    >
                      <Icon aria-hidden="true" size={19} />
                      <span>{label}</span>
                      {theme === value && (
                        <Check aria-hidden="true" size={16} />
                      )}
                    </button>
                  ))}
                </fieldset>
                <p className="settings-help">
                  System follows your device’s appearance setting. Your choice
                  is saved in this browser.
                </p>
              </div>
            )}

            {!loading && section === "workspace" && (
              <>
                <form className="settings-card" onSubmit={saveWorkspace}>
                  <div className="settings-card-head">
                    <div>
                      <h3>Workspace details</h3>
                      <p>Projects and usage belong to this workspace.</p>
                    </div>
                    <span className="settings-role">{organizationRole}</span>
                  </div>
                  <label
                    className="settings-field-label"
                    htmlFor="settings-workspace-name"
                  >
                    Workspace name
                  </label>
                  <div className="settings-input-row">
                    <input
                      className="settings-field"
                      disabled={!canRenameWorkspace}
                      id="settings-workspace-name"
                      maxLength={120}
                      onChange={changeWorkspaceName}
                      value={workspaceName}
                    />
                    {canRenameWorkspace && (
                      <button
                        className="settings-primary"
                        disabled={
                          savingWorkspace ||
                          workspaceName.trim() === organizationName
                        }
                        type="submit"
                      >
                        {savingWorkspace ? "Saving…" : "Save"}
                      </button>
                    )}
                  </div>
                  {!canRenameWorkspace && (
                    <p className="settings-help">
                      Only workspace owners and admins can rename this
                      workspace.
                    </p>
                  )}
                  <p className="settings-help">
                    Workspace ID · {organizationId}
                  </p>
                </form>
                <div className="settings-card settings-summary-grid">
                  <div>
                    <span>Projects</span>
                    <strong>{projectCount.toLocaleString()}</strong>
                  </div>
                  <div>
                    <span>Your role</span>
                    <strong>{organizationRole}</strong>
                  </div>
                  <div>
                    <span>Plan</span>
                    <strong>{usage?.plan ?? "Loading"}</strong>
                  </div>
                </div>
              </>
            )}

            {!loading &&
              section === "plan" &&
              (usage ? (
                <>
                  <div className="settings-plan-card">
                    <div className="settings-plan-icon">
                      <CreditCard aria-hidden="true" size={20} />
                    </div>
                    <div className="settings-plan-copy">
                      <span>Current plan</span>
                      <h3>
                        {usage.plan.charAt(0).toLocaleUpperCase() +
                          usage.plan.slice(1)}
                      </h3>
                      <p>
                        Default plan · billing and plan changes are not enabled
                        yet.
                      </p>
                    </div>
                    <span className="settings-plan-badge">Enforced</span>
                  </div>
                  <div className="settings-card">
                    <div className="settings-card-head">
                      <div>
                        <h3>Usage this period</h3>
                        <p>
                          {dateTime(usage.usage.periodStart)} –{" "}
                          {dateTime(usage.usage.periodEnd)}
                        </p>
                      </div>
                    </div>
                    <div className="settings-quotas">
                      <QuotaRow
                        label="Runs"
                        limit={usage.entitlements.runsPerPeriod}
                        used={usage.usage.runs}
                      />
                      <QuotaRow
                        label="Projects"
                        limit={usage.entitlements.projects}
                        used={projectCount}
                      />
                      <QuotaRow
                        detail="min"
                        label="Sandbox time"
                        limit={usage.entitlements.sandboxMinutesPerPeriod}
                        used={usage.usage.sandboxMinutes}
                      />
                      <QuotaRow
                        label="Tokens"
                        limit={usage.entitlements.tokensPerPeriod}
                        used={usage.usage.tokens}
                      />
                      <QuotaRow
                        detail="USD"
                        label="Model spend"
                        limit={
                          usage.entitlements.spendMicrosPerPeriod / 1_000_000
                        }
                        used={usage.usage.spendMicros / 1_000_000}
                      />
                      <QuotaRow
                        formatValue={formatBytes}
                        label="Workspace storage"
                        limit={usage.entitlements.workspaceBytes}
                        used={usage.usage.workspaceBytes}
                      />
                    </div>
                  </div>
                  <div className="settings-card settings-limit-list">
                    <h3>Included limits</h3>
                    <p>
                      {usage.entitlements.concurrentRuns} concurrent run
                      {usage.entitlements.concurrentRuns === 1 ? "" : "s"} ·{" "}
                      {usage.entitlements.rateLimit.burstPerMinute.toLocaleString()}{" "}
                      requests per minute ·{" "}
                      {usage.entitlements.rateLimit.requestsPerDay.toLocaleString()}{" "}
                      per day
                    </p>
                    <p>
                      Available models:{" "}
                      {usage.entitlements.models.join(", ") || "None"}
                    </p>
                  </div>
                </>
              ) : (
                <p className="settings-empty">
                  Plan information is unavailable. Try reopening Settings.
                </p>
              ))}

            {!loading && section === "security" && (
              <>
                <div className="settings-card">
                  <h3>Signed-in session</h3>
                  <p className="settings-help settings-top-help">
                    Your session is protected by a secure, revocable browser
                    cookie.
                  </p>
                  <dl className="settings-details">
                    <div>
                      <dt>Session ID</dt>
                      <dd>{session.sessionId}</dd>
                    </div>
                    <div>
                      <dt>Idle expiry</dt>
                      <dd>{dateTime(session.idleExpiresAt)}</dd>
                    </div>
                    <div>
                      <dt>Maximum session expiry</dt>
                      <dd>{dateTime(session.absoluteExpiresAt)}</dd>
                    </div>
                  </dl>
                  <button
                    className="settings-danger"
                    disabled={signingOut}
                    onClick={signOut}
                    type="button"
                  >
                    <LogOut aria-hidden="true" size={16} />
                    {signingOut ? "Signing out…" : "Sign out of this session"}
                  </button>
                </div>
                <div className="settings-card settings-note-card">
                  <CircleHelp aria-hidden="true" size={18} />
                  <div>
                    <h3>More security controls</h3>
                    <p>
                      Passkeys, multi-factor authentication, and managing other
                      signed-in devices are not available yet.
                    </p>
                  </div>
                </div>
              </>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}
