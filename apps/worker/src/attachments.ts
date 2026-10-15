import { posix } from "node:path";
import type { RequestContext } from "@mastra/core/request-context";
import type { WorkspaceSandbox } from "@mastra/core/workspace";
import type { ArtifactStore } from "@reasonateai/artifact-store";
import { preserveAttachment } from "@reasonateai/artifact-store/attachments";
import {
  type AttachmentReference,
  attachmentWorkspacePath,
} from "@reasonateai/contracts/execution";
import { ATTACHMENT_CONTEXT_KEY } from "@reasonateai/cto-runtime/attachments";
import type { RunScope } from "@reasonateai/cto-runtime/run-scope";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { SandboxFilesystem } from "./sandbox-filesystem.js";
import { SANDBOX_WORKING_DIRECTORY } from "./workspace.js";

export async function loadAttachmentFile(input: {
  artifacts: ArtifactStore;
  store: ProjectStateStore;
  scope: RunScope;
  sandbox: WorkspaceSandbox;
  sourceRunId: string;
  index: number;
}): Promise<AttachmentReference | undefined> {
  const file = await input.store.history.attachment(
    input.scope,
    input.scope.buildSessionId,
    input.sourceRunId,
    input.index
  );
  if (!file) {
    return undefined;
  }
  const { content } = await preserveAttachment(
    input.artifacts,
    input.scope,
    file
  );
  const path = posix.join(
    SANDBOX_WORKING_DIRECTORY,
    attachmentWorkspacePath(input.sourceRunId, input.index, file.filename)
  );
  const fs = new SandboxFilesystem({
    id: "attachment-restoration",
    root: SANDBOX_WORKING_DIRECTORY,
    sandbox: input.sandbox,
  });
  await fs.mkdir(posix.dirname(path), { recursive: true });
  // Verify each existing segment before the archive transport writes large files.
  await fs.exists(path);
  if (!input.sandbox.writeFiles) {
    throw new Error("The sandbox cannot restore attachment files.");
  }
  await input.sandbox.writeFiles([
    { content: Buffer.from(content), mode: 0o400, path },
  ]);
  return {
    filename: file.filename,
    index: input.index,
    mediaType: file.mediaType,
    runId: input.sourceRunId,
    sizeBytes: content.length,
  };
}

export async function prepareAttachmentCatalog(
  store: ProjectStateStore,
  scope: RunScope,
  context: RequestContext
): Promise<AttachmentReference[]> {
  const files = await store.history.attachmentReferences(
    scope,
    scope.buildSessionId
  );
  context.setRaw(ATTACHMENT_CONTEXT_KEY, files);
  return files;
}

/** Restore current inputs only; old attachments materialize through the scoped read broker. */
export async function restoreConversationAttachments(input: {
  artifacts: ArtifactStore;
  store: ProjectStateStore;
  scope: RunScope;
  sandbox: WorkspaceSandbox;
  files: AttachmentReference[];
}): Promise<number> {
  const fs = new SandboxFilesystem({
    id: "attachment-restoration",
    root: SANDBOX_WORKING_DIRECTORY,
    sandbox: input.sandbox,
  });
  const root = posix.join(SANDBOX_WORKING_DIRECTORY, ".reasonate/attachments");
  if (await fs.exists(root)) {
    await fs.rmdir(root, { recursive: true });
  }
  const current = input.files.filter(
    (file) => file.runId === input.scope.runId
  );
  await current.reduce(async (previous, file) => {
    await previous;
    await loadAttachmentFile({
      ...input,
      index: file.index,
      sourceRunId: file.runId,
    });
  }, Promise.resolve());
  return current.length;
}
