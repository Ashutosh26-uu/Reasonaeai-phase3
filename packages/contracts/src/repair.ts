import { z } from "zod";
import { IsoDateTimeSchema, RunIdSchema } from "./identity.js";

export const DefectIdSchema = z.uuid().brand<"DefectId">();
export type DefectId = z.infer<typeof DefectIdSchema>;

export const SourceLocationSchema = z.strictObject({
  column: z.number().int().positive().optional(),
  file: z.string().min(1),
  line: z.number().int().positive(),
});
export type SourceLocation = z.infer<typeof SourceLocationSchema>;

export const TestStatusSchema = z.enum([
  "passed",
  "failed",
  "skipped",
  "error",
]);
export type TestStatus = z.infer<typeof TestStatusSchema>;

export const TestDiagnosticSchema = z.strictObject({
  actual: z.string().nullable().optional(),
  assertionFailure: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  expected: z.string().nullable().optional(),
  location: SourceLocationSchema.optional(),
  message: z.string().min(1),
  rawError: z.string().optional(),
  stackFrame: z.string().optional(),
  status: TestStatusSchema,
  suite: z.string().optional(),
  testFile: z.string().min(1),
  testTitle: z.string().min(1),
});
export type TestDiagnostic = z.infer<typeof TestDiagnosticSchema>;

export const TestFrameworkSchema = z.enum([
  "vitest",
  "jest",
  "tap",
  "node:test",
  "custom",
]);
export type TestFramework = z.infer<typeof TestFrameworkSchema>;

export const TestReportSchema = z.strictObject({
  durationMs: z.number().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  framework: TestFrameworkSchema,
  passed: z.boolean(),
  passedCount: z.number().int().nonnegative(),
  rawOutput: z.string().max(2_000_000).optional(),
  skippedCount: z.number().int().nonnegative(),
  summary: z.string(),
  tests: z.array(TestDiagnosticSchema),
  totalCount: z.number().int().nonnegative(),
});
export type TestReport = z.infer<typeof TestReportSchema>;

export const DefectClassificationSchema = z.enum([
  "assertion_failure",
  "runtime_error",
  "syntax_error",
  "type_error",
  "timeout",
  "unhandled_rejection",
  "unknown",
]);
export type DefectClassification = z.infer<typeof DefectClassificationSchema>;

export const FailureEnvelopeSchema = z.strictObject({
  classification: DefectClassificationSchema,
  defectId: DefectIdSchema,
  diagnostics: z.array(TestDiagnosticSchema).min(1),
  occurredAt: IsoDateTimeSchema,
  owningFile: z.string().min(1).optional(),
  reproductionCommand: z.string().min(1),
  runId: RunIdSchema.optional(),
  summary: z.string().min(1),
});
export type FailureEnvelope = z.infer<typeof FailureEnvelopeSchema>;

export const RepairAttemptStatusSchema = z.enum([
  "in_progress",
  "verified",
  "failed",
  "escalated",
]);
export type RepairAttemptStatus = z.infer<typeof RepairAttemptStatusSchema>;

export const RepairAttemptSchema = z.strictObject({
  attemptNumber: z.number().int().min(1).max(3),
  brief: z.string().min(1),
  defectId: DefectIdSchema,
  filesTouched: z.array(z.string().min(1)),
  hypothesis: z.string().min(1),
  status: RepairAttemptStatusSchema,
  timestamp: IsoDateTimeSchema,
});
export type RepairAttempt = z.infer<typeof RepairAttemptSchema>;

export const RepairOutcomeStatusSchema = z.enum([
  "verified",
  "failed",
  "regression_detected",
]);
export type RepairOutcomeStatus = z.infer<typeof RepairOutcomeStatusSchema>;

export const RepairOutcomeSchema = z.strictObject({
  attemptNumber: z.number().int().min(1).max(3),
  defectId: DefectIdSchema,
  fullSuitePassed: z.boolean(),
  isolatedTestPassed: z.boolean(),
  status: RepairOutcomeStatusSchema,
  summary: z.string().min(1),
});
export type RepairOutcome = z.infer<typeof RepairOutcomeSchema>;

export const DefectDetectedPayloadSchema = z.strictObject({
  classification: DefectClassificationSchema,
  defectId: DefectIdSchema,
  diagnostics: z.array(TestDiagnosticSchema).min(1),
  failingTestsCount: z.number().int().positive(),
  owningFile: z.string().optional(),
  reproductionCommand: z.string().min(1),
  summary: z.string().min(1),
});
export type DefectDetectedPayload = z.infer<typeof DefectDetectedPayloadSchema>;

export const RepairAttemptedPayloadSchema = z.strictObject({
  attemptNumber: z.number().int().min(1).max(3),
  brief: z.string().min(1),
  defectId: DefectIdSchema,
  hypothesis: z.string().min(1),
  targetFiles: z.array(z.string().min(1)),
});
export type RepairAttemptedPayload = z.infer<
  typeof RepairAttemptedPayloadSchema
>;

export const RepairVerifiedPayloadSchema = z.strictObject({
  attemptNumber: z.number().int().min(1).max(3),
  defectId: DefectIdSchema,
  fullSuitePassed: z.literal(true),
  isolatedTestPassed: z.literal(true),
  summary: z.string().min(1),
});
export type RepairVerifiedPayload = z.infer<typeof RepairVerifiedPayloadSchema>;

export const RepairFailedPayloadSchema = z.strictObject({
  attemptNumber: z.number().int().min(1).max(3),
  defectId: DefectIdSchema,
  escalated: z.boolean(),
  fullSuitePassed: z.boolean(),
  isolatedTestPassed: z.boolean(),
  reason: z.string().min(1),
});
export type RepairFailedPayload = z.infer<typeof RepairFailedPayloadSchema>;
