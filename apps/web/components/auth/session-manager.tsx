"use client";
import {
  type DeviceSession,
  DeviceSessionsSchema,
  SignedOutSchema,
} from "@reasonateai/contracts/auth";
import { useCallback, useEffect, useState } from "react";
import { describeError, request } from "@/lib/product-api";

export function SessionManager() {
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      setSessions(
        (await request("/v1/auth/sessions", DeviceSessionsSchema.parse))
          .sessions
      );
    } catch (cause) {
      setError(describeError(cause, "Could not load your sessions."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const revoke = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      const id = event.currentTarget.value;
      setBusy(id);
      setError("");
      try {
        await request(`/v1/auth/sessions/${id}`, SignedOutSchema.parse, {
          method: "DELETE",
        });
        if (id === "all") {
          window.location.replace("/");
          return;
        }
        await load();
      } catch (cause) {
        setError(describeError(cause, "Could not end that session."));
      } finally {
        setBusy("");
      }
    },
    [load]
  );
  return (
    <div className="settings-card">
      <h3>Active sessions</h3>
      <p className="settings-help">
        End a session you no longer use. Ending every session also signs you out
        here.
      </p>
      {loading && <p role="status">Loading sessions…</p>}
      {!loading && sessions.length === 0 && !error && (
        <p>No active sessions were found.</p>
      )}
      {!loading &&
        sessions.map((item, index) => (
          <div className="settings-session-row" key={item.sessionId}>
            <div>
              <strong>
                {item.current ? "This browser" : `Session ${index + 1}`}
              </strong>
              <p>Last active {new Date(item.lastSeenAt).toLocaleString()}</p>
            </div>
            {item.current ? (
              <span>Current</span>
            ) : (
              <button
                className="settings-danger"
                disabled={Boolean(busy)}
                onClick={revoke}
                type="button"
                value={item.sessionId}
              >
                {busy === item.sessionId ? "Ending…" : "End session"}
              </button>
            )}
          </div>
        ))}
      {error && (
        <p className="settings-error" role="alert">
          {error}
          <button onClick={load} type="button">
            Retry
          </button>
        </p>
      )}
      <button
        className="settings-danger"
        disabled={loading || Boolean(busy)}
        onClick={revoke}
        type="button"
        value="all"
      >
        {busy === "all" ? "Signing out…" : "Sign out everywhere"}
      </button>
    </div>
  );
}
