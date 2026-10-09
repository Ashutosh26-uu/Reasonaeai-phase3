"use client";
import {
  AccountProfileSchema,
  type SessionView,
} from "@reasonateai/contracts/auth";
import { ArrowLeft, ArrowRight, Check, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { describeError, request } from "@/lib/product-api";
import { AuthShell } from "./auth-shell";

export function AccountSetup({
  session,
  onComplete,
  onSignedOut,
}: {
  session: SessionView;
  onComplete: () => void;
  onSignedOut: () => void;
}) {
  const [step, setStep] = useState<"name" | "workspace">("name");
  const [displayName, setDisplayName] = useState("");
  const [workspaceName, setWorkspaceName] = useState(
    session.organizations[0]?.name ?? ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    request("/v1/auth/profile", AccountProfileSchema.parse)
      .then((profile) => {
        if (!cancelled && profile.displayName) {
          setDisplayName(profile.displayName);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(describeError(cause, "Your account could not be loaded."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    inputRef.current?.focus();
  }, [step]);
  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (busyRef.current) {
        return;
      }
      if (step === "name") {
        setStep("workspace");
        setError("");
        return;
      }
      const [organization] = session.organizations;
      if (!organization) {
        setError(
          "Your workspace is unavailable. Sign out and sign in again to recover."
        );
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setError("");
      try {
        await request("/v1/auth/onboarding", (value) => value, {
          body: JSON.stringify({
            displayName: displayName.trim(),
            organizationId: organization.organizationId,
            workspaceName: workspaceName.trim(),
          }),
          method: "POST",
        });
        onComplete();
      } catch (cause) {
        setError(
          describeError(
            cause,
            "Setup could not be saved. Your account is safe; please retry."
          )
        );
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [step, session, displayName, workspaceName, onComplete]
  );
  const signOut = useCallback(async () => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await request("/v1/auth/session", (value) => value, { method: "DELETE" });
      onSignedOut();
    } catch (cause) {
      setError(describeError(cause, "Could not sign out."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [onSignedOut]);
  const updateName = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (step === "name") {
        setDisplayName(event.currentTarget.value);
      } else {
        setWorkspaceName(event.currentTarget.value);
      }
    },
    [step]
  );
  const back = useCallback(() => setStep("name"), []);
  const submitLabel = step === "name" ? "Continue" : "Open my workspace";

  return (
    <AuthShell stage={2}>
      <span className="auth-kicker">
        <Check size={12} /> EMAIL VERIFIED ·{" "}
        {step === "name" ? "1 OF 2" : "2 OF 2"}
      </span>
      <h1>
        {step === "name" ? (
          <>
            Let's make
            <br />
            this yours.
          </>
        ) : (
          <>
            A home for
            <br />
            your big ideas.
          </>
        )}
      </h1>
      <p className="auth-subtitle">
        {step === "name"
          ? "First, what should we call you?"
          : "Your workspace keeps your projects together. You can create more workspaces later."}
      </p>
      <form className="auth-form" onSubmit={submit}>
        <label htmlFor="setup-name">
          {step === "name" ? "Your name" : "Workspace name"}
        </label>
        <input
          autoComplete={step === "name" ? "name" : "organization"}
          disabled={busy}
          id="setup-name"
          key={step}
          maxLength={step === "name" ? 80 : 120}
          onChange={updateName}
          placeholder={step === "name" ? "Alex Morgan" : "My studio"}
          ref={inputRef}
          required
          value={step === "name" ? displayName : workspaceName}
        />
        <p className="auth-field-hint">
          You can change this later in Settings.
        </p>
        <button
          className="auth-primary"
          disabled={
            busy ||
            !(step === "name" ? displayName.trim() : workspaceName.trim())
          }
          type="submit"
        >
          {busy ? "Saving your workspace…" : submitLabel}
          {busy ? (
            <LoaderCircle className="auth-spin" size={16} />
          ) : (
            <ArrowRight size={16} />
          )}
        </button>
      </form>
      {step === "workspace" && (
        <button
          className="auth-text-button"
          disabled={busy}
          onClick={back}
          type="button"
        >
          <ArrowLeft size={14} /> Back
        </button>
      )}
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="auth-text-button"
        disabled={busy}
        onClick={signOut}
        type="button"
      >
        Sign out
      </button>
    </AuthShell>
  );
}
