import { describe, expect, it } from "vitest";
import {
  resolveBuildSandboxCacheVolume,
  resolveBuildSandboxNetworkMode,
} from "../src/workspace.js";

describe("build sandbox workspace policy", () => {
  it("resolves network mode with default to bridge", () => {
    expect(resolveBuildSandboxNetworkMode({})).toBe("bridge");
    expect(
      resolveBuildSandboxNetworkMode({ REASONATE_SANDBOX_NETWORK_MODE: "none" })
    ).toBe("none");
    expect(
      resolveBuildSandboxNetworkMode({ SANDBOX_NETWORK_MODE: "none" })
    ).toBe("none");
    expect(
      resolveBuildSandboxNetworkMode({
        REASONATE_SANDBOX_NETWORK_MODE: "bridge",
      })
    ).toBe("bridge");
    // Any unrecognized value defaults safely to bridge
    expect(
      resolveBuildSandboxNetworkMode({
        REASONATE_SANDBOX_NETWORK_MODE: "anything_else",
      })
    ).toBe("bridge");
  });

  it("resolves package cache volume from environment", () => {
    expect(resolveBuildSandboxCacheVolume({})).toBeUndefined();
    expect(
      resolveBuildSandboxCacheVolume({
        REASONATE_PACKAGE_CACHE_VOLUME: "  ",
      })
    ).toBeUndefined();
    expect(
      resolveBuildSandboxCacheVolume({
        REASONATE_PACKAGE_CACHE_VOLUME: "reasonate-npm-cache",
      })
    ).toBe("reasonate-npm-cache");
    expect(
      resolveBuildSandboxCacheVolume({
        SANDBOX_CACHE_VOLUME: "reasonate-npm-cache-legacy",
      })
    ).toBe("reasonate-npm-cache-legacy");
  });

  it("strictly rejects docker.sock in package cache volume to prevent host socket escape", () => {
    expect(() =>
      resolveBuildSandboxCacheVolume({
        REASONATE_PACKAGE_CACHE_VOLUME: "/var/run/docker.sock",
      })
    ).toThrow("Mounting the host Docker socket is forbidden.");

    expect(() =>
      resolveBuildSandboxCacheVolume({
        SANDBOX_CACHE_VOLUME: "custom_docker.sock_vol",
      })
    ).toThrow("Mounting the host Docker socket is forbidden.");
  });
});
