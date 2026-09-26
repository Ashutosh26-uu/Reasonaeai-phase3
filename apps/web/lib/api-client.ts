import type {
  BuildSession,
  Deployment,
  EvidenceKind,
  EvidenceRecord,
  GitCheckpoint,
  PreviewSession,
} from "@reasonateai/contracts/execution";
import type {
  ArtifactManifest,
  RunEventEnvelope,
} from "@reasonateai/contracts/execution-protocol";

export type RunEvent =
  | RunEventEnvelope
  | {
      eventId?: string;
      type: string;
      payload?: Record<string, unknown>;
      timestamp: string;
    };
export type ArtifactRecord =
  | ArtifactManifest
  | {
      artifactId: string;
      status?: string;
      totalSize?: number;
      downloadUrl?: string | null;
    };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: number,
    message: string,
    code = "UNKNOWN_ERROR",
    details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const getApiBaseUrl = (): string => {
  if (typeof window !== "undefined") {
    const win = window as unknown as { __API_BASE_URL__?: string };
    if (win.__API_BASE_URL__) {
      return win.__API_BASE_URL__;
    }
    if (process.env.NEXT_PUBLIC_API_URL) {
      return process.env.NEXT_PUBLIC_API_URL;
    }
    return "";
  }
  return process.env.NEXT_PUBLIC_API_URL || "http://localhost:4111";
};

async function handleApiErrorResponse(response: Response): Promise<never> {
  let rawText = "";
  let errorData: Record<string, unknown> | null = null;
  try {
    rawText = await response.text();
    errorData = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    // Body not JSON
  }

  const errObj =
    errorData?.error && typeof errorData.error === "object"
      ? (errorData.error as Record<string, unknown>)
      : null;

  let message =
    (errObj?.message as string | undefined) ||
    (errorData?.message as string | undefined);

  if (!message && Array.isArray(errorData)) {
    const messages = (errorData as Record<string, unknown>[])
      .map((item) =>
        item && typeof item === "object" && "message" in item
          ? String(item.message)
          : ""
      )
      .filter(Boolean);
    if (messages.length > 0) {
      message = messages.join("; ");
    }
  }

  if (!message) {
    const trimmed = rawText.trim();
    message =
      trimmed && !trimmed.includes("<!DOCTYPE")
        ? trimmed
        : `API service request failed (${response.status})`;
  }

  if (message === "Internal Server Error") {
    message =
      "An internal server error occurred while processing the request. Please check API server logs.";
  }

  const code =
    (errObj?.code as string | undefined) ||
    (errorData?.code as string | undefined) ||
    `HTTP_${response.status}`;

  throw new ApiError(
    response.status,
    message,
    code,
    errObj?.details ?? errorData?.details
  );
}

export async function fetchApi<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const baseUrl = getApiBaseUrl();
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  const response = await fetch(url, {
    credentials: "include",
    ...options,
    headers,
  });

  if (!response.ok) {
    await handleApiErrorResponse(response);
  }

  if (response.status === 204) {
    return undefined as unknown as T;
  }

  return (await response.json()) as T;
}

const DEFAULT_ORG_ID = "00000000-0000-4000-8000-000000000002";
const DEFAULT_PROJECT_ID = "00000000-0000-4000-8000-000000000003";

