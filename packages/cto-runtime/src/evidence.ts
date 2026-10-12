/**
 * Evidence production: browser verification results recorded as artifacts.
 *
 * A `browser_verify` call ends with a decision — passed, failed, or errored —
 * and that decision was previously visible only inside the run's transcript.
 * The product's evidence chain requires the opposite: a verification is
 * reproducible only while its own report and screenshot exist as immutable,
 * tenant-attributable objects that a user can list and download later.
 *
 * This recorder is the path from result to artifact. Everything goes through
 * the same immutable `@reasonateai/artifact-store` the upload routes use: the
 * report is a JSON document, the screenshot is the PNG bytes the driver
 * captured, and both are described by one validated manifest with
 * `kind: "browser-evidence"`. Digests are computed from the bytes received,
 * keys only from the store's own builder, and bytes are addressed under the
 * verified run's tenant scope, so recorded evidence is exactly as immutable
 * and as tenant-confined as uploaded artifacts.
 *
 * The store accepts one object per `put`, so a multi-file artifact is one
 * manifest over files the recorder put individually; each file's declaration
 * is derived from the bytes the store actually accepted.
 */

import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "@reasonateai/artifact-store";
import { artifactObjectKeyFor, sha256Hex } from "@reasonateai/artifact-store";
import {
  type ArtifactFile,
  ArtifactIdSchema,
  type ArtifactManifest,
  ArtifactManifestSchema,
} from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
} from "@reasonateai/contracts/identity";
import type { RunScope } from "./run-scope.js";

/** The manifest kind every verification artifact carries. */
export const EVIDENCE_KIND = "browser-evidence";
const REPORT_FILE_PATH = "evidence/report.json";
const REPORT_MEDIA_TYPE = "application/json";
const SCREENSHOT_FILE_PATH = "evidence/screenshot.png";
const SCREENSHOT_MEDIA_TYPE = "image/png";

/** What one verification contributes, independent of how it was driven. */
export interface EvidenceInput {
  /**
   * The verification report: status, url, title, httpStatus, durationMs,
   * passed, summary, console and network observations. Embedded as-is, plus
   * the manifest artifact id when a screenshot file exists.
   */
  readonly report: {
    readonly [key: string]: unknown;
  };
  /** The verified scope the evidence belongs to. */
  readonly scope: RunScope;
  /** Base64 PNG the driver captured, when it captured one. */
  readonly screenshotBase64?: string | null | undefined;
}

/** What recording produced: the artifact id, the reconstructed manifest, and the object keys' digests. */
export interface EvidenceArtifact {
  readonly artifactId: string;
  /** The validated manifest describing what was stored. */
  readonly manifest: ArtifactManifest;
}

export interface CreateEvidenceRecorderInput {
  /** The immutable artifact store the bytes are put through. */
  readonly artifacts: ArtifactStore;
  /**
   * Persists one artifact's validated manifest so a user-facing listing and
   * download can later resolve the bytes. Throwing means "not recorded"; the
   * caller composes whether that constitutes failure.
   */
  readonly record?: ((manifest: ArtifactManifest) => Promise<void>) | undefined;
}

export interface EvidenceRecorder {
  /**
   * Put one verification's report — and, when one was captured, its
   * screenshot PNG — through the immutable store under one artifact id,
   * described by a validated manifest, and persist that manifest.
   *
   * Returns what was produced, or `undefined` when neither file could be
   * put through (storage refused), which the caller composes as a recorded
   * failure of the verification infrastructure, never of the verdict itself.
   */
  readonly record: (
    input: EvidenceInput
  ) => Promise<EvidenceArtifact | undefined>;
}

