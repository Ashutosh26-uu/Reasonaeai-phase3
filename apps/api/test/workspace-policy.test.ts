import { DEFAULT_BUILD_SANDBOX_IMAGE } from "@reasonateai/contracts/sandbox";
import { describe, expect, it } from "vitest";
import {
  resolveBuildSandboxCacheVolume,
  resolveBuildSandboxImage,
  resolveBuildSandboxNetworkMode,
} from "../src/mastra/workspace.js";

describe("API build sandbox workspace policy", () => {
  it("uses the preloaded build image and validates operator overrides", () => {
    expect(resolveBuildSandboxImage({})).toBe(DEFAULT_BUILD_SANDBOX_IMAGE);
    expect(
      resolveBuildSandboxImage({
        REASONATE_BUILD_SANDBOX_IMAGE: " registry.example/build:2026.10 ",
      })
    ).toBe("registry.example/build:2026.10");
    expect(() =>
      resolveBuildSandboxImage({ REASONATE_BUILD_SANDBOX_IMAGE: "--help" })
    ).toThrow();
  });

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
    expect(
      resolveBuildSandboxNetworkMode({
        REASONATE_SANDBOX_NETWORK_MODE: "other",
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
