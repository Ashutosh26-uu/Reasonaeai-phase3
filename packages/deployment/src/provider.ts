import type { DeploymentId } from "@reasonateai/contracts/execution";
import { z } from "zod";
import type { ReleaseDescriptor } from "./release.js";

const SHA256_SCHEMA = z.string().regex(/^[a-f0-9]{64}$/);

export const ProviderDeploymentSchema = z.strictObject({
  artifactDigest: SHA256_SCHEMA,
  descriptorDigest: SHA256_SCHEMA,
  exposure: z.enum(["authenticated", "unlisted", "public"]),
  providerReference: z.string().min(1).max(512),
  releaseId: z.string().min(1).max(128),
  url: z.url(),
});
export type ProviderDeployment = z.infer<typeof ProviderDeploymentSchema>;

export interface DeploymentVerification {
  readonly checks: readonly string[];
  readonly healthy: boolean;
}

export interface DeploymentProvider {
  readonly deploy: (input: {
    readonly deploymentId: DeploymentId;
    readonly descriptor: Readonly<ReleaseDescriptor>;
    readonly descriptorDigest: string;
  }) => Promise<ProviderDeployment>;
  readonly name: string;
  readonly rollback: (input: {
    readonly deploymentId: DeploymentId;
    readonly descriptor: Readonly<ReleaseDescriptor>;
    readonly descriptorDigest: string;
    readonly replaced: ProviderDeployment;
  }) => Promise<ProviderDeployment>;
  readonly verify: (input: {
    readonly deployment: ProviderDeployment;
    readonly descriptor: Readonly<ReleaseDescriptor>;
  }) => Promise<DeploymentVerification>;
}

export function sameProviderDeployment(
  deployment: ProviderDeployment,
  descriptor: Readonly<ReleaseDescriptor>,
  descriptorDigest: string
): boolean {
  return (
    deployment.artifactDigest === descriptor.artifactDigest &&
    deployment.descriptorDigest === descriptorDigest &&
    deployment.exposure === descriptor.exposure &&
    deployment.releaseId === descriptor.releaseId
  );
}
