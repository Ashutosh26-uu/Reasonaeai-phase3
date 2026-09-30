"use client";

import { ArrowUp } from "lucide-react";
import Image from "next/image";
import { useCallback, useState } from "react";
import { describeError, request } from "@/lib/product-api";

/**
 * Sign-in.
 *
 * The only entry point the product has: a verified email address, a single-use
 * link, and a server-managed session. There is no password to store and no
 * token for the browser to keep.
 */
export function AuthGate() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const updateEmail = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setEmail(event.currentTarget.value);
    },
    []
  );

  const signIn = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSubmitting(true);
      setError("");
      try {
        await request("/v1/auth/magic-links", (value) => value, {
          body: JSON.stringify({ email }),
          method: "POST",
        });
        setNotice(
          process.env.NODE_ENV === "development"
            ? "No email is sent in development. Open the one-use link printed in the API terminal."
            : "Check your email for the sign-in link."
        );
      } catch (cause) {
        setError(describeError(cause, "Could not request a link."));
      } finally {
        setSubmitting(false);
      }
    },
    [email]
  );

  return (
    <div className="gate">
      <div className="gate-inner">
        <div className="gate-mark">
          <Image
            alt="ReasonateAI"
            height={40}
            priority
            src="/brand/reasonateai-icon.png"
            width={40}
          />
        </div>
        <h1 className="gate-title">Sign in to your workspace</h1>
        <p className="gate-note">
          Your CTO plans, builds, runs, and repairs the product with you. One
          link gets you in; there is no password to keep.
        </p>
        <form className="gate-form" onSubmit={signIn}>
          <label className="gate-label" htmlFor="email">
            Work email
          </label>
          <input
            className="gate-input"
            id="email"
            onChange={updateEmail}
            placeholder="you@company.com"
            required
            type="email"
            value={email}
          />
          <button className="gate-submit" disabled={submitting} type="submit">
            Send sign-in link <ArrowUp size={15} />
          </button>
        </form>
        {notice.length > 0 && <p className="gate-status">{notice}</p>}
        {error.length > 0 && <p className="gate-status">{error}</p>}
      </div>
    </div>
  );
}
