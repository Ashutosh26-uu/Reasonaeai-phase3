import { randomUUID } from "node:crypto";
import type { BuildSessionId } from "@reasonateai/contracts/execution";
import {
  type DeploymentExposure,
  type DeploymentId,
  DeploymentIdSchema,
} from "@reasonateai/contracts/execution";
import type { ArtifactId } from "@reasonateai/contracts/execution-protocol";
import type {
  OrganizationId,
  ProjectId,
  RunId,
} from "@reasonateai/contracts/identity";
import { decideExposure, type ExposurePolicyInput } from "./policy.js";
import {
  type DeploymentProvider,
  type DeploymentVerification,
  type ProviderDeployment,
  ProviderDeploymentSchema,
  sameProviderDeployment,
} from "./provider.js";
import {
  createImmutableReleaseDescriptor,
  type ImmutableReleaseDescriptor,
  type ReleaseDescriptor,
} from "./release.js";

export interface ReleaseVerificationInput {
  readonly accepted: boolean;
  readonly evidence: readonly string[];
}

export interface PromoteReleaseInput extends ExposurePolicyInput {
  readonly artifactDigest: string;
  readonly artifactId: ArtifactId;
  readonly buildSessionId: BuildSessionId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly sourceCheckpoint: string;
  readonly verification: ReleaseVerificationInput;
}

export interface ManagedRelease {
  readonly deploymentId: DeploymentId;
  readonly descriptor: Readonly<ReleaseDescriptor>;
  readonly descriptorDigest: string;
  readonly provider: ProviderDeployment;
  readonly status: "ready" | "rolled_back" | "superseded";
  readonly verification: DeploymentVerification;
}

export class ReleaseDeploymentError extends Error {
  override readonly name = "ReleaseDeploymentError";
}

interface MutableManagedRelease extends Omit<ManagedRelease, "status"> {
  provider: ProviderDeployment;
  status: ManagedRelease["status"];
  verification: DeploymentVerification;
}

interface ReleaseManagerOptions {
  readonly now?: () => string;
  readonly onExposureDecision?: (input: {
    readonly deploymentId: string;
    readonly exposure: DeploymentExposure;
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
  }) => Promise<void> | void;
  readonly provider: DeploymentProvider;
}

export interface RollbackReleaseInput {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly targetReleaseId: string;
}

/**
 * Orchestrates promotion and recovery while keeping provider state behind one
 * contract. Durable deployment rows belong in project-state; this manager is a
 * small process-local coordinator that can be reconstructed from those rows.
 */
export class ReleaseManager {
  private readonly activeByProject = new Map<string, string>();
  private readonly releases = new Map<string, MutableManagedRelease>();
  private readonly now: () => string;
  private readonly onExposureDecision:
    | ReleaseManagerOptions["onExposureDecision"]
    | undefined;
  private readonly provider: DeploymentProvider;

  constructor(options: ReleaseManagerOptions) {
    this.provider = options.provider;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onExposureDecision = options.onExposureDecision;
  }

