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
import { validateBrowserTargetUrl } from "./browser-guard.js";

export interface BrowserToolOptions {
  /** Explicit allowed hostnames or IPs for preview target verification. */
  allowedHosts?: string[] | undefined;
  /** Optional custom or mock driver. Defaults to Playwright with HTTP fallback. */
  driver?: BrowserDriver | undefined;
  /** Base URL for resolving relative preview paths (e.g. http://127.0.0.1:3000). */
  previewBaseUrl?: string | undefined;
}

export function createBrowserVerificationTool(
  options: BrowserToolOptions = {}
) {
  const driver = options.driver ?? new PlaywrightBrowserDriver();

  return createTool({
    description:
      "Verify web application preview rendering in a headless browser: navigates to target URL, inspects page title and DOM elements, captures screenshot, and detects unhandled console errors and network failures.",
    execute: async (
      input: BrowserInspectionRequest,
      _context
    ): Promise<BrowserInspectionResult> => {
      // 1. SSRF and tenant isolation validation
      const validatedUrl = validateBrowserTargetUrl(input.url, {
        allowedHosts: options.allowedHosts,
        previewBaseUrl: options.previewBaseUrl,
        previewId: input.previewId,
      });

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
