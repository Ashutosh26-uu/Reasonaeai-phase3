import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type NetworkState, networkManager } from "./network-state";

describe("NetworkStateManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    networkManager.resetForTesting();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    networkManager.resetForTesting();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts in online state", () => {
    const state = networkManager.getState();
    expect(state.isOnline).toBe(true);
    expect(state.status).toBe("online");
  });

  it("transitions to offline with 5s countdown on initial failure", () => {
    const states: NetworkState[] = [];
    const unsubscribe = networkManager.subscribe((s) => states.push(s));

    networkManager.notifyNetworkFailure();

    const currentState = networkManager.getState();
    expect(currentState.status).toBe("offline");
    expect(currentState.isOnline).toBe(false);
    expect(currentState.secondsLeft).toBe(5);

    unsubscribe();
  });

  it("counts down seconds every tick", () => {
    networkManager.notifyNetworkFailure();
    expect(networkManager.getState().secondsLeft).toBe(5);

    vi.advanceTimersByTime(1000);
    expect(networkManager.getState().secondsLeft).toBe(4);

    vi.advanceTimersByTime(2000);
    expect(networkManager.getState().secondsLeft).toBe(2);
  });

  it("increases backoff interval exponentially on consecutive failed retries", async () => {
    // 1st failure -> 5s
    networkManager.notifyNetworkFailure();
    expect(networkManager.getState().secondsLeft).toBe(5);

    // Mock fetch failing on retry
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error"))
    );

    // Advance 5 seconds so automatic retry triggers
    await vi.advanceTimersByTimeAsync(5000);

    // 2nd failure -> 10s backoff
    expect(networkManager.getState().secondsLeft).toBe(10);
    expect(networkManager.getState().retryCount).toBe(1);

    // Advance 10 seconds -> 3rd failure -> 20s backoff
    await vi.advanceTimersByTimeAsync(10_000);
    expect(networkManager.getState().secondsLeft).toBe(20);
    expect(networkManager.getState().retryCount).toBe(2);

    // Advance 20 seconds -> 4th failure -> 40s backoff
    await vi.advanceTimersByTimeAsync(20_000);
    expect(networkManager.getState().secondsLeft).toBe(40);
    expect(networkManager.getState().retryCount).toBe(3);
  });

  it("recovers and transitions to restored then online on network success", () => {
    networkManager.notifyNetworkFailure();
    expect(networkManager.getState().status).toBe("offline");

    networkManager.notifyNetworkSuccess();
    expect(networkManager.getState().status).toBe("restored");
    expect(networkManager.getState().isOnline).toBe(true);

    // After 2.5 seconds, transitions back to online
    vi.advanceTimersByTime(2500);
    expect(networkManager.getState().status).toBe("online");
  });

  it("manual retry resets countdown and probes connectivity", async () => {
    networkManager.notifyNetworkFailure();
    expect(networkManager.getState().secondsLeft).toBe(5);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200 }))
    );

    const retryPromise = networkManager.retryNow();
    expect(networkManager.getState().status).toBe("reconnecting");

    const result = await retryPromise;
    expect(result).toBe(true);
    expect(networkManager.getState().status).toBe("restored");
  });
});
