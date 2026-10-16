import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import {
  type BrowserInspectionRequest,
  BrowserInspectionRequestSchema,
  type BrowserInspectionResult,
  BrowserInspectionResultSchema,
} from "@reasonateai/contracts/browser";
import type { EvidenceRecorder } from "../evidence.js";
import { readRunScope } from "../run-scope.js";
import {
  type BrowserDriver,
  PlaywrightBrowserDriver,
} from "./browser-driver.js";
import {
  isRunSandboxPreviewUrl,
  type RunSandboxPreviewTarget,
  resolveRunSandboxPreviewTargetUrl,
  validateBrowserTargetUrl,
} from "./browser-guard.js";

export interface BrowserToolOptions {
  /** Explicit allowed hostnames or IPs for preview target verification. */
  allowedHosts?: string[] | undefined;
  /** Optional custom or mock driver. Defaults to Playwright with HTTP fallback. */
  driver?: BrowserDriver | undefined;
  /**
   * When supplied, every completed verification is recorded through it as a
   * `browser-evidence` artifact (report plus captured screenshot) before the
   * result is returned. Omitting it keeps a verification transcript-only, as
   * before.
   */
  evidence?: EvidenceRecorder | undefined;
  /** Base URL for resolving relative preview paths (e.g. http://127.0.0.1:3000). */
  previewBaseUrl?: string | undefined;
  /** Resolves the authorized gateway for the current run's selected sandbox app. */
  resolveRunSandboxPreview?: (
    requestContext: RequestContext
  ) => Promise<RunSandboxPreviewTarget | undefined>;
}

export function createBrowserVerificationTool(
  options: BrowserToolOptions = {}
) {
  const driver = options.driver ?? new PlaywrightBrowserDriver();

  function resolveTargetUrl(params: {
    input: BrowserInspectionRequest;
    allowedHosts?: string[] | undefined;
    previewBaseUrl: string | undefined;
    resolveRunSandboxPreview?: BrowserToolOptions["resolveRunSandboxPreview"];
    runPreviewUrl: URL | undefined;
  }): URL {
    return validateBrowserTargetUrl(
      params.runPreviewUrl?.toString() ?? params.input.url,
      {
        allowedHosts: params.allowedHosts,
        previewBaseUrl: params.previewBaseUrl,
        previewId: params.resolveRunSandboxPreview
          ? undefined
          : params.input.previewId,
      }
    );
  }

  async function recordEvidence(
    result: Awaited<ReturnType<typeof driver.navigateAndInspect>>,
    validatedUrl: string,
    evidence: EvidenceRecorder | undefined,
    requestContext: RequestContext
  ): Promise<BrowserInspectionResult> {
    if (evidence === undefined) {
      return BrowserInspectionResultSchema.parse(result);
    }

    try {
      const artifact = await evidence.record({
        report: {
          consoleErrors: result.consoleErrors,
          consoleLogs: result.consoleLogs,
          domSnippet: result.domSnippet ?? null,
          durationMs: result.durationMs,
          element: result.element ?? null,
          errors: result.errors,
          evaluatedAt: new Date().toISOString(),
          evaluationResult:
            result.evaluationResult === undefined
              ? null
              : result.evaluationResult,
          httpStatus: result.httpStatus,
          networkFailures: result.networkFailures,
          networkRequests: result.networkRequests,
          passed: result.passed,
          status: result.status,
          summary: result.summary,
          targetUrl: validatedUrl,
          title: result.title,
        },
        scope: readRunScope(requestContext),
        screenshotBase64: result.screenshotBase64 ?? undefined,
      });
      if (artifact !== undefined) {
        return BrowserInspectionResultSchema.parse({
          ...result,
          screenshotArtifactId: artifact.artifactId,
        });
      }
    } catch (error) {
      console.warn(
        `recording browser evidence failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    return BrowserInspectionResultSchema.parse(result);
  }

  return createTool({
    description:
      "Verify web application preview rendering in a headless browser: navigates to target URL, inspects page title and DOM elements, captures screenshot, and detects unhandled console errors and network failures. After open_preview selects an app, sandbox loopback/private URLs on that app port or relay port are routed through the same run's authorized preview gateway; other private addresses remain unavailable.",
    execute: async (
      input: BrowserInspectionRequest,
      context
    ): Promise<BrowserInspectionResult> => {
      const {
        allowedHosts,
        evidence,
        previewBaseUrl: configuredPreviewBaseUrl,
        resolveRunSandboxPreview,
      } = options;
      let runPreview: RunSandboxPreviewTarget | undefined;
      let runPreviewUrl: URL | undefined;

      if (resolveRunSandboxPreview && isRunSandboxPreviewUrl(input.url)) {
        runPreview = await resolveRunSandboxPreview(context.requestContext);
        runPreviewUrl = resolveRunSandboxPreviewTargetUrl(
          input.url,
          runPreview,
          input.previewId
        );
      }

      const previewBaseUrl = runPreview?.baseUrl ?? configuredPreviewBaseUrl;

      // 1. SSRF and tenant isolation validation
      const validatedUrl = resolveTargetUrl({
        allowedHosts,
        input,
        previewBaseUrl,
        resolveRunSandboxPreview,
        runPreviewUrl,
      });

      // 2. Execute verification via driver
      const result = await driver.navigateAndInspect({
        ...input,
        url: validatedUrl.toString(),
      });

      // 3. Evidence: the decision outlives the run only if its report and
      // screenshot were put through the immutable store. A record failure is
      // reported here and returned to the model as a note, never thrown:
      // recording is a consequence of a verification that did happen, and a
      // storage outage must not invert the verdict.
      return recordEvidence(
        result,
        validatedUrl.toString(),
        evidence,
        context.requestContext
      );
    },
    id: "browser_verify",
    inputSchema: BrowserInspectionRequestSchema,
    outputSchema: BrowserInspectionResultSchema,
  });
}
