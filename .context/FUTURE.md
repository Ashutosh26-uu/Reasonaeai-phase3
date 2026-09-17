# Future Product Work

This file records accepted product direction that is intentionally outside the active phase. It is not an implementation queue and does not authorize speculative scaffolding.

Promoting an item requires:

1. Moving it into [`PHASE.md`](./PHASE.md) with scope and observable acceptance criteria.
2. Updating [`SPEC.md`](./SPEC.md) if the current product contract or technology decisions change.
3. Removing or narrowing the item here in the same change.

Rejecting an item requires recording the decision and reason before removing it.

## Identity and enterprise administration

- Passkey/WebAuthn enrollment, authentication, recovery, and device management.
- TOTP MFA, one-time recovery codes, and policy-driven step-up authentication.
- Enterprise SAML 2.0 and OIDC federation.
- Verified-domain discovery and organization-controlled just-in-time provisioning.
- SCIM user and group provisioning/deprovisioning.
- Organization security policies for session lifetime, allowed identity providers, MFA, network location, and agent permissions.
- Administrative security dashboards, anomaly response, and compliance exports.
- Fine-grained custom roles after the stable permission model demonstrates that predefined roles are insufficient.

## Generation targets

- Native Android application generation and emulator/device verification.
- Native iOS application generation and simulator/device verification.
- Additional programming languages and application frameworks selected from measured demand.
- Cross-platform desktop application generation.

## Agent capabilities

- Safe user-authored executable skills after isolation, provenance, review, signing, permission, and revocation controls exist.
- Additional specialist models selected through repeatable cost-per-verified-task evaluation.
- More advanced multi-agent orchestration only where measurements show bounded temporary delegation is insufficient.
- Organization-managed agent policies, model allowlists, and budget controls.

## Retrieval and memory

- Embedding-based retrieval or a vector database only after measured failures of structured selectors, full-text search, and scoped memory retrieval.
- Organization knowledge sources with explicit provenance, freshness, authorization, and deletion behavior.
- Long-term personalized behavior with transparent memory inspection, correction, expiry, and opt-out.

## Deployment and operations

- Fully autonomous production-cloud deployment after approval, secret, tenancy, audit, rollback, cost, and provider-isolation controls are proven.
- Additional sandbox providers behind the stable `SandboxProvider` contract.
- Multi-region execution, data residency, disaster recovery, and enterprise retention controls.
- Customer-controlled cloud accounts and private network connectivity.
- Policy-controlled scheduled and event-triggered agent runs.

## Collaboration and governance

- Real-time collaborative specification and plan editing.
- Configurable approval workflows and separation of duties.
- Portfolio-level project templates, reusable policies, and organization architecture standards.
- Public or partner extension marketplace with signing, isolation, review, permissions, and revocation.

## Explicit non-direction

The following are not planned unless new evidence changes the product architecture:

- A permanent hierarchy of architect, frontend, backend, QA, and DevOps agent services.
- Unbounded autonomous execution, retries, spending, or network access.
- A vector database in the critical path without measured retrieval need.
- Authentication or authorization implemented independently inside each application or resource handler.
