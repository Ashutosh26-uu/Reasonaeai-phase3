import { createHash, randomUUID } from "node:crypto";
import { createTool } from "@mastra/core/tools";
import type { EvidenceRecord } from "@reasonateai/contracts/execution";
import {
  EvidenceKindSchema,
  EvidenceRecordSchema,
  EvidenceStatusSchema,
} from "@reasonateai/contracts/execution";
import type { ArtifactManifest } from "@reasonateai/contracts/execution-protocol";
import { ArtifactIdSchema } from "@reasonateai/contracts/execution-protocol";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { z } from "zod";
import { readRunScope } from "../run-scope.js";

export interface EvidenceToolOptions {
  store: () => ProjectStateStore;
}

export function createEvidenceTool(options: EvidenceToolOptions) {
  return createTool({
    description:
      "Record runtime evidence (screenshot, console log, network trace, test report, dom snapshot, security audit) linked to an artifact in project state.",
    execute: async (
      { content, kind, metadata, status, summary },
      context
    ): Promise<EvidenceRecord> => {
      const scope = readRunScope(context.requestContext);
      const artifactId = ArtifactIdSchema.parse(randomUUID());
      const contentBuffer = Buffer.from(content, "utf-8");
      const sha256 = createHash("sha256").update(contentBuffer).digest("hex");

      const manifest: ArtifactManifest = {
        artifactId,
        buildSessionId: scope.buildSessionId,
        files: [
          {
            mediaType: "text/plain",
            objectKey: `organizations/${scope.organizationId}/projects/${scope.projectId}/artifacts/${artifactId}/${kind}.txt`,
            path: `${kind}.txt`,
            sha256,
            size: contentBuffer.length,
          },
        ],
        kind,
        occurredAt: new Date().toISOString(),
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        runId: scope.runId,
        schemaVersion: 1,
        totalSize: contentBuffer.length,
      };

      const artifact = await options
        .store()
        .recordArtifact(manifest, "completed");

      const evidence = await options.store().recordEvidence({
        artifactId: artifact.artifactId,
        buildSessionId: scope.buildSessionId,
        kind,
        metadata: metadata ?? {},
        runId: scope.runId,
        scope: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
        },
        status,
        summary,
      });

      return EvidenceRecordSchema.parse(evidence);
    },
    id: "evidence",
    inputSchema: z.strictObject({
      content: z.string().min(1),
      kind: EvidenceKindSchema,
      metadata: z.record(z.string(), z.unknown()).optional(),
      status: EvidenceStatusSchema,
      summary: z.string().min(1).max(1024),
    }),
    outputSchema: EvidenceRecordSchema,
  });
}