export const apiClient = {
  allocateBuildSession: async (
    orgId = DEFAULT_ORG_ID,
    projId = DEFAULT_PROJECT_ID,
    idempotencyKey?: string
  ): Promise<{
    buildSession: BuildSession;
    created: boolean;
    sandbox: {
      buildSessionId: string;
      createdAt: string;
      organizationId: string;
      projectId: string;
      sandboxEnvironmentId: string;
      status: string;
      updatedAt: string;
      workspaceUri: string;
    };
  }> => {
    const key = idempotencyKey ?? `build-session-alloc-${projId}`;
    return await fetchApi<{
      buildSession: BuildSession;
      created: boolean;
      sandbox: {
        buildSessionId: string;
        createdAt: string;
        organizationId: string;
        projectId: string;
        sandboxEnvironmentId: string;
        status: string;
        updatedAt: string;
        workspaceUri: string;
      };
    }>("/v1/build-sessions", {
      body: JSON.stringify({
        organizationId: orgId,
        projectId: projId,
      }),
      headers: {
        "Idempotency-Key": key,
      },
      method: "POST",
    });
  },

  createCheckpoint: async (
    buildSessionId: string,
    input: {
      message: string;
      author?: string;
      organizationId?: string;
      projectId?: string;
    }
  ): Promise<GitCheckpoint> => {
    const orgId = input.organizationId ?? DEFAULT_ORG_ID;
    const projId = input.projectId ?? DEFAULT_PROJECT_ID;
    const res = await fetchApi<{ checkpoint: GitCheckpoint }>(
      `/v1/build-sessions/${buildSessionId}/checkpoints?organizationId=${orgId}&projectId=${projId}`,
      {
        body: JSON.stringify({
          ...input,
          organizationId: orgId,
          projectId: projId,
        }),
        method: "POST",
      }
    );
    return res.checkpoint;
  },

  createDeployment: async (
    projectId: string,
    input: {
      organizationId?: string;
      sourceCheckpoint: string;
      exposure: "authenticated" | "unlisted" | "public";
      providerReference: string;
    }
  ): Promise<Deployment> => {
    const orgId = input.organizationId ?? DEFAULT_ORG_ID;
    const res = await fetchApi<{ deployment: Deployment }>(
      `/v1/projects/${projectId}/deployments`,
      {
        body: JSON.stringify({ ...input, organizationId: orgId, projectId }),
        method: "POST",
      }
    );
    return res.deployment;
  },

  createPreview: async (
    buildSessionId: string,
    input: {
      port: number;
      healthPath?: string;
      organizationId?: string;
      projectId?: string;
      sandboxEnvironmentId?: string;
      sandboxId?: string;
    }
  ): Promise<PreviewSession> => {
    const orgId = input.organizationId ?? DEFAULT_ORG_ID;
    const projId = input.projectId ?? DEFAULT_PROJECT_ID;
    const res = await fetchApi<{ preview: PreviewSession }>(
      `/v1/build-sessions/${buildSessionId}/previews?organizationId=${orgId}&projectId=${projId}`,
      {
        body: JSON.stringify({
          ...input,
          organizationId: orgId,
          projectId: projId,
        }),
        method: "POST",
      }
    );
    return res.preview;
  },

  getArtifact: async (
    artifactId: string,
    orgId = DEFAULT_ORG_ID,
    projId = DEFAULT_PROJECT_ID
  ): Promise<{ artifact: ArtifactRecord; downloadUrl: string | null }> =>
    fetchApi<{ artifact: ArtifactRecord; downloadUrl: string | null }>(
      `/v1/artifacts/${artifactId}?organizationId=${orgId}&projectId=${projId}`
    ),

  getBuildSession: async (
    buildSessionId: string,
    orgId = DEFAULT_ORG_ID,
    projId = DEFAULT_PROJECT_ID
  ): Promise<BuildSession> => {
    const res = await fetchApi<{ buildSession: BuildSession }>(
      `/v1/build-sessions/${buildSessionId}?organizationId=${orgId}&projectId=${projId}`
    );
    return res.buildSession;
  },

  getPreview: async (
    previewId: string,
    orgId = DEFAULT_ORG_ID,
    projId = DEFAULT_PROJECT_ID
  ): Promise<PreviewSession> => {
    const res = await fetchApi<{ preview: PreviewSession }>(
      `/v1/previews/${previewId}?organizationId=${orgId}&projectId=${projId}`
    );
    return res.preview;
  },

  listCheckpoints: async (
    buildSessionId: string,
    orgId = DEFAULT_ORG_ID,
    projId = DEFAULT_PROJECT_ID
  ): Promise<GitCheckpoint[]> => {
    const res = await fetchApi<{ checkpoints: GitCheckpoint[] }>(
      `/v1/build-sessions/${buildSessionId}/checkpoints?organizationId=${orgId}&projectId=${projId}`
    );
    return res.checkpoints;
  },

  listDeployments: async (
    projectId: string,
    orgId = DEFAULT_ORG_ID
  ): Promise<Deployment[]> => {
    const res = await fetchApi<{ deployments: Deployment[] }>(
      `/v1/projects/${projectId}/deployments?organizationId=${orgId}`
    );
    return res.deployments;
  },

  listEvidence: async (
    projectId: string,
    kind?: EvidenceKind,
    orgId = DEFAULT_ORG_ID
  ): Promise<EvidenceRecord[]> => {
    const kindQuery = kind ? `&kind=${encodeURIComponent(kind)}` : "";
    const res = await fetchApi<{ evidence: EvidenceRecord[] }>(
      `/v1/projects/${projectId}/evidence?organizationId=${orgId}${kindQuery}`
    );
    return res.evidence;
  },

  listPreviews: async (
    buildSessionId: string,
    orgId = DEFAULT_ORG_ID,
    projId = DEFAULT_PROJECT_ID
  ): Promise<PreviewSession[]> => {
    const res = await fetchApi<{ previews: PreviewSession[] }>(
      `/v1/build-sessions/${buildSessionId}/previews?organizationId=${orgId}&projectId=${projId}`
    );
    return res.previews;
  },

  restoreCheckpoint: async (
    checkpointId: string,
    orgId = DEFAULT_ORG_ID,
    projId = DEFAULT_PROJECT_ID
  ): Promise<{ success: boolean; checkpoint: GitCheckpoint }> =>
    fetchApi<{ success: boolean; checkpoint: GitCheckpoint }>(
      `/v1/checkpoints/${checkpointId}/restore`,
      {
        body: JSON.stringify({ organizationId: orgId, projectId: projId }),
        method: "POST",
      }
    ),

  rollbackDeployment: async (
    deploymentId: string,
    input: {
      organizationId?: string;
      projectId: string;
      targetDeploymentId: string;
      reason: string;
    }
  ): Promise<Deployment> => {
    const orgId = input.organizationId ?? DEFAULT_ORG_ID;
    const res = await fetchApi<{
      deployment?: Deployment;
      rolledBackDeployment?: Deployment;
      activeDeployment?: Deployment;
    }>(`/v1/deployments/${deploymentId}/rollback`, {
      body: JSON.stringify({ ...input, organizationId: orgId }),
      method: "POST",
    });
    const resultDep =
      res.deployment ?? res.rolledBackDeployment ?? res.activeDeployment;
    if (!resultDep) {
      throw new Error(
        "Rollback request succeeded but no deployment was returned."
      );
    }
    return resultDep;
  },

  updatePreview: async (
    previewId: string,
    input: Partial<PreviewSession> & {
      organizationId?: string;
      projectId?: string;
    }
  ): Promise<PreviewSession> => {
    const orgId = input.organizationId ?? DEFAULT_ORG_ID;
    const projId = input.projectId ?? DEFAULT_PROJECT_ID;
    const res = await fetchApi<{ preview: PreviewSession }>(
      `/v1/previews/${previewId}`,
      {
        body: JSON.stringify({
          ...input,
          organizationId: orgId,
          projectId: projId,
        }),
        method: "PATCH",
      }
    );
    return res.preview;
  },
};

export function subscribeToRunEvents(
  buildSessionId: string,
  onEvent: (event: RunEvent) => void,
  onError?: (err: Event) => void,
  orgId = DEFAULT_ORG_ID,
  projId = DEFAULT_PROJECT_ID
): () => void {
  const baseUrl = getApiBaseUrl();
  const url = `${baseUrl}/v1/build-sessions/${buildSessionId}/events?organizationId=${orgId}&projectId=${projId}`;
  const eventSource = new EventSource(url, { withCredentials: true });

  eventSource.onmessage = (messageEvent) => {
    try {
      const parsed: RunEvent = JSON.parse(messageEvent.data);
      onEvent(parsed);
    } catch {
      // Ignore non-JSON or heartbeat comments
    }
  };

  if (onError) {
    eventSource.onerror = onError;
  }

  return () => {
    eventSource.close();
  };
}
