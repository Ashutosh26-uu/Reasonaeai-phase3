import { BuildSessionIdSchema } from "@reasonateai/contracts/execution";
import { ArtifactIdSchema } from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import { describe, expect, it } from "vitest";
import {
  createImmutableReleaseDescriptor,
  decideExposure,
  ExposurePolicyError,
  ReleaseDeploymentError,
  ReleaseManager,
} from "../src/index.js";
import { MemoryDeploymentProvider } from "../src/memory-provider.js";

const organizationId = OrganizationIdSchema.parse(
  "00000000-0000-4000-8000-000000000001"
);
const projectId = ProjectIdSchema.parse("00000000-0000-4000-8000-000000000002");
const buildSessionId = BuildSessionIdSchema.parse(
  "00000000-0000-4000-8000-000000000003"
);
const runId = RunIdSchema.parse("00000000-0000-4000-8000-000000000004");
const artifactId = ArtifactIdSchema.parse(
  "00000000-0000-4000-8000-000000000005"
);
const digest = "a".repeat(64);
const occurredAt = "2026-09-30T12:00:00.000Z";
const MEMORY_RELEASE_URL = /^https:\/\/preview\.reasonate\.local\//;

function promoteInput(
  overrides: Partial<Parameters<ReleaseManager["promote"]>[0]> = {}
): Parameters<ReleaseManager["promote"]>[0] {
  return {
    artifactDigest: digest,
    artifactId,
    buildSessionId,
    organizationId,
    projectId,
    publicApproval: false,
    publicCapability: false,
    runId,
    sourceCheckpoint: "checkpoint:abc",
    verification: { accepted: true, evidence: ["verification://run/1"] },
    ...overrides,
  };
}

describe("release descriptors and exposure policy", () => {
  it("hashes the exact immutable descriptor", () => {
    const first = createImmutableReleaseDescriptor({
      artifactDigest: digest,
      artifactId,
      buildSessionId,
      exposure: "authenticated",
      occurredAt,
      organizationId,
      projectId,
      releaseId: "release-one",
      runId,
      sourceCheckpoint: "checkpoint:abc",
    });
    const same = createImmutableReleaseDescriptor({
      artifactDigest: digest,
      artifactId,
      buildSessionId,
      exposure: "authenticated",
      occurredAt,
      organizationId,
      projectId,
      releaseId: "release-one",
      runId,
      sourceCheckpoint: "checkpoint:abc",
    });
    const changed = createImmutableReleaseDescriptor({
      ...first.descriptor,
      sourceCheckpoint: "checkpoint:def",
    });

    expect(same.descriptorDigest).toBe(first.descriptorDigest);
    expect(changed.descriptorDigest).not.toBe(first.descriptorDigest);
  });

  it("defaults to authenticated and gates public exposure", () => {
    expect(decideExposure()).toEqual({
      exposure: "authenticated",
      requiresAudit: false,
    });
    expect(() =>
      decideExposure({ publicApproval: true, requested: "public" })
    ).toThrow(ExposurePolicyError);
    expect(
      decideExposure({
        publicApproval: true,
        publicCapability: true,
        requested: "public",
      })
    ).toEqual({ exposure: "public", requiresAudit: true });
  });
});

describe("release manager", () => {
  it("promotes only accepted evidence and verifies the provider result", async () => {
    const provider = new MemoryDeploymentProvider();
    const manager = new ReleaseManager({ now: () => occurredAt, provider });

    await expect(
      manager.promote(
        promoteInput({
          verification: { accepted: false, evidence: [] },
        })
      )
    ).rejects.toThrow(ReleaseDeploymentError);

    const release = await manager.promote(promoteInput());
    expect(release.status).toBe("ready");
    expect(release.descriptor.exposure).toBe("authenticated");
    expect(release.descriptor.artifactDigest).toBe(digest);
    expect(release.provider.url).toMatch(MEMORY_RELEASE_URL);
  });

  it("rejects a provider that changes the immutable release identity", async () => {
    const provider = new MemoryDeploymentProvider();
    const unsafeProvider = {
      ...provider,
      deploy: async (input: Parameters<typeof provider.deploy>[0]) => ({
        ...(await provider.deploy(input)),
        artifactDigest: "b".repeat(64),
      }),
    };
    const manager = new ReleaseManager({ provider: unsafeProvider });

    await expect(manager.promote(promoteInput())).rejects.toThrow(
      "different release bytes"
    );
  });

  it("rolls back to a verified release in the same project", async () => {
    const manager = new ReleaseManager({
      now: () => occurredAt,
      provider: new MemoryDeploymentProvider(),
    });
    const first = await manager.promote(
      promoteInput({ sourceCheckpoint: "cp-1" })
    );
    const second = await manager.promote(
      promoteInput({ sourceCheckpoint: "cp-2" })
    );

    const rolledBack = await manager.rollback({
      organizationId,
      projectId,
      targetReleaseId: first.descriptor.releaseId,
    });

    expect(rolledBack.descriptor.releaseId).toBe(first.descriptor.releaseId);
    expect(rolledBack.status).toBe("ready");
    expect(manager.list({ organizationId, projectId })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          descriptor: expect.objectContaining({
            releaseId: second.descriptor.releaseId,
          }),
          status: "rolled_back",
        }),
      ])
    );
  });

  it("refuses cross-project rollback", async () => {
    const manager = new ReleaseManager({
      now: () => occurredAt,
      provider: new MemoryDeploymentProvider(),
    });
    const release = await manager.promote(promoteInput());

    await expect(
      manager.rollback({
        organizationId,
        projectId: ProjectIdSchema.parse(
          "00000000-0000-4000-8000-000000000099"
        ),
        targetReleaseId: release.descriptor.releaseId,
      })
    ).rejects.toThrow("no active release");
  });
});
