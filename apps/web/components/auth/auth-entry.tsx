"use client";
import { SessionViewSchema } from "@reasonateai/contracts/auth";
import { useEffect } from "react";
import { AuthGate } from "@/components/workspace/auth-gate";
import { request } from "@/lib/product-api";
export function AuthEntry({ mode }: { mode: "login" | "signup" }) {
  useEffect(() => {
    let cancelled = false;
    request("/v1/auth/session", SessionViewSchema.parse)
      .then(() => {
        if (!cancelled) {
          window.location.replace("/");
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return <AuthGate initialMode={mode} />;
}
