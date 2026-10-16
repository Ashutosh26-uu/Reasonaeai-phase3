# `@reasonateai/deployment`

Provider-neutral release promotion and rollback for accepted project
checkpoints.

The package enforces the release boundary:

- only an evidence-accepted checkpoint can be promoted;
- a release descriptor records the source checkpoint, artifact digest, tenant
  scope, exposure decision, and run identity;
- the descriptor digest identifies the exact immutable release metadata;
- providers must return the same artifact digest, descriptor digest, release id,
  and exposure policy they were given;
- a deployment is not returned as ready until provider verification passes;
- public exposure requires both explicit approval and the public-exposure
  capability;
- rollback is scoped to the same organization and project and is verified
  before the previous release becomes active again.

`MemoryDeploymentProvider` is only a deterministic local/test adapter. A
production provider must implement `DeploymentProvider` and verify the
provider's health at the authorized stable URL. Durable deployment rows remain
owned by `@reasonateai/project-state`; `ReleaseManager` is safe to reconstruct
from those rows.