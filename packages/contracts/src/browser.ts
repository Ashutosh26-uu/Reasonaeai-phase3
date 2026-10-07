import { z } from "zod";
import { IsoDateTimeSchema } from "./identity.js";

export const BrowserActionSchema = z.enum([
  "navigate",
  "screenshot",
  "inspect_dom",
  "click",
  "fill",
  "evaluate",
  "verify",
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;

export const BrowserConsoleLevelSchema = z.enum([
  "log",
  "debug",
  "info",
  "warn",
  "error",
]);
export type BrowserConsoleLevel = z.infer<typeof BrowserConsoleLevelSchema>;

export const BrowserConsoleMessageSchema = z.strictObject({
  level: BrowserConsoleLevelSchema,
  location: z.string().optional(),
  text: z.string(),
  timestamp: IsoDateTimeSchema,
});
export type BrowserConsoleMessage = z.infer<typeof BrowserConsoleMessageSchema>;

export const BrowserNetworkRequestSchema = z.strictObject({
  durationMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
  method: z.string().default("GET"),
  ok: z.boolean(),
  resourceType: z.string().optional(),
  status: z.number().int(),
  url: z.string(),
});
export type BrowserNetworkRequest = z.infer<typeof BrowserNetworkRequestSchema>;

export const BrowserElementInspectionSchema = z.strictObject({
  attributes: z.record(z.string(), z.string()).optional(),
  count: z.number().int().nonnegative(),
  exists: z.boolean(),
  selector: z.string(),
  text: z.string().optional(),
  visible: z.boolean().optional(),
});
export type BrowserElementInspection = z.infer<
  typeof BrowserElementInspectionSchema
>;

export const BrowserViewportSchema = z.strictObject({
  height: z.number().int().positive().max(4320).default(720),
  width: z.number().int().positive().max(7680).default(1280),
});
export type BrowserViewport = z.infer<typeof BrowserViewportSchema>;

export const BrowserVerificationStatusSchema = z.enum([
  "passed",
  "failed",
  "error",
]);
export type BrowserVerificationStatus = z.infer<
  typeof BrowserVerificationStatusSchema
>;

export const BrowserInspectionRequestSchema = z
  .strictObject({
    action: BrowserActionSchema.default("verify").optional(),
    captureConsole: z.boolean().default(true).optional(),
    captureDom: z.boolean().default(true).optional(),
    captureNetwork: z.boolean().default(true).optional(),
    captureScreenshot: z.boolean().default(true).optional(),
    evaluateScript: z.string().max(10_000).optional(),
    expectedText: z.string().max(4000).optional(),
    expectedTitle: z.string().max(500).optional(),
    failOnConsoleErrors: z.boolean().default(true).optional(),
    failOnNetworkErrors: z.boolean().default(true).optional(),
    fillValue: z.string().max(2000).optional(),
    previewId: z.string().uuid().optional(),
    selector: z.string().max(1000).optional(),
    timeoutMs: z.number().int().min(500).max(60_000).default(15_000).optional(),
    url: z.string().min(1).max(2048),
    viewport: BrowserViewportSchema.optional(),
    waitForSelector: z.string().max(1000).optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.action === "click" &&
      (!data.selector || data.selector.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Selector is required when action is 'click'",
        path: ["selector"],
      });
    }
    if (data.action === "fill") {
      if (!data.selector || data.selector.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Selector is required when action is 'fill'",
          path: ["selector"],
        });
      }
      if (data.fillValue === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "fillValue is required when action is 'fill'",
          path: ["fillValue"],
        });
      }
    }
    if (
      data.action === "evaluate" &&
      (!data.evaluateScript || data.evaluateScript.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "evaluateScript is required when action is 'evaluate'",
        path: ["evaluateScript"],
      });
    }
  });
export type BrowserInspectionRequest = z.infer<
  typeof BrowserInspectionRequestSchema
>;

export const BrowserInspectionResultSchema = z.strictObject({
  consoleErrors: z.array(BrowserConsoleMessageSchema),
  consoleLogs: z.array(BrowserConsoleMessageSchema),
  domSnippet: z.string().nullable().optional(),
  durationMs: z.number().nonnegative(),
  element: BrowserElementInspectionSchema.optional(),
  errors: z.array(z.string()),
  evaluationResult: z.unknown().optional(),
  httpStatus: z.number().int(),
  networkFailures: z.array(BrowserNetworkRequestSchema),
  networkRequests: z.array(BrowserNetworkRequestSchema),
  passed: z.boolean(),
  screenshotArtifactId: z.string().optional(),
  screenshotBase64: z.string().nullable().optional(),
  status: BrowserVerificationStatusSchema,
  summary: z.string(),
  title: z.string(),
  url: z.string(),
});
export type BrowserInspectionResult = z.infer<
  typeof BrowserInspectionResultSchema
>;

export const BrowserVerificationStartedPayloadSchema = z.strictObject({
  action: BrowserActionSchema,
  targetUrl: z.string(),
  timestamp: IsoDateTimeSchema,
});
export type BrowserVerificationStartedPayload = z.infer<
  typeof BrowserVerificationStartedPayloadSchema
>;

export const BrowserVerificationPassedPayloadSchema = z.strictObject({
  durationMs: z.number().nonnegative(),
  hasScreenshot: z.boolean(),
  summary: z.string(),
  targetUrl: z.string(),
  title: z.string(),
});
export type BrowserVerificationPassedPayload = z.infer<
  typeof BrowserVerificationPassedPayloadSchema
>;

export const BrowserVerificationFailedPayloadSchema = z.strictObject({
  consoleErrorsCount: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  errors: z.array(z.string()),
  networkFailuresCount: z.number().int().nonnegative(),
  summary: z.string(),
  targetUrl: z.string(),
});
export type BrowserVerificationFailedPayload = z.infer<
  typeof BrowserVerificationFailedPayloadSchema
>;