  async promote(input: PromoteReleaseInput): Promise<ManagedRelease> {
    if (
      input.verification.accepted !== true ||
      input.verification.evidence.length === 0
    ) {
      throw new ReleaseDeploymentError(
        "Only an evidence-accepted checkpoint can be promoted."
      );
    }

    const policy = decideExposure(input);
    const deploymentId = DeploymentIdSchema.parse(randomUUID());
    const releaseId = `release-${deploymentId}`;
    await this.onExposureDecision?.({
      deploymentId,
      exposure: policy.exposure,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });

    const immutable = createImmutableReleaseDescriptor({
      artifactDigest: input.artifactDigest,
      artifactId: input.artifactId,
      buildSessionId: input.buildSessionId,
      exposure: policy.exposure,
      occurredAt: this.now(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      releaseId,
      runId: input.runId,
      sourceCheckpoint: input.sourceCheckpoint,
    });

    const providerDeployment = ProviderDeploymentSchema.parse(
      await this.provider.deploy({
        deploymentId,
        descriptor: immutable.descriptor,
        descriptorDigest: immutable.descriptorDigest,
      })
    );
    this.assertProviderResult(providerDeployment, immutable);
    const verification = await this.provider.verify({
      deployment: providerDeployment,
      descriptor: immutable.descriptor,
    });
    if (!verification.healthy) {
      throw new ReleaseDeploymentError(
        `Provider ${this.provider.name} failed release verification.`
      );
    }

    const scope = scopeKey(input.organizationId, input.projectId);
    const previousId = this.activeByProject.get(scope);
    if (previousId !== undefined) {
      const previous = this.releases.get(previousId);
      if (previous !== undefined) {
        previous.status = "superseded";
      }
    }

    const managed: MutableManagedRelease = {
      deploymentId,
      descriptor: immutable.descriptor,
      descriptorDigest: immutable.descriptorDigest,
      provider: providerDeployment,
      status: "ready",
      verification,
    };
    this.releases.set(releaseId, managed);
    this.activeByProject.set(scope, releaseId);
    return managed;
  }

  async rollback(input: RollbackReleaseInput): Promise<ManagedRelease> {
    const scope = scopeKey(input.organizationId, input.projectId);
    const currentId = this.activeByProject.get(scope);
    if (currentId === undefined) {
      throw new ReleaseDeploymentError(
        "There is no active release to roll back."
      );
    }
    if (currentId === input.targetReleaseId) {
      throw new ReleaseDeploymentError(
        "The active release cannot be its own rollback target."
      );
    }

    const current = this.releases.get(currentId);
    const target = this.releases.get(input.targetReleaseId);
    if (current === undefined || target === undefined) {
      throw new ReleaseDeploymentError(
        "The release is not known to this manager."
      );
    }
    if (
      target.descriptor.organizationId !== input.organizationId ||
      target.descriptor.projectId !== input.projectId
    ) {
      throw new ReleaseDeploymentError(
        "A release cannot be rolled back across organization or project scope."
      );
    }

    const providerDeployment = ProviderDeploymentSchema.parse(
      await this.provider.rollback({
        deploymentId: target.deploymentId,
        descriptor: target.descriptor,
        descriptorDigest: target.descriptorDigest,
        replaced: current.provider,
      })
    );
    this.assertProviderResult(providerDeployment, {
      descriptor: target.descriptor,
      descriptorDigest: target.descriptorDigest,
    });
    const verification = await this.provider.verify({
      deployment: providerDeployment,
      descriptor: target.descriptor,
    });
    if (!verification.healthy) {
      throw new ReleaseDeploymentError(
        `Provider ${this.provider.name} failed rollback verification.`
      );
    }

    current.status = "rolled_back";
    target.status = "ready";
    target.provider = providerDeployment;
    target.verification = verification;
    this.activeByProject.set(scope, target.descriptor.releaseId);
    return target;
  }

  list(input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
  }): readonly ManagedRelease[] {
    const values = [...this.releases.values()].filter(
      (release) =>
        release.descriptor.organizationId === input.organizationId &&
        release.descriptor.projectId === input.projectId
    );
    return values;
  }

  private assertProviderResult(
    deployment: ProviderDeployment,
    immutable: Pick<
      ImmutableReleaseDescriptor,
      "descriptor" | "descriptorDigest"
    >
  ): void {
    if (
      !sameProviderDeployment(
        deployment,
        immutable.descriptor,
        immutable.descriptorDigest
      )
    ) {
      throw new ReleaseDeploymentError(
        "The provider returned a deployment for different release bytes or policy."
      );
    }
  }
}

function scopeKey(organizationId: string, projectId: string): string {
  return `${organizationId.toLowerCase()}:${projectId.toLowerCase()}`;
}
