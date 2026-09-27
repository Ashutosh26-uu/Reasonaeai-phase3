import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ArtifactId,
  ArtifactManifest,
} from "@reasonateai/contracts/execution-protocol";
import type {
  OrganizationId,
  ProjectId,
  RunId,
} from "@reasonateai/contracts/identity";

/** One tenant, one project, one artifact, shared by every suite. */
export const organizationId =
  "11111111-1111-4111-8111-111111111111" as OrganizationId;
export const otherOrganizationId =
  "99999999-9999-4999-8999-999999999999" as OrganizationId;
export const projectId = "22222222-2222-4222-8222-222222222222" as ProjectId;
export const otherProjectId =
  "88888888-8888-4888-8888-888888888888" as ProjectId;
export const artifactId = "33333333-3333-4333-8333-333333333333" as ArtifactId;
export const runId = "44444444-4444-4444-8444-444444444444" as RunId;

export const signingSecret = "artifact-store-fixture-secret";
export const otherSigningSecret = "artifact-store-other-secret";

export interface ManifestFixtureInput {
  readonly artifactId?: ArtifactId;
  readonly digest: string;
  readonly objectKey?: string;
  readonly organizationId?: OrganizationId;
  readonly projectId?: ProjectId;
  readonly runId?: RunId | null;
  readonly sha256?: string;
  readonly size: number;
}

/**
 * A manifest that describes one file. `objectKey` deliberately defaults to a
 * placeholder so a fixture never accidentally claims to describe the object a
 * test is writing; a test that wants that claim passes the real key.
 */
export function manifestFor(input: ManifestFixtureInput): ArtifactManifest {
  return {
    artifactId: input.artifactId ?? artifactId,
    buildSessionId: null,
    files: [
      {
        mediaType: "text/plain",
        objectKey: input.objectKey ?? `pending/${input.digest}`,
        path: "evidence/report.txt",
        sha256: input.sha256 ?? input.digest,
        size: input.size,
      },
    ],
    kind: "browser-evidence",
    occurredAt: "2026-09-25T00:00:00.000Z",
    organizationId: input.organizationId ?? organizationId,
    projectId: input.projectId ?? projectId,
    runId: input.runId === undefined ? runId : input.runId,
    schemaVersion: 1,
    totalSize: input.size,
  };
}

export async function createTemporaryRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "artifact-store-"));
}

/** The key resolved against a store root, as the store itself resolves it. */
export function objectPath(root: string, key: string): string {
  return join(root, ...key.split("/"));
}

/**
 * Returns the rejection an action produced. Used instead of a bare
 * `rejects.toThrow` when a test also asserts that no bytes came back.
 */
export async function captureFailure(
  action: () => Promise<unknown>
): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the action to fail, but it resolved.");
}
