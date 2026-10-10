"use client";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthShell } from "@/components/auth/auth-shell";
import { describeError, request } from "@/lib/product-api";

const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export default function VerifyPage() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef<boolean>(false);
  const captured = useRef<boolean>(false);
  useEffect(() => {
    if (captured.current) {
      return;
    }
    captured.current = true;
    const value =
      new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    window.history.replaceState(null, "", "/auth/verify");
    setToken(value);
    if (!LINK_TOKEN.test(value)) {
      setError(
        "This link is missing or invalid. Request a fresh link to continue."
      );
    }
  }, []);
  const confirm = useCallback(async () => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await request("/v1/auth/callback", (value) => value, {
        body: JSON.stringify({ token }),
        method: "POST",
      });
      setToken("");
      window.location.replace("/");
    } catch (cause) {
      setError(describeError(cause, "This link could not be verified."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [token]);
  return (
    <AuthShell stage={1}>
      <span className="auth-kicker">ONE LAST CHECK</span>
      <h1>
        Your workspace
        <br />
        is one click away.
      </h1>
      <p className="auth-subtitle">
        Continue only if you requested this sign-in email. Use the same browser
        where you requested the link.
      </p>
      <button
        className="auth-primary"
        disabled={busy || !token}
        onClick={confirm}
        type="button"
      >
        {busy ? "Verifying…" : "Confirm and continue"}
        {busy ? (
          <LoaderCircle className="auth-spin" size={16} />
        ) : (
          <ArrowRight size={16} />
        )}
      </button>
      {error && (
        <p className="auth-error" role="alert">
          {error} If the link expired, was used, or opened in another browser,
          request a new one.
        </p>
      )}
      <a className="auth-text-button" href="/auth/login">
        Request a new sign-in link
      </a>
    </AuthShell>
  );
}
