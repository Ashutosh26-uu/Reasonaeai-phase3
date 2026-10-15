import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { noopObserve } from "@mastra/core/tools";
import { LocalFilesystem, type ReadOptions } from "@mastra/core/workspace";
import {
  attachmentUri,
  attachmentWorkspacePath,
} from "@reasonateai/contracts/execution";
import { describe, expect, it } from "vitest";
import { ATTACHMENT_CONTEXT_KEY } from "../src/attachments.js";
import { ReadSnapshotStore } from "../src/tools/read-snapshots.js";
import { createWorkspaceReadTool } from "../src/tools/workspace-read.js";

class MountedFilesystem extends LocalFilesystem {
  override readFile(path: string, options?: ReadOptions) {
    return super.readFile(posix.relative("/workspace", path), options);
  }
  override stat(path: string) {
    return super.stat(posix.relative("/workspace", path));
  }
}

describe("production attachment reader", () => {
  it("rereads literal filenames and image pixels from files, denies unknown identities, and lists references", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attachment-read-"));
    try {
      const filesystem = new MountedFilesystem({ basePath: directory });
      const requestContext = new RequestContext();
      const runId = randomUUID();
      const image = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        "base64"
      );
      const references = [
        {
          filename: "notes:raw",
          index: 0,
          mediaType: "text/plain",
          runId,
          sizeBytes: 13,
        },
        {
          filename: "screen.png",
          index: 1,
          mediaType: "image/png",
          runId,
          sizeBytes: image.length,
        },
      ];
      await filesystem.writeFile(
        attachmentWorkspacePath(runId, 0, "notes:raw"),
        "first\nsecond\n",
        { recursive: true }
      );
      await filesystem.writeFile(
        attachmentWorkspacePath(runId, 1, "screen.png"),
        image,
        { recursive: true }
      );
      requestContext.setRaw(ATTACHMENT_CONTEXT_KEY, references);
      const tool = createWorkspaceReadTool({
        resolveFilesystem: async () => filesystem,
        resolveSnapshots: async () => new ReadSnapshotStore(),
        root: "/workspace",
      });
      if (!tool.execute) {
        throw new Error("Read tool is missing.");
      }
      const context = { observe: noopObserve, requestContext };
      expect(
        await tool.execute({ target: "attachment://" }, context)
      ).toContain("notes:raw");
      expect(
        await tool.execute({ target: `${attachmentUri(runId, 0)}:2` }, context)
      ).toContain("second");
      const result = await tool.execute(
        { target: attachmentUri(runId, 1) },
        context
      );
      expect(result).toMatchObject({
        data: image.toString("base64"),
        mediaType: "image/png",
      });
      if (!(result && typeof result === "object" && "mediaType" in result)) {
        throw new Error("Image pixels were lost.");
      }
      expect(tool.toModelOutput?.(result)).toMatchObject({
        type: "content",
        value: expect.arrayContaining([
          expect.objectContaining({ mediaType: "image/png", type: "media" }),
        ]),
      });
      await expect(
        tool.execute({ target: attachmentUri(randomUUID(), 0) }, context)
      ).rejects.toThrow("not retained");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
