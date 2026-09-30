"use client";

import {
  CreateOrganizationResponseSchema,
  ProjectListSchema,
  type ProjectSummary,
  ProjectViewSchema,
  type SessionView,
} from "@reasonateai/contracts/auth";
import { FolderClosed } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { AsciiFigure } from "@/components/onboarding/ascii-figure";
import { describeError, request } from "@/lib/product-api";
import "./onboarding.css";

export interface OnboardingProps {
  /** Called once the flow has created an organization and a first project. */
  onComplete: (input: { organizationId: string; projectId: string }) => void;
  /** The signed-in session, for the greeting and the organizations it already has. */
  session: SessionView;
}

type Step = "next" | "project" | "welcome" | "workspace";

interface StepCopy {
  lede: string;
  title: string;
}

const STEP_COPY: Record<Step, StepCopy> = {
  next: {
    lede: "Every change you ask for runs the same loop, in your own project.",
    title: "What happens next",
  },
  project: {
    lede: "A project is one app: one codebase, one sandbox, and the history of what changed in it.",
    title: "Name the first project",
  },
  welcome: {
    lede: "You describe the product you want in plain language. ReasonateAI plans the work, then builds and runs a real app in an isolated sandbox. It verifies what it built and shows you the result, so the next change starts from something that runs.",
    title: "ReasonateAI is your CTO",
  },
  workspace: {
    lede: "A workspace holds your projects and everything the CTO builds in them.",
    title: "Name your workspace",
  },
};

/**
 * The steps this session actually needs. A person who already has a workspace
 * names their first project and nothing else, so the count below the heading
 * stays honest about what is left.
 */
function planSteps(hasWorkspace: boolean): readonly Step[] {
  return hasWorkspace
    ? ["welcome", "project", "next"]
    : ["welcome", "workspace", "project", "next"];
}

function primaryLabelFor(step: Step, openProject: string | undefined): string {
  if (step === "welcome") {
    return "Get started";
  }
  if (step === "workspace") {
    return "Create workspace";
  }
  if (step === "next") {
    return "Open the workspace";
  }
  return openProject === undefined
    ? "Create project"
    : `Continue with ${openProject}`;
}

/**
 * First-run setup: the workspace, the first project, and what happens after.
 *
 * Both writes are real — the organization and the project are created through
 * the same product routes the workspace uses — and the flow only moves on once
 * the API has answered. Skipping is always on screen: it finishes setup with
 * what already exists, and where nothing exists yet it says why it cannot.
 */
