// biome-ignore lint/performance/noBarrelFile: the package root is the public contract.
export {
  type ManagedRelease,
  type PromoteReleaseInput,
  ReleaseDeploymentError,
  ReleaseManager,
  type ReleaseVerificationInput,
  type RollbackReleaseInput,
} from "./manager.js";
export {
  decideExposure,
  type ExposurePolicyDecision,
  ExposurePolicyError,
  type ExposurePolicyInput,
} from "./policy.js";
export {
  type DeploymentProvider,
  type DeploymentVerification,
  type ProviderDeployment,
  ProviderDeploymentSchema,
  sameProviderDeployment,
} from "./provider.js";
export {
  createImmutableReleaseDescriptor,
  type ImmutableReleaseDescriptor,
  isReleaseId,
  isSha256Digest,
  type ReleaseDescriptor,
  type ReleaseDescriptorInput,
  ReleaseDescriptorSchema,
} from "./release.js";
