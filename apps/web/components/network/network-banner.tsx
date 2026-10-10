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
        className={`pointer-events-auto flex items-center gap-2.5 rounded-full border px-4 py-1.5 font-medium font-sans text-xs shadow-none backdrop-blur-xl transition-colors ${
          isRestored
            ? "border-[rgba(214,255,87,0.3)] bg-[#0a0a0d]/95 text-[#d6ff57]"
            : "border-[rgba(255,77,0,0.3)] bg-[#0a0a0d]/95 text-[#edede9]"
        }`}
      >
        {isRestored ? (
          <>
            <span className="relative flex h-2 w-2">
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[#d6ff57]" />
            </span>
            <Check className="h-3.5 w-3.5 text-[#d6ff57]" />
            <span>Connection restored</span>
          </>
        ) : (
          <>
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#ff4d00] opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[#ff4d00]" />
            </span>
            <WifiOff className="h-3.5 w-3.5 text-[#ff4d00]" />
            <span>
              {isReconnecting ? (
                "Reconnecting…"
              ) : (
                <>
                  Offline • Retrying in{" "}
                  <span className="font-semibold text-[#ff4d00] tabular-nums">
                    {secondsLeft}s
                  </span>
                </>
              )}
            </span>
            <button
              className="ml-1 flex cursor-pointer items-center gap-1 rounded-full border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.06)] px-2.5 py-0.5 text-[#edede9] text-xs transition-all hover:border-[#d6ff57] hover:text-[#d6ff57] active:scale-95"
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
