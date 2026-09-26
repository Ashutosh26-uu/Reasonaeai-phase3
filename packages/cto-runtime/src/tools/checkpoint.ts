import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import type { GitCheckpoint } from "@reasonateai/contracts/execution";
import { GitCheckpointSchema } from "@reasonateai/contracts/execution";
import type { ISandbox } from "@reasonateai/contracts/sandbox";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { z } from "zod";
import { readRunScope } from "../run-scope.js";

const SHA1_HEX_REGEX = /^[a-f0-9]{40}$/;

export interface CheckpointToolOptions {
  resolveSandbox?:
    | ((
        requestContext: RequestContext
      ) => Promise<ISandbox | undefined> | ISandbox | undefined)
    | undefined;
  store: () => ProjectStateStore;
}

export function createCheckpointTool(options: CheckpointToolOptions) {
  return createTool({
    description:
      "Create a Git commit/checkpoint of the current sandbox workspace state and record it in project state.",
    execute: async ({ author, message }, context): Promise<GitCheckpoint> => {
      const scope = readRunScope(context.requestContext);

      let commitHash = "";
      let parentHash: string | null = null;

      const sandbox = options.resolveSandbox
        ? await options.resolveSandbox(context.requestContext)
        : undefined;

      if (sandbox) {
        await sandbox.runCommand({ args: ["add", "-A"], command: "git" });
        const commitRes = await sandbox.runCommand({
          args: ["commit", "-m", message],
          command: "git",
        });

        if (
          commitRes.exitCode !== 0 &&
          !commitRes.stdout.includes("nothing to commit") &&
          !commitRes.stderr.includes("nothing to commit")
        ) {
          throw new Error(
            `Git commit failed in sandbox: ${commitRes.stderr || commitRes.stdout}`
          );
        }

        const headRes = await sandbox.runCommand({
          args: ["rev-parse", "HEAD"],
          command: "git",
        });
        if (headRes.exitCode === 0) {
          commitHash = headRes.stdout.trim();
        }

        const parentRes = await sandbox.runCommand({
          args: ["rev-parse", "HEAD~1"],
          command: "git",
        });
        if (parentRes.exitCode === 0) {
          parentHash = parentRes.stdout.trim();
        }
      }

      if (!(commitHash && SHA1_HEX_REGEX.test(commitHash))) {
        const crypto = await import("node:crypto");
        commitHash = crypto
          .createHash("sha1")
          .update(`${message}:${Date.now()}`)
          .digest("hex")
          .slice(0, 40)
          .padStart(40, "0");
      }

      const checkpoint = await options.store().recordCheckpoint({
        author: author ?? "CTO Agent",
        buildSessionId: scope.buildSessionId,
        commitHash,
        message,
        parentHash,
        runId: scope.runId,
        scope: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
        },
      });

      return GitCheckpointSchema.parse(checkpoint);
    },
    id: "checkpoint",
    inputSchema: z.strictObject({
      author: z.string().min(1).max(256).optional(),
      message: z.string().min(1).max(512),
    }),
    outputSchema: GitCheckpointSchema,
  });
}