export function Onboarding({ onComplete, session }: OnboardingProps) {
  const [step, setStep] = useState<Step>("welcome");
  const [organizationId, setOrganizationId] = useState(
    session.organizations[0]?.organizationId ?? ""
  );
  const [workspaceName, setWorkspaceName] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [readingProjects, setReadingProjects] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  const steps = planSteps(organizationId.length > 0);
  const openProject = projects.find((item) => item.projectId === projectId);

  /**
   * The projects the workspace already holds. This is a read, so it is safe to
   * run as the flow opens; nothing here writes until a button is pressed.
   */
  useEffect(() => {
    if (organizationId.length === 0) {
      return;
    }
    let cancelled = false;
    setReadingProjects(true);
    const read = async () => {
      try {
        const existing = await request(
          `/v1/projects?organizationId=${encodeURIComponent(organizationId)}`,
          (value) => ProjectListSchema.parse(value).projects
        );
        if (cancelled) {
          return;
        }
        setProjects(existing);
        setProjectId((current) =>
          existing.some((item) => item.projectId === current)
            ? current
            : (existing[0]?.projectId ?? "")
        );
      } catch (cause) {
        if (!cancelled) {
          setError(describeError(cause, "Could not read your projects."));
        }
      } finally {
        if (!cancelled) {
          setReadingProjects(false);
        }
      }
    };
    read();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  /** The heading and the input must meet the person who just arrived there. */
  useEffect(() => {
    (inputRef.current ?? primaryRef.current)?.focus();
  }, [step]);

  const createWorkspace = useCallback(async () => {
    const name = workspaceName.trim();
    if (name.length === 0) {
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const created = await request(
        "/v1/organizations",
        CreateOrganizationResponseSchema.parse,
        { body: JSON.stringify({ name }), method: "POST" }
      );
      setOrganizationId(created.organizationId);
      setWorkspaceName("");
      setNote("");
      setStep("project");
    } catch (cause) {
      setError(describeError(cause, "Could not create the workspace."));
    } finally {
      setBusy(false);
    }
  }, [workspaceName]);

  const createProject = useCallback(async () => {
    const name = projectName.trim();
    if (name.length === 0) {
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const created = await request("/v1/projects", ProjectViewSchema.parse, {
        body: JSON.stringify({ name, organizationId }),
        method: "POST",
      });
      setProjectId(created.projectId);
      setProjectName("");
      setNote("");
      setStep("next");
    } catch (cause) {
      setError(describeError(cause, "Could not create the project."));
    } finally {
      setBusy(false);
    }
  }, [organizationId, projectName]);

  const finish = useCallback(() => {
    if (organizationId.length === 0 || projectId.length === 0) {
      return;
    }
    onComplete({ organizationId, projectId });
  }, [onComplete, organizationId, projectId]);

  const submitStep = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (busy) {
        return;
      }
      setError("");
      setNote("");
      if (step === "welcome") {
        setStep(organizationId.length > 0 ? "project" : "workspace");
        return;
      }
      if (step === "workspace") {
        await createWorkspace();
        return;
      }
      if (step === "project") {
        if (openProject === undefined) {
          await createProject();
          return;
        }
        setStep("next");
        return;
      }
      finish();
    },
    [
      busy,
      createProject,
      createWorkspace,
      finish,
      openProject,
      organizationId,
      step,
    ]
  );

  /**
   * Skip finishes setup with what is already there. Without a project there is
   * nothing to open — every run belongs to one — so it says so instead of
   * inventing an identifier.
   */
  const skipSetup = useCallback(() => {
    if (busy) {
      return;
    }
    setError("");
    setNote("");
    if (readingProjects) {
      setNote("Still reading your workspace. Try again in a moment.");
      return;
    }
    if (organizationId.length > 0 && projectId.length > 0) {
      onComplete({ organizationId, projectId });
      return;
    }
    setNote(
      organizationId.length > 0
        ? "The CTO builds inside a project, so setup needs one. Create it here to continue."
        : "A workspace holds your projects and their runs, so setup needs one. Name it here to continue."
    );
  }, [busy, onComplete, organizationId, projectId, readingProjects]);

  const updateWorkspaceName = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setWorkspaceName(event.currentTarget.value);
    },
    []
  );

  const updateProjectName = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setProjectName(event.currentTarget.value);
    },
    []
  );

  const chooseProject = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      setProjectId(event.currentTarget.value);
    },
    []
  );

  const copy = STEP_COPY[step];
  const stepNumber = steps.indexOf(step) + 1;
  const canSubmit =
    !busy &&
    (step !== "workspace" || workspaceName.trim().length > 0) &&
    (step !== "project" ||
      openProject !== undefined ||
      projectName.trim().length > 0);

  return (
    <div className="onboarding">
      <div className="onb-inner">
        {step === "welcome" && (
          <div className="onb-hero">
            <ThinkingOrb size={64} state="connecting" theme="auto" />
          </div>
        )}
        {step === "next" && (
          <div className="onb-hero">
            <AsciiFigure />
          </div>
        )}

        <p className="onb-progress">
          Step {stepNumber} of {steps.length}
        </p>
        <h2 aria-live="polite" className="onb-title">
          {step === "project" && openProject !== undefined
            ? "Choose a project"
            : copy.title}
        </h2>
        <p className="onb-lede">
          {step === "project" && openProject !== undefined
            ? "This workspace already has projects. Choose the one the CTO should work in."
            : copy.lede}
        </p>

        {error.length > 0 && (
          <div className="onb-banner is-error" role="alert">
            <span>{error}</span>
          </div>
        )}
        {note.length > 0 && (
          <div className="onb-banner" role="status">
            <span>{note}</span>
          </div>
        )}

        <form className="onb-form" onSubmit={submitStep}>
          <div className="onb-step" key={step}>
            {step === "workspace" && (
              <div className="onb-field">
                <label className="onb-label" htmlFor="onb-workspace">
                  Workspace name
                </label>
                <input
                  className="onb-input"
                  disabled={busy}
                  id="onb-workspace"
                  maxLength={120}
                  onChange={updateWorkspaceName}
                  placeholder="Northwind"
                  ref={inputRef}
                  required
                  value={workspaceName}
                />
              </div>
            )}

            {step === "project" && openProject !== undefined && (
              <ul className="onb-projects">
                {projects.map((item) => (
                  <li key={item.projectId}>
                    <button
                      aria-pressed={item.projectId === projectId}
                      className="onb-project"
                      data-active={item.projectId === projectId || undefined}
                      onClick={chooseProject}
                      type="button"
                      value={item.projectId}
                    >
                      <FolderClosed aria-hidden="true" size={14} />
                      <span className="onb-project-name">{item.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {step === "project" && openProject === undefined && (
              <div className="onb-field">
                <label className="onb-label" htmlFor="onb-project">
                  Project name
                </label>
                <input
                  className="onb-input"
                  disabled={busy}
                  id="onb-project"
                  maxLength={120}
                  onChange={updateProjectName}
                  placeholder="Invoice tracker"
                  ref={inputRef}
                  required
                  value={projectName}
                />
              </div>
            )}

            {step === "next" && (
              <ol className="onb-loop">
                <li>You describe the product, or the change you want next.</li>
                <li>The CTO reads the project and plans the work.</li>
                <li>It builds and runs the app in an isolated sandbox.</li>
                <li>It verifies the result against what you asked for.</li>
                <li>You see what it built, and ask for the next change.</li>
              </ol>
            )}
          </div>

          <div className="onb-actions">
            <button
              className="onb-primary"
              disabled={!canSubmit}
              ref={primaryRef}
              type="submit"
            >
              {primaryLabelFor(step, openProject?.name)}
            </button>
            <button
              className="onb-skip"
              disabled={busy}
              onClick={skipSetup}
              type="button"
            >
              Skip setup
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
