import { basename, posix } from "node:path";

import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import type { WorkspaceFilesystem } from "@mastra/core/workspace";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import type { Filesystem } from "./hashline/fs.js";
import { splitLines } from "./read.js";
import type { ReadSnapshotStore } from "./read-snapshots.js";
import { WorkspaceHashlineFilesystem } from "./workspace-filesystem.js";

const BOM_RE = /^\uFEFF/;
const CRLF_RE = /\r\n/g;
const HASH_RE = /^[0-9A-F]{4}$/i;

export interface WorkspaceWriteToolOptions {
  resolveFilesystem: (
    requestContext: RequestContext
  ) => Promise<WorkspaceFilesystem>;
  resolveSnapshots: (
    requestContext: RequestContext
  ) => Promise<ReadSnapshotStore>;
  root?: string | undefined;
}

function normalizedText(text: string): string {
  return text.replace(BOM_RE, "").replace(CRLF_RE, "\n");
}

function sawWholeFile(snapshot: {
  seenLines?: ReadonlySet<number>;
  text: string;
}): boolean {
  if (!snapshot.seenLines) {
    return false;
  }
  return splitLines(snapshot.text).every((_, index) =>
    snapshot.seenLines?.has(index + 1)
  );
}

export interface HashBoundWriteInput {
  content: string;
  expectedHash?: string | undefined;
  path: string;
}

export interface HashBoundWriteResult {
  created: boolean;
  patch: string;
  path: string;
}

/** Apply the hash-bound write rule after the caller resolved the workspace path. */
export async function writeFileWithHash(
  input: HashBoundWriteInput,
  dependencies: {
    filesystem: Filesystem;
    snapshots: ReadSnapshotStore;
    root: string;
  }
): Promise<HashBoundWriteResult> {
  const target = dependencies.filesystem.canonicalPath(input.path);
  const existed = await dependencies.filesystem.exists(target);
  if (!existed && input.expectedHash !== undefined) {
    throw new Error(
      "expectedHash is only valid when replacing an existing file."
    );
  }

  let previous = "";
  if (existed) {
    if (input.expectedHash === undefined) {
      throw new Error(
        "Replacing an existing file requires expectedHash from a complete read."
      );
    }
    previous = await dependencies.filesystem.readText(target);
    const snapshot = dependencies.snapshots.store.byHash(
      target,
      input.expectedHash
    );
    if (!snapshot || snapshot.text !== normalizedText(previous)) {
      throw new Error(
        "expectedHash is stale or was not minted by a read in this run."
      );
    }
    if (!sawWholeFile(snapshot)) {
      throw new Error(
        "A complete read is required before replacing an existing file."
      );
    }
  }

  await dependencies.filesystem.writeText(target, input.content);
  const name = basename(target);
  return {
    created: !existed,
    patch: createTwoFilesPatch(
      existed ? `a/${name}` : "/dev/null",
      `b/${name}`,
      previous,
      input.content,
      undefined,
      undefined,
      { context: 3 }
    ),
    path: posix.relative(dependencies.root, target) || ".",
  };
}

/**
 * Write an entire project file through the verified workspace filesystem.
 * New files need no anchor. Replacing an existing file requires the hashline
 * tag from a complete read, so full-file replacement cannot silently discard
 * content the agent never inspected.
 */
export function createWorkspaceWriteTool(input: WorkspaceWriteToolOptions) {
  const root = posix.normalize(input.root ?? "/");
  return createTool({
    description:
      "Create a new file or replace all content of an existing file. To replace an existing file, provide expectedHash from a complete read of that file. Read the result before editing it again.",
    execute: async ({ content, expectedHash, path }, context) => {
      const filesystem = new WorkspaceHashlineFilesystem({
        filesystem: await input.resolveFilesystem(context.requestContext),
        root,
      });
      return await writeFileWithHash(
        { content, expectedHash, path },
        {
          filesystem,
          root,
          snapshots: await input.resolveSnapshots(context.requestContext),
        }
      );
    },
    id: "write",
    inputSchema: z.strictObject({
      content: z.string().max(4 * 1024 * 1024),
      expectedHash: z.string().regex(HASH_RE).optional(),
      path: z.string().min(1).max(4096),
    }),
    outputSchema: z.strictObject({
      created: z.boolean(),
      patch: z.string(),
      path: z.string(),
    }),
  });
}
