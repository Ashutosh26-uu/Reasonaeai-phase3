import { describe, expect, it } from "vitest";
import {
  BrowserActionSchema,
  BrowserConsoleMessageSchema,
  BrowserElementInspectionSchema,
  BrowserInspectionRequestSchema,
  BrowserInspectionResultSchema,
  BrowserNetworkRequestSchema,
  BrowserVerificationFailedPayloadSchema,
  BrowserVerificationPassedPayloadSchema,
  BrowserVerificationStartedPayloadSchema,
} from "../src/browser.js";

const SELECTOR_REQUIRED_REGEX = /Selector is required/;
const FILL_VALUE_REQUIRED_REGEX = /fillValue is required/;
const EVALUATE_SCRIPT_REQUIRED_REGEX = /evaluateScript is required/;

describe("Browser contracts", () => {
  it("validates BrowserAction values", () => {
    expect(BrowserActionSchema.parse("verify")).toBe("verify");
    expect(BrowserActionSchema.parse("navigate")).toBe("navigate");
    expect(BrowserActionSchema.parse("screenshot")).toBe("screenshot");
    expect(BrowserActionSchema.parse("inspect_dom")).toBe("inspect_dom");
    expect(() => BrowserActionSchema.parse("invalid_action")).toThrow();
  });

  it("validates BrowserConsoleMessageSchema", () => {
    const msg = {
      level: "error",
      location: "http://localhost:3000/app.js:42:10",
      text: "Uncaught TypeError: Cannot read properties of undefined",
      timestamp: new Date().toISOString(),
    };
    expect(BrowserConsoleMessageSchema.parse(msg)).toEqual(msg);
    expect(() =>
      BrowserConsoleMessageSchema.parse({
        ...msg,
        level: "fatal",
      })
    ).toThrow();
  });

  it("validates BrowserNetworkRequestSchema", () => {
    const req = {
      durationMs: 120,
      method: "GET",
      ok: true,
      resourceType: "fetch",
      status: 200,
      url: "http://localhost:3000/api/data",
    };
    expect(BrowserNetworkRequestSchema.parse(req)).toEqual(req);

    const failedReq = {
      durationMs: 50,
      error: "net::ERR_CONNECTION_REFUSED",
      method: "POST",
      ok: false,
      status: 500,
      url: "http://localhost:3000/api/fail",
    };
    expect(BrowserNetworkRequestSchema.parse(failedReq)).toEqual(failedReq);
  });

  it("validates BrowserElementInspectionSchema", () => {
    const element = {
      attributes: { id: "submit-button", type: "submit" },
      count: 1,
      exists: true,
      selector: "button#submit-button",
      text: "Submit",
      visible: true,
    };
    expect(BrowserElementInspectionSchema.parse(element)).toEqual(element);
  });

  it("validates BrowserInspectionRequestSchema with defaults", () => {
    const parsed = BrowserInspectionRequestSchema.parse({
      url: "http://localhost:3000",
    });
    expect(parsed.action).toBe("verify");
    expect(parsed.captureConsole).toBe(true);
    expect(parsed.captureDom).toBe(true);
    expect(parsed.captureNetwork).toBe(true);
    expect(parsed.captureScreenshot).toBe(true);
    expect(parsed.timeoutMs).toBe(15_000);
    expect(parsed.failOnConsoleErrors).toBe(true);
    expect(parsed.failOnNetworkErrors).toBe(true);
  });

  it("enforces action parameter requirements for click, fill, and evaluate", () => {
    // click requires selector
    expect(() =>
      BrowserInspectionRequestSchema.parse({
        action: "click",
        url: "http://localhost:3000",
      })
    ).toThrow(SELECTOR_REQUIRED_REGEX);

    expect(
      BrowserInspectionRequestSchema.parse({
        action: "click",
        selector: "#submit",
        url: "http://localhost:3000",
      }).selector
    ).toBe("#submit");

    // fill requires selector and fillValue
    expect(() =>
      BrowserInspectionRequestSchema.parse({
        action: "fill",
        selector: "#input",
        url: "http://localhost:3000",
      })
    ).toThrow(FILL_VALUE_REQUIRED_REGEX);

    expect(() =>
      BrowserInspectionRequestSchema.parse({
        action: "fill",
        fillValue: "hello",
        url: "http://localhost:3000",
      })
    ).toThrow(SELECTOR_REQUIRED_REGEX);

    expect(
      BrowserInspectionRequestSchema.parse({
        action: "fill",
        fillValue: "test-user",
        selector: "#username",
        url: "http://localhost:3000",
      }).fillValue
    ).toBe("test-user");

    // evaluate requires evaluateScript
    expect(() =>
      BrowserInspectionRequestSchema.parse({
        action: "evaluate",
        url: "http://localhost:3000",
      })
    ).toThrow(EVALUATE_SCRIPT_REQUIRED_REGEX);

    expect(
      BrowserInspectionRequestSchema.parse({
        action: "evaluate",
        evaluateScript: "document.title",
        url: "http://localhost:3000",
      }).evaluateScript
    ).toBe("document.title");
  });

  it("validates BrowserInspectionResultSchema", () => {
    const result = {
      consoleErrors: [],
      consoleLogs: [
        {
          level: "info",
          text: "App mounted",
          timestamp: new Date().toISOString(),
        },
      ],
      domSnippet: '<div id="root"><h1>Reasonate App</h1></div>',
      durationMs: 450,
      element: {
        count: 1,
        exists: true,
        selector: "h1",
        text: "Reasonate App",
      },
      errors: [],
      httpStatus: 200,
      networkFailures: [],
      networkRequests: [
        {
          durationMs: 30,
          method: "GET",
          ok: true,
          status: 200,
          url: "http://localhost:3000/",
        },
      ],
      passed: true,
      screenshotBase64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      status: "passed",
      summary:
        "Browser verification passed with 0 console errors and 0 network failures.",
      title: "Reasonate App",
      url: "http://localhost:3000",
    };

    expect(BrowserInspectionResultSchema.parse(result)).toEqual(result);
  });

  it("validates verification lifecycle event payloads", () => {
    const now = new Date().toISOString();
    const started = BrowserVerificationStartedPayloadSchema.parse({
      action: "verify",
      targetUrl: "http://localhost:3000/",
      timestamp: now,
    });
    expect(started.action).toBe("verify");

    const passed = BrowserVerificationPassedPayloadSchema.parse({
      durationMs: 500,
      hasScreenshot: true,
      summary: "Verification passed",
      targetUrl: "http://localhost:3000/",
      title: "Dashboard",
    });
    expect(passed.hasScreenshot).toBe(true);

    const failed = BrowserVerificationFailedPayloadSchema.parse({
      consoleErrorsCount: 2,
      durationMs: 600,
      errors: [
        "Console error: Uncaught TypeError",
        "Failed to load /api/user: 500",
      ],
      networkFailuresCount: 1,
      summary: "Verification failed with errors",
      targetUrl: "http://localhost:3000/",
    });
    expect(failed.consoleErrorsCount).toBe(2);
  });
});
