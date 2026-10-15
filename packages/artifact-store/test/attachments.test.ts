import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { preserveAttachment } from "../src/attachments.js";
import { createLocalArtifactStore } from "../src/local.js";
import {
  organizationId,
  otherOrganizationId,
  projectId,
} from "./support/fixtures.js";

describe("original attachment preservation", () => {
  it("keeps exact bytes and journal input, reuses repeated writes, and isolates tenants", async () => {
    const root = await mkdtemp(join(tmpdir(), "attachment-originals-"));
    try {
      const store = createLocalArtifactStore({ root });
      const content = Buffer.from("First\r\n第二行\n");
      const file = {
        data: `data:text/plain;base64,${content.toString("base64")}`,
        filename: "notes.txt",
        mediaType: "text/plain",
      };
      const original = JSON.stringify(file);
      const first = await preserveAttachment(
        store,
        { organizationId, projectId },
        file
      );
      const second = await preserveAttachment(
        store,
        { organizationId, projectId },
        file
      );
      expect(first.content).toEqual(content);
      expect(second.key).toBe(first.key);
      const concurrent = await Promise.all(
        Array.from({ length: 8 }, () =>
          preserveAttachment(
            store,
            { organizationId, projectId },
            { ...file, filename: "concurrent.txt" }
          )
        )
      );
      expect(
        concurrent.every((entry) => Buffer.from(entry.content).equals(content))
      ).toBe(true);
      expect(JSON.stringify(file)).toBe(original);
      await expect(
        store.read({
          key: first.key,
          organizationId: otherOrganizationId,
          projectId,
        })
      ).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
