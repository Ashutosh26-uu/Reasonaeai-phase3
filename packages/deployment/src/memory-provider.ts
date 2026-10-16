import type { DeploymentId } from "@reasonateai/contracts/execution";
import type { DeploymentProvider, ProviderDeployment } from "./provider.js";

/**
 * Deterministic provider for local rehearsal and tests only. It intentionally
 * has no network or production credentials; a real adapter must implement the
 * same contract and verify the provider's health before returning ready.
 */
export class MemoryDeploymentProvider implements DeploymentProvider {
  readonly name = "memory";
  private readonly deployments = new Map<string, ProviderDeployment>();

  readonly deploy: DeploymentProvider["deploy"] = ({
    deploymentId,
    descriptor,
    descriptorDigest,
  }) => {
    const deployment = this.createProviderDeployment(
      deploymentId,
      descriptor,
      descriptorDigest
    );
    this.deployments.set(descriptor.releaseId, deployment);
    return Promise.resolve(deployment);
  };

  readonly verify: DeploymentProvider["verify"] = ({ deployment }) =>
    Promise.resolve({
      checks: [`memory:${deployment.releaseId}`],
      healthy:
        this.deployments.get(deployment.releaseId)?.descriptorDigest ===
          deployment.descriptorDigest &&
        this.deployments.get(deployment.releaseId)?.artifactDigest ===
          deployment.artifactDigest,
    });

  readonly rollback: DeploymentProvider["rollback"] = ({
    deploymentId,
    descriptor,
    descriptorDigest,
  }) => {
    const deployment = this.createProviderDeployment(
      deploymentId,
      descriptor,
      descriptorDigest
    );
    this.deployments.set(descriptor.releaseId, deployment);
    return Promise.resolve(deployment);
  };

  private createProviderDeployment(
    deploymentId: DeploymentId,
    descriptor: Parameters<DeploymentProvider["deploy"]>[0]["descriptor"],
    descriptorDigest: string
  ): ProviderDeployment {
    return {
      artifactDigest: descriptor.artifactDigest,
      descriptorDigest,
      exposure: descriptor.exposure,
      providerReference: `memory://${deploymentId}`,
      releaseId: descriptor.releaseId,
      url: `https://preview.reasonate.local/releases/${descriptor.releaseId}`,
    };
  }
}
