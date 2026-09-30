"use client";

import { Badge } from "@reasonateai/ui/components/badge";
import { Button } from "@reasonateai/ui/components/button";
import { cn } from "@reasonateai/ui/lib/utils";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Wifi,
  WifiOff,
} from "lucide-react";
import type {
  StreamConnectionState,
  StreamStateDetail,
} from "../../lib/run-event-stream";

export interface ConnectionStatusBadgeProps {
  className?: string | undefined;
  detail?: StreamStateDetail | undefined;
  onReconnect?: (() => void) | undefined;
  state: StreamConnectionState;
}

export function ConnectionStatusBadge({
  state,
  detail,
  onReconnect,
  className,
}: ConnectionStatusBadgeProps) {
  switch (state) {
    case "connected":
      return (
        <Badge
          className={cn(
            "flex items-center gap-1.5 border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 font-mono text-emerald-600 text-xs dark:text-emerald-400",
            className
          )}
          variant="outline"
        >
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          <Wifi className="size-3.5" />
          <span>Live Stream</span>
        </Badge>
      );

    case "connecting":
      return (
        <Badge
          className={cn(
            "flex items-center gap-1.5 border-sky-500/30 bg-sky-500/10 px-2.5 py-1 font-mono text-sky-600 text-xs dark:text-sky-400",
            className
          )}
          variant="outline"
        >
          <Loader2 className="size-3.5 animate-spin" />
          <span>Connecting...</span>
        </Badge>
      );

    case "reconnecting": {
      const attemptText = detail?.attempt ? ` (#${detail.attempt})` : "";
      return (
        <Badge
          className={cn(
            "flex items-center gap-1.5 border-amber-500/30 bg-amber-500/10 px-2.5 py-1 font-mono text-amber-600 text-xs dark:text-amber-400",
            className
          )}
          variant="outline"
        >
          <Loader2 className="size-3.5 animate-spin" />
          <span>Reconnecting{attemptText}...</span>
          {onReconnect && (
            <button
              className="ml-1 cursor-pointer underline hover:text-amber-500"
              onClick={onReconnect}
              type="button"
            >
              Retry now
            </button>
          )}
        </Badge>
      );
    }

    case "error":
      return (
        <div className={cn("flex items-center gap-2", className)}>
          <Badge
            className="flex items-center gap-1.5 border-rose-500/30 bg-rose-500/10 px-2.5 py-1 font-mono text-rose-600 text-xs dark:text-rose-400"
            variant="outline"
          >
            <AlertCircle className="size-3.5" />
            <span>Disconnected</span>
          </Badge>
          {onReconnect && (
            <Button
              className="flex h-6 items-center gap-1 px-2 text-xs"
              onClick={onReconnect}
              size="sm"
              variant="outline"
            >
              <RefreshCw className="size-3" />
              Reconnect
            </Button>
          )}
        </div>
      );

    case "closed":
      return (
        <Badge
          className={cn(
            "flex items-center gap-1.5 border-muted-foreground/30 bg-muted/40 px-2.5 py-1 font-mono text-muted-foreground text-xs",
            className
          )}
          variant="outline"
        >
          <CheckCircle2 className="size-3.5" />
          <span>Stream Ended</span>
        </Badge>
      );

    default:
      return (
        <Badge
          className={cn(
            "flex items-center gap-1.5 border-muted-foreground/20 font-mono text-muted-foreground text-xs",
            className
          )}
          variant="outline"
        >
          <WifiOff className="size-3.5" />
          <span>Idle</span>
        </Badge>
      );
  }
}
