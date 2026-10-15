import { createHash } from "node:crypto";
import {
  type PromptAttachment,
  PromptAttachmentSchema,
} from "@reasonateai/contracts/execution";
import {
  ArtifactIdSchema,
  ArtifactManifestSchema,
} from "@reasonateai/contracts/execution-protocol";
import type {
  OrganizationId,
  ProjectId,
} from "@reasonateai/contracts/identity";
import type { ArtifactStore } from "./index.js";
import { artifactObjectKeyFor, sha256Hex } from "./keys.js";

export interface AttachmentScope {
  organizationId: OrganizationId;
  projectId: ProjectId;
}

/** Originals are immutable objects; journals retain the original payload for recovery. */
export async function preserveAttachment(
  store: ArtifactStore,
  scope: AttachmentScope,
  file: PromptAttachment
) {
  PromptAttachmentSchema.parse(file);
  const content = Buffer.from(
    file.data.slice(file.data.indexOf(",") + 1),
    "base64"
  );
  const digest = sha256Hex(content);
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        scope.organizationId,
        scope.projectId,
        file.filename,
        file.mediaType,
        digest,
      ])
    )
    .digest("hex");
  const artifactId = ArtifactIdSchema.parse(
    `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  );
  const key = artifactObjectKeyFor({ ...scope, artifactId, digest });
  const manifest = ArtifactManifestSchema.parse({
    ...scope,
    artifactId,
    buildSessionId: null,
    files: [
      {
        mediaType: file.mediaType,
        objectKey: key,
        path: file.filename,
        sha256: digest,
        size: content.length,
      },
    ],
    kind: "user-attachment",
    occurredAt: new Date().toISOString(),
    runId: null,
    schemaVersion: 1,
    totalSize: content.length,
  });
  await store.put({ ...scope, content, manifest });
  return { content: await store.read({ ...scope, key }), digest, key };
}
