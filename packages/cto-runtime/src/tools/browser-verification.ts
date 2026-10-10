import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import {
  type BrowserInspectionRequest,
  BrowserInspectionRequestSchema,
  type BrowserInspectionResult,
  BrowserInspectionResultSchema,
} from "@reasonateai/contracts/browser";
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

  return createTool({
    description:
      "Verify web application preview rendering in a headless browser: navigates to target URL, inspects page title and DOM elements, captures screenshot, and detects unhandled console errors and network failures. After open_preview selects an app, sandbox loopback/private URLs on that app port or relay port are routed through the same run's authorized preview gateway; other private addresses remain unavailable.",
    execute: async (
      input: BrowserInspectionRequest,
      context
    ): Promise<BrowserInspectionResult> => {
      const {
        allowedHosts,
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
      const validatedUrl = validateBrowserTargetUrl(
        runPreviewUrl?.toString() ?? input.url,
        {
          allowedHosts,
          previewBaseUrl,
          previewId: resolveRunSandboxPreview ? undefined : input.previewId,
        }
      );

      // 2. Execute verification via driver
      const result = await driver.navigateAndInspect({
        ...input,
        url: validatedUrl.toString(),
      });

      return BrowserInspectionResultSchema.parse(result);
    },
    id: "browser_verify",
    inputSchema: BrowserInspectionRequestSchema,
    outputSchema: BrowserInspectionResultSchema,
  });
}
