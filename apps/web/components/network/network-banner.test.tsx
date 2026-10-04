import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { networkManager } from "@/lib/network-state";
import { NetworkBanner } from "./network-banner";

describe("NetworkBanner Component", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    networkManager.resetForTesting();
  });

  afterEach(() => {
    networkManager.resetForTesting();
    vi.useRealTimers();
  });

  it("renders nothing when online", () => {
    const html = renderToStaticMarkup(<NetworkBanner />);
    expect(html).toBe("");
  });

  it("renders offline banner with countdown when network fails", () => {
    networkManager.notifyNetworkFailure();

    const html = renderToStaticMarkup(<NetworkBanner />);
    expect(html).toContain("Offline • Retrying in");
    expect(html).toContain("5s");
    expect(html).toContain("Retry");
    expect(html).toContain('role="status"');
  });

  it("renders restored indicator when network is back", () => {
    networkManager.notifyNetworkFailure();
    networkManager.notifyNetworkSuccess();

    const html = renderToStaticMarkup(<NetworkBanner />);
    expect(html).toContain("Connection restored");
  });
});
