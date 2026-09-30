"use client";

import type { SessionView } from "@reasonateai/contracts/auth";
import { SessionViewSchema } from "@reasonateai/contracts/auth";
import { useCallback, useEffect, useState } from "react";
import { Onboarding } from "@/components/onboarding/onboarding";
import { AuthGate } from "@/components/workspace/auth-gate";
import { Workspace } from "@/components/workspace/workspace";
import { ApiRequestError, describeError, request } from "@/lib/product-api";
import { initializeThemePreference } from "@/lib/theme";
import "./product.css";

/**
 * The workspace route: whoever is signed in, or the way in, or the first run
 * through.
 *
 * Nothing else lives here. A session is either established or it is not, and a
 * person with no organization has not finished arriving — so the onboarding
 * comes before the workspace rather than inside it, where a half-built rail
 * would be the first thing they see.
 */
export default function Home() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadSession = useCallback(async () => {
    try {
      setSession(await request("/v1/auth/session", SessionViewSchema.parse));
      setError("");
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 401) {
        setSession(null);
      } else {
        setError(describeError(cause, "Could not reach ReasonateAI."));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const disposeTheme = initializeThemePreference();
    loadSession();
    return disposeTheme;
  }, [loadSession]);

  const forgetSession = useCallback(() => setSession(null), []);
  const finishOnboarding = useCallback(() => {
    loadSession().catch(() => undefined);
  }, [loadSession]);

  if (loading) {
    return (
      <div className="gate">
        <p className="gate-note">Opening your workspace…</p>
      </div>
    );
  }

  if (error.length > 0 && session === null) {
    return (
      <div className="gate">
        <p className="gate-note">{error}</p>
      </div>
    );
  }

  if (session === null) {
    return <AuthGate />;
  }

  if (session.organizations.length === 0) {
    return <Onboarding onComplete={finishOnboarding} session={session} />;
  }

  return <Workspace onSignedOut={forgetSession} session={session} />;
}
