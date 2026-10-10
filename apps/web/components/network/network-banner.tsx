"use client";

import { Check, RefreshCw, WifiOff } from "lucide-react";
import { useCallback } from "react";
import { networkManager, useNetworkState } from "@/lib/network-state";

export function NetworkBanner() {
  const { status, secondsLeft } = useNetworkState();

  const handleRetry = useCallback(() => {
    networkManager.retryNow();
  }, []);

  if (status === "online") {
    return null;
  }

  const isRestored = status === "restored";
  const isReconnecting = status === "reconnecting";

  return (
    <aside
      aria-live="polite"
      className="pointer-events-none fixed top-4 left-1/2 z-50 -translate-x-1/2 transition-all duration-300 ease-out"
      role="status"
    >
      <div
        className={`pointer-events-auto flex items-center gap-2.5 rounded-full border px-3.5 py-1.5 font-medium text-xs shadow-lg backdrop-blur-md transition-colors ${
          isRestored
            ? "border-emerald-800 bg-emerald-950/80 text-emerald-200"
            : "border-border bg-popover text-popover-foreground"
        }`}
      >
        {isRestored ? (
          <>
            <span className="relative flex h-2 w-2">
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            <Check className="h-3.5 w-3.5 text-emerald-400" />
            <span>Connection restored</span>
          </>
        ) : (
          <>
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" />
            </span>
            <WifiOff className="h-3.5 w-3.5 text-amber-400" />
            <span>
              {isReconnecting ? (
                "Reconnecting…"
              ) : (
                <>
                  Offline • Retrying in{" "}
                  <span className="font-semibold text-amber-300 tabular-nums">
                    {secondsLeft}s
                  </span>
                </>
              )}
            </span>
            <button
              className="ml-1 flex cursor-pointer items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground transition-all hover:bg-accent hover:text-accent-foreground active:scale-95"
              disabled={isReconnecting}
              onClick={handleRetry}
              type="button"
            >
              <RefreshCw
                className={`h-3 w-3 ${isReconnecting ? "animate-spin" : ""}`}
              />
              <span>{isReconnecting ? "Checking…" : "Retry"}</span>
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
