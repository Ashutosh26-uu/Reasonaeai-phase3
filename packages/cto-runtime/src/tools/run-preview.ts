import type { PreviewId } from "@reasonateai/contracts/execution";
import type { RunScope } from "../run-scope.js";
import type { RunSandboxPreviewTarget } from "./browser-guard.js";

export type { RunSandboxPreviewTarget } from "./browser-guard.js";

export interface RunPreviewSelection {
  appPort: number;
  previewId: PreviewId;
}

export interface RunPreviewState {
  buildSessionId: string;
  detail: string | null;
  hostPort: number | null;
  organizationId: string;
  previewId: PreviewId;
  projectId: string;
  runId: string | null;
  status: "failed" | "ready" | "starting" | "stopped";
}

const PREVIEW_READY_TIMEOUT_MS = 45_000;
const PREVIEW_POLL_INTERVAL_MS = 250;

function assertPreviewScope(preview: RunPreviewState, scope: RunScope): void {
  if (
    preview.runId !== scope.runId ||
    preview.buildSessionId !== scope.buildSessionId ||
    preview.organizationId !== scope.organizationId ||
    preview.projectId !== scope.projectId
  ) {
    throw new Error("The selected app preview does not belong to this run.");
  }
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function waitForRunSandboxPreview(input: {
  loadPreview: (previewId: PreviewId) => Promise<RunPreviewState | undefined>;
  relayPort: number;
  scope: RunScope;
  selection: RunPreviewSelection;
  timeoutMs?: number;
}): Promise<RunSandboxPreviewTarget> {
  const deadline = Date.now() + (input.timeoutMs ?? PREVIEW_READY_TIMEOUT_MS);

  const poll = async (): Promise<RunSandboxPreviewTarget> => {
    const preview = await input.loadPreview(input.selection.previewId);
    if (!preview) {
      throw new Error(
        "The selected app preview is no longer registered for this run. Open the App preview and try again."
      );
    }
    assertPreviewScope(preview, input.scope);
    if (preview.status === "failed" || preview.status === "stopped") {
      throw new Error(
        preview.detail ?? "The selected sandbox app preview failed to start."
      );
    }
    if (preview.status === "ready" && preview.hostPort !== null) {
      return {
        appPort: input.selection.appPort,
        baseUrl: `http://127.0.0.1:${preview.hostPort}/`,
        previewId: preview.previewId,
        relayPort: input.relayPort,
      };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "The sandbox app preview has not become ready yet. Keep its preview tab open and try browser verification again."
      );
    }

    await pause(PREVIEW_POLL_INTERVAL_MS);
    return poll();
  };

  return poll();
}
