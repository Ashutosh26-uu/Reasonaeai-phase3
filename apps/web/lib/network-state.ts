"use client";

import { useEffect, useState } from "react";

export type NetworkStatus = "online" | "offline" | "reconnecting" | "restored";

export interface NetworkState {
  isOnline: boolean;
  retryCount: number;
  secondsLeft: number;
  status: NetworkStatus;
}

const BACKOFF_INTERVALS = [5, 10, 20, 40, 60];
const PING_TIMEOUT_MS = 4000;
const RESTORED_DISPLAY_MS = 2500;

type Listener = (state: NetworkState) => void;

export class NetworkStateManager {
  private status: NetworkStatus = "online";
  private retryCount = 0;
  private secondsLeft = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private restoredTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<Listener>();

  resetForTesting() {
    this.clearTimer();
    if (this.restoredTimeout) {
      clearTimeout(this.restoredTimeout);
      this.restoredTimeout = null;
    }
    this.status = "online";
    this.retryCount = 0;
    this.secondsLeft = 0;
    this.listeners.clear();
  }

  constructor() {
    if (typeof window !== "undefined") {
      this.init();
    }
  }

  private init() {
    window.addEventListener("online", () => {
      this.handleBrowserOnline();
    });

    window.addEventListener("offline", () => {
      this.handleBrowserOffline();
    });

    if (!navigator.onLine) {
      this.handleBrowserOffline();
    }
  }

  getState(): NetworkState {
    return {
      isOnline: this.status === "online" || this.status === "restored",
      retryCount: this.retryCount,
      secondsLeft: this.secondsLeft,
      status: this.status,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  private getIntervalForAttempt(attempt: number): number {
    const index = Math.min(attempt, BACKOFF_INTERVALS.length - 1);
    return BACKOFF_INTERVALS[index] ?? 60;
  }

  private startCountdown(seconds: number) {
    this.clearTimer();
    this.secondsLeft = seconds;
    this.emit();

    this.timer = setInterval(() => {
      this.secondsLeft -= 1;
      if (this.secondsLeft <= 0) {
        this.clearTimer();
        this.retryNow();
      } else {
        this.emit();
      }
    }, 1000);
  }

  private clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private handleBrowserOnline() {
    // When the browser detects Wi-Fi/connection restored, don't wait for countdown: immediately verify
    this.retryNow();
  }

  private handleBrowserOffline() {
    if (this.status === "offline" || this.status === "reconnecting") {
      return;
    }
    this.status = "offline";
    this.retryCount = 0;
    this.startCountdown(this.getIntervalForAttempt(0));
  }

  notifyNetworkFailure() {
    if (this.restoredTimeout) {
      clearTimeout(this.restoredTimeout);
      this.restoredTimeout = null;
    }

    if (this.status === "online" || this.status === "restored") {
      this.status = "offline";
      this.retryCount = 0;
      this.startCountdown(this.getIntervalForAttempt(0));
    } else if (this.status === "reconnecting") {
      this.status = "offline";
      this.retryCount += 1;
      this.startCountdown(this.getIntervalForAttempt(this.retryCount));
    }
  }

  notifyNetworkSuccess() {
    if (this.status === "offline" || this.status === "reconnecting") {
      this.clearTimer();
      this.status = "restored";
      this.retryCount = 0;
      this.secondsLeft = 0;
      this.emit();

      if (this.restoredTimeout) {
        clearTimeout(this.restoredTimeout);
      }
      this.restoredTimeout = setTimeout(() => {
        this.status = "online";
        this.restoredTimeout = null;
        this.emit();
      }, RESTORED_DISPLAY_MS);
    }
  }

  async retryNow(): Promise<boolean> {
    this.clearTimer();
    this.status = "reconnecting";
    this.secondsLeft = 0;
    this.emit();

    const reachable = await this.probeConnectivity();
    if (reachable) {
      this.notifyNetworkSuccess();
      return true;
    }

    this.status = "offline";
    this.retryCount += 1;
    this.startCountdown(this.getIntervalForAttempt(this.retryCount));
    return false;
  }

  private async probeConnectivity(): Promise<boolean> {
    if (typeof window === "undefined") {
      return true;
    }
    if (!navigator.onLine) {
      return false;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
      // Fast probe to server endpoint
      const res = await fetch("/v1/auth/session", {
        headers: { "x-reasonate-probe": "1" },
        method: "HEAD",
        signal: controller.signal,
      }).catch(() => null);

      clearTimeout(timeout);
      // Any response from server (even 401 unauthenticated or 200) means network is reachable
      return res !== null;
    } catch {
      return false;
    }
  }
}

export const networkManager = new NetworkStateManager();

export function useNetworkState(): NetworkState {
  const [state, setState] = useState<NetworkState>(() =>
    networkManager.getState()
  );

  useEffect(() => networkManager.subscribe(setState), []);

  return state;
}
