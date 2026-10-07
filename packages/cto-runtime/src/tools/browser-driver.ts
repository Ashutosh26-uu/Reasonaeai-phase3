import type {
  BrowserConsoleMessage,
  BrowserElementInspection,
  BrowserInspectionRequest,
  BrowserInspectionResult,
  BrowserNetworkRequest,
  BrowserVerificationStatus,
} from "@reasonateai/contracts/browser";

export interface BrowserDriver {
  close?: () => Promise<void>;
  navigateAndInspect: (
    request: BrowserInspectionRequest
  ) => Promise<BrowserInspectionResult>;
}

// 1x1 transparent PNG fallback screenshot
export const PLACEHOLDER_SCREENSHOT_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const RUNTIME_ERROR_REGEX = /(?:ReferenceError|TypeError|SyntaxError):[^\n<]+/i;
const TAG_SELECTOR_REGEX = /^[a-zA-Z0-9]+$/;
const TITLE_TAG_REGEX = /<title[^>]*>([\s\S]*?)<\/title>/i;
const ATTRIBUTE_SELECTOR_REGEX =
  /^(?:([a-zA-Z0-9_-]+))?\[([a-zA-Z0-9_:-]+)(?:([*^$]?=)["']?([^"']*)["']?)?\]$/;
const TAG_CLASS_REGEX = /^([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)$/;
const TAG_ID_REGEX = /^([a-zA-Z0-9_-]+)#([a-zA-Z0-9_-]+)$/;
const ERROR_H1_REGEX =
  /<h1[^>]*>[\s\S]*?500\s+internal\s+server\s+error[\s\S]*?<\/h1>/i;
const ERROR_TITLE_REGEX =
  /<title[^>]*>[\s\S]*?500\s+internal\s+server\s+error[\s\S]*?<\/title>/i;
const ERROR_PRE_REGEX =
  /<pre[^>]*>[\s\S]*?500\s+internal\s+server\s+error[\s\S]*?<\/pre>/i;
const ROUTER_404_REGEX = /<pre[^>]*>\s*Cannot\s+(?:GET|POST)\s+\//i;

export function decodeBasicHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function inspectId(html: string, id: string): BrowserElementInspection {
  const idRegex = new RegExp(`id=["']${id}["']`, "i");
  const exists = idRegex.test(html);
  let text: string | undefined;
  if (exists) {
    const tagRegex = new RegExp(
      `<([a-zA-Z0-9]+)[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
      "i"
    );
    const match = html.match(tagRegex);
    if (match?.[2]) {
      text = decodeBasicHtmlEntities(match[2].replace(/<[^>]+>/g, "").trim());
    }
  }
  return {
    attributes: exists ? { id } : undefined,
    count: exists ? 1 : 0,
    exists,
    selector: `#${id}`,
    text,
    visible: exists,
  };
}

function inspectClass(
  html: string,
  className: string
): BrowserElementInspection {
  const classRegex = new RegExp(
    `class=["'][^"']*\\b${className}\\b[^"']*["']`,
    "gi"
  );
  const matches = html.match(classRegex);
  const count = matches ? matches.length : 0;
  const exists = count > 0;
  return {
    attributes: exists ? { class: className } : undefined,
    count,
    exists,
    selector: `.${className}`,
    visible: exists,
  };
}

function inspectTagId(
  html: string,
  tag: string,
  id: string,
  selector: string
): BrowserElementInspection {
  const tagIdRegex = new RegExp(
    `<${tag}[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "i"
  );
  const match = html.match(tagIdRegex);
  const exists = Boolean(match);
  let text: string | undefined;
  if (match?.[1]) {
    text = decodeBasicHtmlEntities(match[1].replace(/<[^>]+>/g, "").trim());
  }
  return {
    attributes: exists ? { id } : undefined,
    count: exists ? 1 : 0,
    exists,
    selector,
    text,
    visible: exists,
  };
}

function inspectTagClass(
  html: string,
  tag: string,
  className: string,
  selector: string
): BrowserElementInspection {
  const tagClassRegex = new RegExp(
    `<${tag}[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`,
    "gi"
  );
  const matches = html.match(tagClassRegex);
  const count = matches ? matches.length : 0;
  const exists = count > 0;
  return {
    attributes: exists ? { class: className } : undefined,
    count,
    exists,
    selector,
    visible: exists,
  };
}

function inspectAttribute(
  html: string,
  match: RegExpMatchArray,
  selector: string
): BrowserElementInspection {
  const [, tag, attrName, , attrVal] = match;
  let pattern: RegExp;
  let textGroupIndex = 1;

  if (tag && attrVal !== undefined) {
    pattern = new RegExp(
      `<${tag}[^>]*\\b${attrName}=["']${attrVal}["'][^>]*>([\\s\\S]*?)<\\/${tag}>`,
      "gi"
    );
  } else if (!tag && attrVal !== undefined) {
    pattern = new RegExp(
      `<([a-zA-Z0-9]+)[^>]*\\b${attrName}=["']${attrVal}["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
      "gi"
    );
    textGroupIndex = 2;
  } else if (tag) {
    pattern = new RegExp(
      `<${tag}[^>]*\\b${attrName}(?:=["'][^"']*["'])?[^>]*>([\\s\\S]*?)<\\/${tag}>`,
      "gi"
    );
  } else {
    pattern = new RegExp(
      `<([a-zA-Z0-9]+)[^>]*\\b${attrName}(?:=["'][^"']*["'])?[^>]*>([\\s\\S]*?)<\\/\\1>`,
      "gi"
    );
    textGroupIndex = 2;
  }

  let matches = [...html.matchAll(pattern)];
  if (matches.length === 0) {
    const fallback =
      attrVal === undefined
        ? new RegExp(`\\b${attrName}(?:=["'][^"']*["'])?`, "gi")
        : new RegExp(`\\b${attrName}=["']${attrVal}["']`, "gi");
    matches = [...html.matchAll(fallback)];
    textGroupIndex = -1;
  }

  const count = matches.length;
  const exists = count > 0;
  let text: string | undefined;
  const [firstMatch] = matches;
  const matchedText = firstMatch?.[textGroupIndex];
  if (exists && textGroupIndex > 0 && matchedText) {
    text = decodeBasicHtmlEntities(matchedText.replace(/<[^>]+>/g, "").trim());
  }

  const attributes: Record<string, string> = {};
  if (exists && attrName && attrVal !== undefined) {
    attributes[attrName] = attrVal;
  }

  return {
    attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    count,
    exists,
    selector,
    text,
    visible: exists,
  };
}

function inspectTag(html: string, tag: string): BrowserElementInspection {
  const tagRegex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const matches = [...html.matchAll(tagRegex)];
  const count = matches.length;
  const exists = count > 0;
  let text: string | undefined;
  if (exists && matches[0]?.[1]) {
    text = decodeBasicHtmlEntities(
      matches[0][1].replace(/<[^>]+>/g, "").trim()
    );
  }
  return {
    count,
    exists,
    selector: tag,
    text,
    visible: exists,
  };
}

/**
 * Parses simple HTML DOM to inspect elements without heavy external dependencies.
 */
export function inspectHtmlElement(
  html: string,
  selector?: string
): BrowserElementInspection | undefined {
  if (!selector) {
    return undefined;
  }

  const cleanSelector = selector.trim();
  if (cleanSelector.startsWith("#")) {
    return inspectId(html, cleanSelector.slice(1));
  }
  if (cleanSelector.startsWith(".")) {
    return inspectClass(html, cleanSelector.slice(1));
  }
  const tagIdMatch = cleanSelector.match(TAG_ID_REGEX);
  if (tagIdMatch?.[1] && tagIdMatch[2]) {
    return inspectTagId(html, tagIdMatch[1], tagIdMatch[2], cleanSelector);
  }
  const tagClassMatch = cleanSelector.match(TAG_CLASS_REGEX);
  if (tagClassMatch?.[1] && tagClassMatch[2]) {
    return inspectTagClass(
      html,
      tagClassMatch[1],
      tagClassMatch[2],
      cleanSelector
    );
  }
  const attrMatch = cleanSelector.match(ATTRIBUTE_SELECTOR_REGEX);
  if (attrMatch) {
    return inspectAttribute(html, attrMatch, cleanSelector);
  }
  if (TAG_SELECTOR_REGEX.test(cleanSelector)) {
    return inspectTag(html, cleanSelector);
  }

  const exists = html.includes(cleanSelector);
  return {
    count: exists ? 1 : 0,
    exists,
    selector: cleanSelector,
    visible: exists,
  };
}

/**
 * Extracts page title from HTML.
 */
export function extractHtmlTitle(html: string): string {
  const match = html.match(TITLE_TAG_REGEX);
  return match?.[1] ? decodeBasicHtmlEntities(match[1].trim()) : "";
}

/**
 * Scans HTML for common unhandled error banners or crash messages.
 * Prevents false positives from ordinary body prose mentioning error codes.
 */
export function scanHtmlForErrors(html: string): string[] {
  const errors: string[] = [];
  const lower = html.toLowerCase();

  // Next.js crash overlay
  if (
    lower.includes("unhandled runtime error") ||
    lower.includes("nextjs-portal") ||
    html.includes('id="__next-error"')
  ) {
    errors.push("Detected Next.js runtime error overlay in page DOM.");
  }

  // Vite crash overlay
  if (
    lower.includes("<vite-error-overlay") ||
    html.includes('id="vite-error-overlay"')
  ) {
    errors.push("Detected Vite error overlay in page DOM.");
  }

  // React Error Boundary & Webpack overlays
  if (
    lower.includes("data-react-error-boundary") ||
    html.includes('id="webpack-dev-server-client-overlay"')
  ) {
    errors.push("Detected React error boundary overlay in page DOM.");
  }

  // Explicit server error titles/headings/pre blocks
  if (
    ERROR_H1_REGEX.test(html) ||
    ERROR_TITLE_REGEX.test(html) ||
    ERROR_PRE_REGEX.test(html)
  ) {
    errors.push("Detected 500 Internal Server Error in page heading.");
  }

  // Raw router 404 handler (e.g. Express default handler)
  if (ROUTER_404_REGEX.test(html)) {
    errors.push("Detected raw router 404 handler in page content.");
  }

  // Unhandled JavaScript runtime exception stack traces
  if (
    (lower.includes("referenceerror:") ||
      lower.includes("typeerror:") ||
      lower.includes("syntaxerror:")) &&
    (lower.includes("<pre") ||
      lower.includes("error") ||
      lower.includes("stack"))
  ) {
    const errorMatch = html.match(RUNTIME_ERROR_REGEX);
    if (errorMatch?.[0]) {
      errors.push(errorMatch[0].trim());
    }
  }

  return errors;
}

function truncateDomSnippet(
  htmlContent: string,
  captureDom?: boolean
): string | null {
  if (captureDom === false) {
    return null;
  }
  if (htmlContent.length > 2000) {
    return `${htmlContent.slice(0, 2000)}... (truncated)`;
  }
  return htmlContent;
}

function determineVerificationStatus(
  passed: boolean,
  httpStatus: number
): BrowserVerificationStatus {
  if (passed) {
    return "passed";
  }
  return httpStatus >= 500 || httpStatus === 0 ? "error" : "failed";
}

function checkPageExpectations(
  request: BrowserInspectionRequest,
  htmlContent: string,
  pageTitle: string,
  errors: string[]
): BrowserElementInspection | undefined {
  const element = request.selector
    ? inspectHtmlElement(htmlContent, request.selector)
    : undefined;

  if (request.selector && !element?.exists) {
    errors.push(`Selector "${request.selector}" was not found in page DOM.`);
  }

  if (request.expectedTitle && !pageTitle.includes(request.expectedTitle)) {
    errors.push(
      `Expected page title to include "${request.expectedTitle}", but got "${pageTitle}".`
    );
  }

  if (request.expectedText && !htmlContent.includes(request.expectedText)) {
    errors.push(`Expected page content to contain "${request.expectedText}".`);
  }

  return element;
}

interface FetchResult {
  durationMs: number;
  errors: string[];
  htmlContent: string;
  httpStatus: number;
  networkFailures: BrowserNetworkRequest[];
  networkRequests: BrowserNetworkRequest[];
}

async function fetchHttpPage(
  url: string,
  timeoutMs: number
): Promise<FetchResult> {
  const errors: string[] = [];
  const networkRequests: BrowserNetworkRequest[] = [];
  const networkFailures: BrowserNetworkRequest[] = [];

  const reqStart = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": "ReasonateAI-BrowserVerification/1.0",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);

    const durationMs = Date.now() - reqStart;
    const networkReq: BrowserNetworkRequest = {
      durationMs,
      method: "GET",
      ok: response.ok,
      resourceType: "document",
      status: response.status,
      url,
    };
    networkRequests.push(networkReq);

    if (!response.ok) {
      const failureReq = {
        ...networkReq,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
      networkFailures.push(failureReq);
      errors.push(
        `Navigation failed with HTTP ${response.status}: ${response.statusText}`
      );
    }

    const htmlContent = await response.text();
    return {
      durationMs,
      errors,
      htmlContent,
      httpStatus: response.status,
      networkFailures,
      networkRequests,
    };
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError");
    let errorMsg: string;
    if (isTimeout) {
      errorMsg = `Browser navigation timed out after ${timeoutMs}ms.`;
    } else if (err instanceof Error) {
      errorMsg = err.message;
    } else {
      errorMsg = String(err);
    }

    errors.push(errorMsg);
    networkFailures.push({
      durationMs: Date.now() - reqStart,
      error: errorMsg,
      method: "GET",
      ok: false,
      resourceType: "document",
      status: 0,
      url,
    });

    return {
      durationMs: Date.now() - reqStart,
      errors,
      htmlContent: "",
      httpStatus: 0,
      networkFailures,
      networkRequests,
    };
  }
}

/**
 * HTTP-based preview driver.
 * High-performance, reliable, lightweight runner using native fetch and DOM parsing.
 */
export class HttpBrowserDriver implements BrowserDriver {
  async navigateAndInspect(
    request: BrowserInspectionRequest
  ): Promise<BrowserInspectionResult> {
    const startTime = Date.now();
    const timeoutMs = request.timeoutMs ?? 15_000;
    const consoleErrors: BrowserConsoleMessage[] = [];
    const actionErrors: string[] = [];

    // Interactive actions cannot be executed by the static HTTP driver
    if (
      request.action === "click" ||
      request.action === "fill" ||
      request.action === "evaluate"
    ) {
      actionErrors.push(
        `Interactive action "${request.action}" requires a dynamic browser runtime (Playwright); static HTTP driver cannot perform interactive actions.`
      );
    }

    const fetchResult = await fetchHttpPage(request.url, timeoutMs);
    const {
      errors,
      htmlContent,
      httpStatus,
      networkFailures,
      networkRequests,
    } = fetchResult;

    for (const actErr of actionErrors) {
      errors.push(actErr);
    }

    const pageTitle = extractHtmlTitle(htmlContent);
    const domErrors = scanHtmlForErrors(htmlContent);
    for (const domError of domErrors) {
      consoleErrors.push({
        level: "error",
        text: domError,
        timestamp: new Date().toISOString(),
      });
      errors.push(domError);
    }

    const element = checkPageExpectations(
      request,
      htmlContent,
      pageTitle,
      errors
    );

    const durationMs = Date.now() - startTime;
    const failOnConsole = request.failOnConsoleErrors ?? true;
    const failOnNetwork = request.failOnNetworkErrors ?? true;

    const hasConsoleErrors = failOnConsole && consoleErrors.length > 0;
    const hasNetworkFailures = failOnNetwork && networkFailures.length > 0;
    const passed =
      errors.length === 0 &&
      !hasConsoleErrors &&
      !hasNetworkFailures &&
      httpStatus >= 200 &&
      httpStatus < 400;

    const status = determineVerificationStatus(passed, httpStatus);
    const domSnippet = truncateDomSnippet(htmlContent, request.captureDom);
    const screenshotBase64 =
      (request.captureScreenshot ?? true)
        ? PLACEHOLDER_SCREENSHOT_BASE64
        : null;

    const summary = passed
      ? `Browser verification passed at ${request.url} (${httpStatus}). Page title: "${pageTitle}". Console errors: 0. Network failures: 0.`
      : `Browser verification ${status} at ${request.url} (${httpStatus}). Errors: ${errors.join("; ")}.`;

    return {
      consoleErrors,
      consoleLogs: [],
      domSnippet,
      durationMs,
      element,
      errors,
      httpStatus,
      networkFailures,
      networkRequests,
      passed,
      screenshotBase64,
      status,
      summary,
      title: pageTitle,
      url: request.url,
    };
  }
}

// Minimal Playwright interfaces to prevent `any` usage
interface PlaywrightConsoleMessage {
  location: () => { url?: string };
  text: () => string;
  type: () => string;
}

interface PlaywrightRequest {
  failure: () => { errorText?: string } | null;
  method: () => string;
  resourceType: () => string;
  url: () => string;
}

interface PlaywrightResponse {
  ok: () => boolean;
  request: () => PlaywrightRequest;
  status: () => number;
  url: () => string;
}

interface PlaywrightPage {
  click: (selector: string, options?: { timeout?: number }) => Promise<void>;
  close: () => Promise<void>;
  content: () => Promise<string>;
  evaluate: <T>(script: string) => Promise<T>;
  fill: (
    selector: string,
    value: string,
    options?: { timeout?: number }
  ) => Promise<void>;
  goto: (
    url: string,
    options?: { timeout?: number; waitUntil?: string }
  ) => Promise<PlaywrightResponse | null>;
  locator: (selector: string) => {
    count: () => Promise<number>;
    first: () => {
      innerText: () => Promise<string>;
      isVisible: () => Promise<boolean>;
    };
  };
  on: (
    event: "console" | "pageerror" | "response" | "requestfailed" | "request",
    handler: (arg: never) => void
  ) => void;
  screenshot: (options?: { type?: string }) => Promise<Buffer>;
  title: () => Promise<string>;
  waitForSelector: (
    selector: string,
    options?: { timeout?: number }
  ) => Promise<unknown>;
}

interface PlaywrightBrowserContext {
  newPage: () => Promise<PlaywrightPage>;
}

interface PlaywrightBrowser {
  close: () => Promise<void>;
  newContext: (options?: {
    viewport?: { height: number; width: number };
  }) => Promise<PlaywrightBrowserContext>;
}

interface PlaywrightChromium {
  launch: (options?: {
    args?: string[];
    headless?: boolean;
  }) => Promise<PlaywrightBrowser>;
}

interface PlaywrightModule {
  chromium?: PlaywrightChromium;
}

function mapConsoleLevel(type: string): BrowserConsoleMessage["level"] {
  switch (type) {
    case "error":
      return "error";
    case "warning":
      return "warn";
    case "info":
      return "info";
    case "debug":
      return "debug";
    default:
      return "log";
  }
}

interface PageCollector {
  consoleErrors: BrowserConsoleMessage[];
  consoleLogs: BrowserConsoleMessage[];
  errors: string[];
  networkFailures: BrowserNetworkRequest[];
  networkRequests: BrowserNetworkRequest[];
}

function attachPageListeners(page: PlaywrightPage, collector: PageCollector) {
  const onConsole = (msg: PlaywrightConsoleMessage) => {
    const text = msg.text();
    const location = msg.location().url;
    const level = mapConsoleLevel(msg.type());

    const messageObj: BrowserConsoleMessage = {
      level,
      location: location || undefined,
      text,
      timestamp: new Date().toISOString(),
    };

    collector.consoleLogs.push(messageObj);
    if (level === "error") {
      collector.consoleErrors.push(messageObj);
    }
  };

  const onPageError = (err: Error) => {
    const messageObj: BrowserConsoleMessage = {
      level: "error",
      text: err.message,
      timestamp: new Date().toISOString(),
    };
    collector.consoleErrors.push(messageObj);
    collector.errors.push(`Page error: ${err.message}`);
  };

  const onRequest = (req: PlaywrightRequest) => {
    collector.networkRequests.push({
      method: req.method(),
      ok: true,
      resourceType: req.resourceType(),
      status: 0,
      url: req.url(),
    });
  };

  const onResponse = (res: PlaywrightResponse) => {
    const status = res.status();
    const ok = res.ok();
    const matching = collector.networkRequests.find((r) => r.url === res.url());
    if (matching) {
      matching.status = status;
      matching.ok = ok;
    }
    if (!ok) {
      collector.networkFailures.push({
        error: `HTTP ${status}`,
        method: res.request().method(),
        ok: false,
        resourceType: res.request().resourceType(),
        status,
        url: res.url(),
      });
    }
  };

  const onRequestFailed = (req: PlaywrightRequest) => {
    const failure = req.failure();
    collector.networkFailures.push({
      error: failure?.errorText ?? "Request failed",
      method: req.method(),
      ok: false,
      resourceType: req.resourceType(),
      status: 0,
      url: req.url(),
    });
  };

  page.on("console", onConsole as (arg: never) => void);
  page.on("pageerror", onPageError as (arg: never) => void);
  page.on("request", onRequest as (arg: never) => void);
  page.on("response", onResponse as (arg: never) => void);
  page.on("requestfailed", onRequestFailed as (arg: never) => void);
}

async function inspectPlaywrightElement(
  page: PlaywrightPage,
  selector: string,
  errors: string[]
): Promise<BrowserElementInspection> {
  const loc = page.locator(selector);
  const count = await loc.count();
  const exists = count > 0;
  let text: string | undefined;
  let visible = false;
  if (exists) {
    text =
      (await loc
        .first()
        .innerText()
        .catch(() => undefined)) || undefined;
    visible = await loc
      .first()
      .isVisible()
      .catch(() => false);
  }
  if (!exists) {
    errors.push(`Selector "${selector}" was not found.`);
  }
  return {
    count,
    exists,
    selector,
    text,
    visible,
  };
}

async function executeClickAction(
  page: PlaywrightPage,
  selector: string,
  timeoutMs: number,
  errors: string[]
): Promise<void> {
  try {
    await page.click(selector, { timeout: timeoutMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Click on selector "${selector}" failed: ${msg}`);
  }
}

async function executeFillAction(
  page: PlaywrightPage,
  selector: string,
  fillValue: string,
  timeoutMs: number,
  errors: string[]
): Promise<void> {
  try {
    await page.fill(selector, fillValue, { timeout: timeoutMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fill on selector "${selector}" failed: ${msg}`);
  }
}

async function executeScriptAction(
  page: PlaywrightPage,
  script: string,
  errors: string[]
): Promise<unknown> {
  try {
    return await page.evaluate(script);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Script evaluation failed: ${msg}`);
    return undefined;
  }
}

async function executeUserActions(
  page: PlaywrightPage,
  request: BrowserInspectionRequest,
  errors: string[]
): Promise<unknown> {
  const actionTimeout = Math.min(request.timeoutMs ?? 15_000, 5000);

  if (request.action === "click" && request.selector) {
    await executeClickAction(page, request.selector, actionTimeout, errors);
  } else if (
    request.action === "fill" &&
    request.selector &&
    request.fillValue !== undefined
  ) {
    await executeFillAction(
      page,
      request.selector,
      request.fillValue,
      actionTimeout,
      errors
    );
  }

  if (request.evaluateScript) {
    return await executeScriptAction(page, request.evaluateScript, errors);
  }
  return undefined;
}

async function capturePlaywrightScreenshot(
  page: PlaywrightPage,
  captureScreenshot?: boolean
): Promise<string | null> {
  if (captureScreenshot === false) {
    return null;
  }
  try {
    const buffer = await page.screenshot({ type: "png" });
    return buffer.toString("base64");
  } catch {
    return null;
  }
}

function verifyPlaywrightExpectations(
  request: BrowserInspectionRequest,
  title: string,
  htmlContent: string,
  errors: string[]
) {
  if (request.expectedTitle && !title.includes(request.expectedTitle)) {
    errors.push(`Expected title "${request.expectedTitle}", got "${title}".`);
  }
  if (request.expectedText && !htmlContent.includes(request.expectedText)) {
    errors.push(`Expected text "${request.expectedText}" not found in DOM.`);
  }
}

/**
 * Playwright Browser Driver for full headless Chromium verification.
 * Falls back to HttpBrowserDriver ONLY if Playwright is absent or Chromium fails to launch.
 * Once a session starts, navigation and assertion failures are recorded accurately without fallback.
 */
export class PlaywrightBrowserDriver implements BrowserDriver {
  private readonly fallbackDriver = new HttpBrowserDriver();

  private async loadPlaywright(): Promise<PlaywrightChromium | null> {
    try {
      const moduleLoader = new Function(
        'return import("playwright")'
      ) as () => Promise<PlaywrightModule>;
      const mod = await moduleLoader().catch(() => null);
      return mod?.chromium ?? null;
    } catch {
      return null;
    }
  }

  async navigateAndInspect(
    request: BrowserInspectionRequest
  ): Promise<BrowserInspectionResult> {
    const chromium = await this.loadPlaywright().catch(() => null);
    if (!chromium) {
      return await this.fallbackDriver.navigateAndInspect(request);
    }

    let browser: PlaywrightBrowser | null = null;
    try {
      browser = await chromium.launch({
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        headless: true,
      });
    } catch {
      // Launch failed (e.g. missing Linux shared-memory/font libraries in lightweight container)
      return await this.fallbackDriver.navigateAndInspect(request);
    }

    // Chromium launched successfully: execute full browser session without falling back
    try {
      return await this.runPlaywrightSession(browser, request);
    } finally {
      if (browser) {
        await browser.close().catch(() => undefined);
      }
    }
  }

  private async runPlaywrightSession(
    browser: PlaywrightBrowser,
    request: BrowserInspectionRequest
  ): Promise<BrowserInspectionResult> {
    const startTime = Date.now();
    const timeoutMs = request.timeoutMs ?? 15_000;
    const collector: PageCollector = {
      consoleErrors: [],
      consoleLogs: [],
      errors: [],
      networkFailures: [],
      networkRequests: [],
    };

    const context = await browser.newContext({
      viewport: request.viewport ?? { height: 720, width: 1280 },
    });
    const page = await context.newPage();
    attachPageListeners(page, collector);

    let httpStatus = 200;
    try {
      const response = await page.goto(request.url, {
        timeout: timeoutMs,
        waitUntil: "domcontentloaded",
      });
      httpStatus = response?.status() ?? 200;
    } catch (navErr) {
      const msg = navErr instanceof Error ? navErr.message : String(navErr);
      collector.errors.push(`Navigation failed: ${msg}`);
      collector.networkFailures.push({
        error: msg,
        method: "GET",
        ok: false,
        resourceType: "document",
        status: 0,
        url: request.url,
      });
      httpStatus = 0;
    }

    if (request.waitForSelector && httpStatus > 0) {
      try {
        await page.waitForSelector(request.waitForSelector, {
          timeout: Math.min(5000, timeoutMs),
        });
      } catch (waitErr) {
        const msg =
          waitErr instanceof Error ? waitErr.message : String(waitErr);
        collector.errors.push(
          `waitForSelector "${request.waitForSelector}" timed out: ${msg}`
        );
      }
    }

    const evaluationResult = await executeUserActions(
      page,
      request,
      collector.errors
    );
    const screenshotBase64 = await capturePlaywrightScreenshot(
      page,
      request.captureScreenshot
    );

    const title = await page.title().catch(() => "");
    const htmlContent = await page.content().catch(() => "");

    const element = request.selector
      ? await inspectPlaywrightElement(page, request.selector, collector.errors)
      : undefined;

    verifyPlaywrightExpectations(request, title, htmlContent, collector.errors);

    const durationMs = Date.now() - startTime;
    const failOnConsole = request.failOnConsoleErrors ?? true;
    const failOnNetwork = request.failOnNetworkErrors ?? true;

    const hasConsoleErrors =
      failOnConsole && collector.consoleErrors.length > 0;
    const hasNetworkFailures =
      failOnNetwork && collector.networkFailures.length > 0;
    const passed =
      collector.errors.length === 0 &&
      !hasConsoleErrors &&
      !hasNetworkFailures &&
      httpStatus >= 200 &&
      httpStatus < 400;

    const status = determineVerificationStatus(passed, httpStatus);
    const domSnippet = truncateDomSnippet(htmlContent, request.captureDom);
    const summary = passed
      ? `Playwright browser verification passed at ${request.url} (${httpStatus}). Page title: "${title}". 0 console errors.`
      : `Playwright browser verification ${status} at ${request.url} (${httpStatus}). Errors: ${collector.errors.join("; ")}.`;

    return {
      consoleErrors: collector.consoleErrors,
      consoleLogs: collector.consoleLogs,
      domSnippet,
      durationMs,
      element,
      errors: collector.errors,
      evaluationResult,
      httpStatus,
      networkFailures: collector.networkFailures,
      networkRequests: collector.networkRequests,
      passed,
      screenshotBase64,
      status,
      summary,
      title,
      url: request.url,
    };
  }
}

/**
 * Mock driver for deterministic test suites.
 */
export class MockBrowserDriver implements BrowserDriver {
  private readonly handler?:
    | ((
        request: BrowserInspectionRequest
      ) =>
        | Promise<Partial<BrowserInspectionResult>>
        | Partial<BrowserInspectionResult>)
    | undefined;

  constructor(
    handler?:
      | ((
          request: BrowserInspectionRequest
        ) =>
          | Promise<Partial<BrowserInspectionResult>>
          | Partial<BrowserInspectionResult>)
      | undefined
  ) {
    this.handler = handler;
  }

  async navigateAndInspect(
    request: BrowserInspectionRequest
  ): Promise<BrowserInspectionResult> {
    const custom = this.handler ? await this.handler(request) : {};

    const defaultResult: BrowserInspectionResult = {
      consoleErrors: [],
      consoleLogs: [],
      domSnippet: '<html><body><div id="root">App</div></body></html>',
      durationMs: 150,
      element: request.selector
        ? {
            count: 1,
            exists: true,
            selector: request.selector,
            text: "Mock element",
            visible: true,
          }
        : undefined,
      errors: [],
      httpStatus: 200,
      networkFailures: [],
      networkRequests: [
        {
          durationMs: 20,
          method: "GET",
          ok: true,
          status: 200,
          url: request.url,
        },
      ],
      passed: true,
      screenshotBase64: PLACEHOLDER_SCREENSHOT_BASE64,
      status: "passed",
      summary: `Mock browser verification passed for ${request.url}.`,
      title: "Mock App Title",
      url: request.url,
    };

    return {
      ...defaultResult,
      ...custom,
    };
  }
}
