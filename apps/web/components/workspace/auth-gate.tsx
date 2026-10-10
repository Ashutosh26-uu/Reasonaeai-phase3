"use client";

import {
  type AuthOptions,
  AuthOptionsSchema,
  MagicLinkAcceptedSchema,
} from "@reasonateai/contracts/auth";
import {
  ArrowLeft,
  ArrowRight,
  LoaderCircle,
  Mail,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthShell } from "@/components/auth/auth-shell";
import { ApiRequestError, describeError, request } from "@/lib/product-api";

export function AuthGate({
  initialMode = "signup",
}: {
  initialMode?: "login" | "signup";
}) {
  const [email, setEmail] = useState("");
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [delivery, setDelivery] = useState<"email" | "local">("email");
  const [expiresAt, setExpiresAt] = useState("");
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState("");
  const [optionError, setOptionError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const busyRef = useRef<boolean>(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const signup = initialMode === "signup";

  useEffect(() => {
    let cancelled = false;
    request("/v1/auth/options", AuthOptionsSchema.parse)
      .then((value) => {
        if (!cancelled) {
          setOptions(value);
          setOptionError("");
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setOptionError(
            describeError(cause, "Sign-in options could not be loaded.")
          );
        }
      });
    const reason = new URLSearchParams(window.location.search).get("error");
    if (reason) {
      setError(
        reason === "link"
          ? "That link is invalid. Request a fresh one below."
          : "Google sign-in did not finish. Try again or continue with email."
      );
    }
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    if (!retryAt) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);
  useEffect(() => {
    if (sent) {
      heading.current?.focus();
    }
  }, [sent]);

  const send = useCallback(
    async (event?: React.FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      if (busyRef.current || remaining > 0) {
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setError("");
      try {
        const accepted = await request(
          "/v1/auth/magic-links",
          MagicLinkAcceptedSchema.parse,
          {
            body: JSON.stringify({ email: email.trim() }),
            method: "POST",
          }
        );
        setDelivery(accepted.delivery);
        setExpiresAt(accepted.expiresAt);
        setSent(true);
        setNow(Date.now());
        setRetryAt(Date.now() + 60_000);
      } catch (cause) {
        setError(
          describeError(cause, "We could not send the email. Please try again.")
        );
        if (cause instanceof ApiRequestError && cause.retryAfterSeconds) {
          setRetryAt(Date.now() + cause.retryAfterSeconds * 1000);
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [email, remaining]
  );

  const resend = useCallback(() => {
    send();
  }, [send]);
  const changeEmail = useCallback(() => {
    setSent(false);
    setError("");
    setRetryAt(0);
  }, []);
  const updateEmail = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setEmail(event.currentTarget.value),
    []
  );
  const retryOptions = useCallback(() => setAttempt((value) => value + 1), []);
  let submitLabel = signup ? "Create your account" : "Send sign-in link";
  if (remaining > 0) {
    submitLabel = `Try again in ${remaining}s`;
  }
  if (busy) {
    submitLabel = "Sending your link…";
  }
  const resendLabel =
    remaining > 0 ? `Resend in ${remaining}s` : "Resend email";

  return (
    <AuthShell stage={sent ? 1 : 0}>
      {sent ? (
        <AuthInbox
          busy={busy}
          changeEmail={changeEmail}
          delivery={delivery}
          email={email}
          expiresAt={expiresAt}
          heading={heading}
          remaining={remaining}
          resend={resend}
          resendLabel={resendLabel}
        />
      ) : (
        <AuthEmailForm
          busy={busy}
          email={email}
          optionError={optionError}
          options={options}
          remaining={remaining}
          retryOptions={retryOptions}
          send={send}
          signup={signup}
          submitLabel={submitLabel}
          updateEmail={updateEmail}
        />
      )}
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
    </AuthShell>
  );
}

function AuthInbox({
  busy,
  remaining,
  heading,
  email,
  delivery,
  expiresAt,
  resend,
  resendLabel,
  changeEmail,
}: {
  busy: boolean;
  remaining: number;
  heading: React.RefObject<HTMLHeadingElement | null>;
  email: string;
  delivery: "email" | "local";
  expiresAt: string;
  resend: () => void;
  resendLabel: string;
  changeEmail: () => void;
}) {
  return (
    <>
      <div className="auth-mail-icon">
        <Mail size={25} />
      </div>
      <h1 ref={heading} tabIndex={-1}>
        Check your inbox.
      </h1>
      <p className="auth-subtitle">
        We sent a secure link to
        <br />
        <strong>{email.trim()}</strong>
      </p>
      <div className="auth-info">
        <ShieldCheck size={18} />
        <p>
          Open the link in this browser to continue. It expires at{" "}
          {new Date(expiresAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}{" "}
          and works once.
        </p>
      </div>
      {delivery === "local" && (
        <p className="auth-notice" role="status">
          Development mailbox: this email was captured locally. No external
          email was sent.
        </p>
      )}
      <button
        className="auth-primary"
        disabled={busy || remaining > 0}
        onClick={resend}
        type="button"
      >
        {busy ? "Sending…" : resendLabel}
        <Mail size={16} />
      </button>
      <button
        className="auth-text-button"
        disabled={busy}
        onClick={changeEmail}
        type="button"
      >
        <ArrowLeft size={15} /> Use a different email
      </button>
      <p className="auth-fineprint">
        Can't find it? Check spam or junk. Keep this tab open while you check
        your email.
      </p>
    </>
  );
}
function AuthEmailForm({
  signup,
  options,
  busy,
  email,
  remaining,
  send,
  updateEmail,
  submitLabel,
  optionError,
  retryOptions,
}: {
  signup: boolean;
  options: AuthOptions | null;
  busy: boolean;
  email: string;
  remaining: number;
  send: (event: React.FormEvent<HTMLFormElement>) => void;
  updateEmail: (event: React.ChangeEvent<HTMLInputElement>) => void;
  submitLabel: string;
  optionError: string;
  retryOptions: () => void;
}) {
  return (
    <>
      <span className="auth-kicker">
        {signup ? "LET'S MAKE IT REAL" : "GOOD TO HAVE YOU BACK"}
      </span>
      <h1>
        {signup ? (
          <>
            Big ideas start
            <br />
            right here.
          </>
        ) : (
          <>
            Welcome back
            <br />
            to your workspace.
          </>
        )}
      </h1>
      <p className="auth-subtitle">
        {signup
          ? "Create your account. Your next chapter starts with an idea."
          : "Pick up where you left off. Your projects are waiting."}
      </p>
      {options?.google && (
        <>
          <a className="auth-provider" href="/v1/auth/google">
            <span aria-hidden="true" className="auth-google-mark">
              G
            </span>
            Continue with Google
          </a>
          <div className="auth-divider">
            <span>or continue with email</span>
          </div>
        </>
      )}
      <form className="auth-form" onSubmit={send}>
        <label htmlFor="auth-email">Email address</label>
        <input
          aria-describedby="auth-email-hint"
          autoComplete="email"
          disabled={busy}
          id="auth-email"
          inputMode="email"
          maxLength={254}
          name="email"
          onChange={updateEmail}
          placeholder="you@company.com"
          required
          type="email"
          value={email}
        />
        <p className="auth-field-hint" id="auth-email-hint">
          We'll send you a secure link. No password to remember.
        </p>
        <button
          className="auth-primary"
          disabled={
            busy || !options || options.email === "unavailable" || remaining > 0
          }
          type="submit"
        >
          {submitLabel}
          {busy ? (
            <LoaderCircle className="auth-spin" size={17} />
          ) : (
            <ArrowRight size={17} />
          )}
        </button>
      </form>
      {options?.email === "unavailable" && (
        <p className="auth-notice" role="status">
          Email sign-in is awaiting setup by your administrator.
          {options.google
            ? " You can continue with Google."
            : " Please check back once sign-in is enabled."}
        </p>
      )}
      {options?.email === "local" && (
        <p className="auth-notice">
          Development mode · Emails go to the local test mailbox.
        </p>
      )}
      {optionError && (
        <div className="auth-error" role="alert">
          {optionError}
          <button onClick={retryOptions} type="button">
            Retry
          </button>
        </div>
      )}
      <p className="auth-switch">
        {signup ? "Already have an account?" : "New to ReasonateAI?"}{" "}
        <a href={signup ? "/auth/login" : "/auth/signup"}>
          {signup ? "Sign in" : "Create an account"}
          <ArrowRight size={13} />
        </a>
      </p>
      <div className="auth-trust">
        <ShieldCheck size={15} /> Verified email. Private projects. You're in
        control.
      </div>
    </>
  );
}
