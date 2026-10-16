import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalArtifactStore } from "@reasonateai/artifact-store/local";
import type { ArtifactManifest } from "@reasonateai/contracts/execution-protocol";
import { describe, expect, it } from "vitest";
import { createEvidenceRecorder } from "../src/evidence.js";
import type { RunScope } from "../src/run-scope.js";

const SHA256_FILENAME_REGEX = /^[a-f0-9]{64}$/;

const scope = {
  buildSessionId: "55555555-5555-4555-8555-555555555555",
  organizationId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  runId: "44444444-4444-4444-8444-444444444444",
} as RunScope;

/** A 1x1 transparent PNG, same shape the driver's placeholder takes. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const report = {
  durationMs: 150,
  errors: [],
  httpStatus: 200,
  passed: true,
  status: "passed",
  summary: "Mock browser verification passed.",
  title: "Mock App Title",
  url: "http://127.0.0.1:3000/",
};

/** Find a stored content-addressed object without awaiting inside a loop. */
function findObjectFile(root: string): Promise<string | undefined> {
  return findInDirs([root]);
}

async function findInDirs(directories: string[]): Promise<string | undefined> {
  if (directories.length === 0) {
    return undefined;
  }

  const entriesPerDir = await Promise.all(
    directories.map((dir) => readdir(dir, { withFileTypes: true }))
  );

  const nextDirectories: string[] = [];

  for (let i = 0; i < directories.length; i += 1) {
    const dir = directories[i];
    const entries = entriesPerDir[i];

    if (dir === undefined || entries === undefined) {
      continue;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        nextDirectories.push(path);
      } else if (entry.isFile() && SHA256_FILENAME_REGEX.test(entry.name)) {
        return path;
      }
    }
  }

  if (nextDirectories.length === 0) {
    return undefined;
  }

  return findInDirs(nextDirectories);
}

describe("evidence recorder", () => {
  it("puts a report and screenshot through the real store and records the manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-"));
    const manifests: ArtifactManifest[] = [];
    const recorder = createEvidenceRecorder({
      artifacts: createLocalArtifactStore({ root }),
      record: (manifest) => {
        manifests.push(manifest);
        return Promise.resolve();
      },
    });

    const artifact = await recorder.record({
      report,
      scope,
      screenshotBase64: PNG_BASE64,
    });

    expect(artifact).toBeDefined();
    if (!artifact) {
      return;
    }

    expect(manifests).toHaveLength(1);
    const [firstManifest] = manifests;
    if (!firstManifest) {
      throw new Error("expected an evidence manifest");
    }

    expect(firstManifest.kind).toBe("browser-evidence");
    expect(firstManifest.artifactId).toBe(artifact.artifactId);
    expect(firstManifest.files).toHaveLength(2);

    const paths = firstManifest.files.map((file) => file.path).sort();
    expect(paths).toEqual(["evidence/report.json", "evidence/screenshot.png"]);

    // The screenshot bytes should be identical to what the driver captured.
    const screenshotFile = firstManifest.files.find(
      (file) => file.path === "evidence/screenshot.png"
    );
    if (!screenshotFile) {
      throw new Error("expected the screenshot file");
    }

    const stored = await readFile(
      join(root, ...screenshotFile.objectKey.split("/"))
    );
    expect(stored.toString("base64")).toBe(PNG_BASE64);
    expect(screenshotFile.mediaType).toBe("image/png");

    // The report is valid JSON and names the artifact it belongs to.
    const reportFile = firstManifest.files.find(
      (file) => file.path === "evidence/report.json"
    );
    if (!reportFile) {
      throw new Error("expected the report file");
    }

    const storedReport = JSON.parse(
      await readFile(join(root, ...reportFile.objectKey.split("/")), "utf-8")
    );
    expect(storedReport.url).toBe(report.url);
    expect(storedReport.artifactId).toBe(artifact.artifactId);
    expect(storedReport.screenshot).toEqual({
      kind: "png",
      path: "evidence/screenshot.png",
    });

    await rm(root, { force: true, recursive: true });
  });

  it("records a report-only artifact when no screenshot was captured", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-"));
    const manifests: ArtifactManifest[] = [];
    const recorder = createEvidenceRecorder({
      artifacts: createLocalArtifactStore({ root }),
      record: (manifest) => {
        manifests.push(manifest);
        return Promise.resolve();
      },
    });

    const artifact = await recorder.record({ report, scope });

    expect(artifact).toBeDefined();
    const [firstManifest] = manifests;
    expect(firstManifest?.files).toHaveLength(1);
    expect(firstManifest?.files[0]?.mediaType).toBe("application/json");

    await rm(root, { force: true, recursive: true });
  });

  it("keeps stored bytes when the manifest record fails and the failure propagates", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-"));
    const recorder = createEvidenceRecorder({
      artifacts: createLocalArtifactStore({ root }),
      record: () => {
        throw new Error("metadata store unavailable");
      },
    });

    // The metadata failure propagates, but immutable bytes should remain stored.
    await expect(
      recorder.record({ report, scope, screenshotBase64: PNG_BASE64 })
    ).rejects.toThrow("metadata store unavailable");

    const found = await findObjectFile(root);
    expect(found).toBeDefined();

    await rm(root, { force: true, recursive: true });
  });

  it("propagates a storage refusal instead of inventing an artifact", async () => {
    const refusingStore = {
      put: () => {
        throw new Error("disk full");
      },
      read: () => {
        throw new Error("unreachable");
      },
    };
    const recorder = createEvidenceRecorder({ artifacts: refusingStore });

    await expect(recorder.record({ report, scope })).rejects.toThrow(
      "disk full"
    );
  });
});