/** Decode base64 to bytes, or undefined when it is not decodable. */
function decodeScreenshot(
  screenshotBase64: string | null | undefined
): Buffer | undefined {
  if (typeof screenshotBase64 !== "string" || screenshotBase64.length === 0) {
    return undefined;
  }
  try {
    const bytes = Buffer.from(screenshotBase64, "base64");
    return bytes.byteLength > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

export function createEvidenceRecorder(
  input: CreateEvidenceRecorderInput
): EvidenceRecorder {
  const put: EvidenceRecorder["record"] = async (evidence) => {
    const { scope } = evidence;
    const screenshot = decodeScreenshot(evidence.screenshotBase64);
    const artifactId = ArtifactIdSchema.parse(randomUUID());
    const organizationId = OrganizationIdSchema.parse(scope.organizationId);
    const projectId = ProjectIdSchema.parse(scope.projectId);

    // The report file. It references the screenshot by path rather than
    // embedding its bytes, so the JSON stays readable and the PNG stays PNG.
    const reportBody = Buffer.from(
      JSON.stringify(
        {
          ...evidence.report,
          artifactId,
          ...(screenshot === undefined
            ? {}
            : { screenshot: { kind: "png", path: SCREENSHOT_FILE_PATH } }),
        },
        null,
        2
      ),
      "utf-8"
    );

    /** One put per file; each declaration survives the store's own check. */
    const puts: {
      readonly bytes: Buffer;
      readonly file: ArtifactFile;
    }[] = [];

    const reportDigest = sha256Hex(reportBody);
    puts.push({
      bytes: reportBody,
      file: {
        mediaType: REPORT_MEDIA_TYPE,
        objectKey: artifactObjectKeyFor({
          artifactId,
          digest: reportDigest,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
        }),
        path: REPORT_FILE_PATH,
        sha256: reportDigest,
        size: reportBody.byteLength,
      },
    });

    if (screenshot !== undefined) {
      const digest = sha256Hex(screenshot);
      puts.push({
        bytes: screenshot,
        file: {
          mediaType: SCREENSHOT_MEDIA_TYPE,
          objectKey: artifactObjectKeyFor({
            artifactId,
            digest,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
          }),
          path: SCREENSHOT_FILE_PATH,
          sha256: digest,
          size: screenshot.byteLength,
        },
      });
    }

    // Both files go in before the manifest is minted: a manifest that
    // describes fewer files than the ones stored would understate the
    // artifact, and one that describes files the store refused would lie.
    const storedResults = await Promise.all(
      puts.map((entry) =>
        input.artifacts.put({
          content: new Uint8Array(entry.bytes),
          // The store only reads the manifest's scope from each put; the
          // complete multi-file manifest is built after every put succeeds.
          manifest: {
            artifactId,
            buildSessionId: scope.buildSessionId,
            files: [entry.file],
            kind: EVIDENCE_KIND,
            occurredAt: new Date().toISOString(),
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            runId: scope.runId,
            schemaVersion: 1,
            totalSize: entry.file.size,
          },
          organizationId,
          projectId,
        })
      )
    );

    const storedFiles: ArtifactFile[] = [];

    for (let i = 0; i < puts.length; i += 1) {
      const entry = puts[i];
      const stored = storedResults[i];

      if (entry === undefined || stored === undefined) {
        throw new Error(
          "Artifact storage did not return every expected result."
        );
      }

      if (
        stored.digest !== entry.file.sha256 ||
        stored.bytes !== entry.file.size
      ) {
        throw new Error(
          `Artifact storage returned a digest that does not match the ${entry.file.path} content.`
        );
      }

      storedFiles.push(entry.file);
    }

    const manifest: ArtifactManifest = ArtifactManifestSchema.parse({
      artifactId,
      buildSessionId: scope.buildSessionId,
      files: storedFiles,
      kind: EVIDENCE_KIND,
      occurredAt: new Date().toISOString(),
      organizationId,
      projectId,
      runId: scope.runId,
      schemaVersion: 1,
      totalSize: storedFiles.reduce((sum, file) => sum + file.size, 0),
    });

    if (input.record !== undefined) {
      await input.record(manifest);
    }

    return { artifactId, manifest };
  };

  return { record: put };
}

/** The sha256 the manifest declares for a file at a path, when present. */
export function evidenceDigestFor(
  manifest: ArtifactManifest,
  path: string
): string | undefined {
  return manifest.files.find((file: ArtifactFile) => file.path === path)
    ?.sha256;
}
