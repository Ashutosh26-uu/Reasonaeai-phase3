import { randomUUID } from "node:crypto";
import type { RunEventType } from "@reasonateai/contracts/execution-protocol";
import type {
  DefectClassification,
  DefectId,
  FailureEnvelope,
  RepairOutcome,
  TestDiagnostic,
  TestFramework,
  TestReport,
} from "@reasonateai/contracts/repair";
import { classifyTestFailure } from "./test-parser.js";
import { escapeRegex } from "./test-tool.js";

export interface RepairAttemptRecord {
  attemptNumber: number;
  brief: string;
  error?: string;
  filesTouched: string[];
  fullSuitePassed?: boolean;
  hypothesis: string;
  isolatedTestPassed: boolean;
  status: "verified" | "failed" | "regression_detected";
}

export interface RepairBrief {
  attemptNumber: number;
  defectId: DefectId;
  failingTest: TestDiagnostic;
  failureEnvelope: FailureEnvelope;
  history: RepairAttemptRecord[];
  hypothesis: string;
  instructions: string;
  owningFile?: string;
  targetFiles: string[];
}

export interface RepairResult {
  error?: string;
  filesTouched: string[];
  hypothesis?: string;
  success: boolean;
}

export interface RepairEventEmission {
  payload: Record<string, unknown>;
  type: RunEventType;
}

export interface SelfDebuggingOrchestratorConfig {
  applyRepair: (brief: RepairBrief) => Promise<RepairResult>;
  emitEvent?: (event: RepairEventEmission) => Promise<void> | void;
  initialReport?: TestReport;
  maxAttempts?: number;
  runTests: (options: {
    testFile?: string;
    testNamePattern?: string;
    timeoutMs?: number;
  }) => Promise<TestReport>;
}

export type OrchestrationOutcome =
  | {
      defectId?: never;
      report: TestReport;
      status: "no_defects";
    }
  | {
      attempts: RepairAttemptRecord[];
      defectId: DefectId;
      envelope: FailureEnvelope;
      finalReport: TestReport;
      isolatedReport: TestReport;
      outcome: RepairOutcome;
      status: "verified";
    }
  | {
      attempts: RepairAttemptRecord[];
      defectId: DefectId;
      envelope: FailureEnvelope;
      escalated: true;
      finalReport?: TestReport;
      reason: string;
      status: "failed";
    };

const TEST_FILE_RE = /\.(test|spec)\.[jt]sx?$/;
const STACK_SOURCE_FILE_RE =
  /(?:at\s+(?:.+?\s+\()?)?([a-zA-Z0-9_\-./\\]+\.[jt]sx?):/i;
const TEST_DIR_PATTERN = /(^|\/)tests?\//;
const TEST_EXT_DOT_RE = /\.test\./;
const SPEC_EXT_DOT_RE = /\.spec\./;

export function buildReproductionCommand(params: {
  framework?: TestFramework;
  testFile: string;
  testTitle: string;
}): string {
  const { framework, testFile, testTitle } = params;
  const normalizedFile = testFile.replace(/\\/g, "/");
  if (framework === "node:test" || framework === "tap") {
    return `node --test --test-reporter=tap --test-name-pattern="${testTitle}" ${normalizedFile}`;
  }
  if (framework === "jest") {
    return `pnpm exec jest -t "${testTitle}" ${normalizedFile}`;
  }
  return `pnpm vitest run ${normalizedFile} -t "${testTitle}"`;
}

export function resolveOwningFile(diagnostic: TestDiagnostic): string {
  if (diagnostic.location?.file) {
    const locFile = diagnostic.location.file.replace(/\\/g, "/");
    if (!TEST_FILE_RE.test(locFile)) {
      return locFile;
    }
  }

  if (diagnostic.stackFrame) {
    const lines = diagnostic.stackFrame.split("\n");
    for (const line of lines) {
      const match = STACK_SOURCE_FILE_RE.exec(line);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: RegExp.exec returns null at runtime on mismatch
      if (match?.[1]) {
        const file = match[1].replace(/\\/g, "/");
        if (!(TEST_FILE_RE.test(file) || file.includes("node_modules"))) {
          return file;
        }
      }
    }
  }

  const normalizedTestFile = diagnostic.testFile.replace(/\\/g, "/");
  const inferred = normalizedTestFile
    .replace(TEST_DIR_PATTERN, "$1src/")
    .replace(TEST_EXT_DOT_RE, ".")
    .replace(SPEC_EXT_DOT_RE, ".");
  if (inferred !== normalizedTestFile) {
    return inferred;
  }

  return normalizedTestFile;
}

export class SelfDebuggingOrchestrator {
  readonly #config: SelfDebuggingOrchestratorConfig;
  readonly #maxAttempts: number;

  constructor(config: SelfDebuggingOrchestratorConfig) {
    this.#config = config;
    this.#maxAttempts = config.maxAttempts ?? 3;
    if (this.#maxAttempts < 1 || this.#maxAttempts > 3) {
      throw new Error("maxAttempts must be between 1 and 3.");
    }
  }

  async #emit(
    type: RunEventType,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (this.#config.emitEvent) {
      await this.#config.emitEvent({ payload, type });
    }
  }

  async #tryApplyPatch(brief: RepairBrief): Promise<RepairResult> {
    try {
      return await this.#config.applyRepair(brief);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        filesTouched: [],
        success: false,
      };
    }
  }

  async #executeSingleAttempt(params: {
    attempt: number;
    classification: DefectClassification;
    defectId: DefectId;
    envelope: FailureEnvelope;
    history: RepairAttemptRecord[];
    owningFile: string;
    primaryDiagnostic: TestDiagnostic;
  }): Promise<
    | { outcome: OrchestrationOutcome; terminal: true }
    | { record: RepairAttemptRecord; terminal: false }
  > {
    const {
      attempt,
      classification,
      defectId,
      envelope,
      history,
      owningFile,
      primaryDiagnostic,
    } = params;

    const hypothesis = `Fix ${classification} in ${owningFile}: expected ${primaryDiagnostic.expected ?? "valid result"}, received ${primaryDiagnostic.actual ?? "failure"}.`;
    const instructions = `Fix ${classification} detected at ${primaryDiagnostic.location ? `${primaryDiagnostic.location.file}:${primaryDiagnostic.location.line}` : owningFile}.
Failing test: "${primaryDiagnostic.testTitle}" in ${primaryDiagnostic.testFile}
Assertion: ${primaryDiagnostic.assertionFailure ?? primaryDiagnostic.message}
Expected: ${primaryDiagnostic.expected ?? "N/A"}
Actual: ${primaryDiagnostic.actual ?? "N/A"}
Target file: ${owningFile}
Task: Inspect and edit ${owningFile} using existing conventions to repair the root cause. Rerun scenario.`;

    const brief: RepairBrief = {
      attemptNumber: attempt,
      defectId,
      failingTest: primaryDiagnostic,
      failureEnvelope: envelope,
      history: [...history],
      hypothesis,
      instructions,
      owningFile,
      targetFiles: [owningFile],
    };

    await this.#emit("run.repair_attempted", {
      attemptNumber: attempt,
      brief: instructions,
      defectId,
      hypothesis,
      targetFiles: [owningFile],
    });

    const repairResult = await this.#tryApplyPatch(brief);
    if (!repairResult.success) {
      const errorMsg =
        repairResult.error ?? "Repair application returned failure";
      const record: RepairAttemptRecord = {
        attemptNumber: attempt,
        brief: instructions,
        error: errorMsg,
        filesTouched: repairResult.filesTouched,
        hypothesis,
        isolatedTestPassed: false,
        status: "failed",
      };
      if (attempt === this.#maxAttempts) {
        await this.#emit("run.repair_failed", {
          attemptNumber: attempt,
          defectId,
          escalated: true,
          fullSuitePassed: false,
          isolatedTestPassed: false,
          reason: errorMsg,
        });
        return {
          outcome: {
            attempts: [...history, record],
            defectId,
            envelope,
            escalated: true,
            reason: errorMsg,
            status: "failed",
          },
          terminal: true,
        };
      }
      return { record, terminal: false };
    }

    const isolatedReport = await this.#config.runTests({
      testFile: primaryDiagnostic.testFile,
      testNamePattern: escapeRegex(primaryDiagnostic.testTitle),
    });

    if (!isolatedReport.passed || isolatedReport.failedCount > 0) {
      const reason = `Isolated test verification failed: ${isolatedReport.summary}`;
      const record: RepairAttemptRecord = {
        attemptNumber: attempt,
        brief: instructions,
        error: reason,
        filesTouched: repairResult.filesTouched,
        hypothesis,
        isolatedTestPassed: false,
        status: "failed",
      };
      if (attempt === this.#maxAttempts) {
        await this.#emit("run.repair_failed", {
          attemptNumber: attempt,
          defectId,
          escalated: true,
          fullSuitePassed: false,
          isolatedTestPassed: false,
          reason,
        });
        return {
          outcome: {
            attempts: [...history, record],
            defectId,
            envelope,
            escalated: true,
            finalReport: isolatedReport,
            reason,
            status: "failed",
          },
          terminal: true,
        };
      }
      return { record, terminal: false };
    }

    const fullSuiteReport = await this.#config.runTests({});
    if (!fullSuiteReport.passed || fullSuiteReport.failedCount > 0) {
      const reason = `Full suite regression detected: ${fullSuiteReport.summary}`;
      const record: RepairAttemptRecord = {
        attemptNumber: attempt,
        brief: instructions,
        error: reason,
        filesTouched: repairResult.filesTouched,
        fullSuitePassed: false,
        hypothesis,
        isolatedTestPassed: true,
        status: "regression_detected",
      };
      if (attempt === this.#maxAttempts) {
        await this.#emit("run.repair_failed", {
          attemptNumber: attempt,
          defectId,
          escalated: true,
          fullSuitePassed: false,
          isolatedTestPassed: true,
          reason,
        });
        return {
          outcome: {
            attempts: [...history, record],
            defectId,
            envelope,
            escalated: true,
            finalReport: fullSuiteReport,
            reason,
            status: "failed",
          },
          terminal: true,
        };
      }
      return { record, terminal: false };
    }

    const verifiedRecord: RepairAttemptRecord = {
      attemptNumber: attempt,
      brief: instructions,
      filesTouched: repairResult.filesTouched,
      fullSuitePassed: true,
      hypothesis,
      isolatedTestPassed: true,
      status: "verified",
    };

    await this.#emit("run.repair_verified", {
      attemptNumber: attempt,
      defectId,
      fullSuitePassed: true,
      isolatedTestPassed: true,
      summary: `Defect repaired and verified on attempt ${attempt} with zero regressions.`,
    });

    const outcome: RepairOutcome = {
      attemptNumber: attempt,
      defectId,
      fullSuitePassed: true,
      isolatedTestPassed: true,
      status: "verified",
      summary: `Repaired on attempt ${attempt} and verified against regression.`,
    };

    return {
      outcome: {
        attempts: [...history, verifiedRecord],
        defectId,
        envelope,
        finalReport: fullSuiteReport,
        isolatedReport,
        outcome,
        status: "verified",
      },
      terminal: true,
    };
  }

  async execute(): Promise<OrchestrationOutcome> {
    const initialReport =
      this.#config.initialReport ?? (await this.#config.runTests({}));

    if (initialReport.passed && initialReport.failedCount === 0) {
      return { report: initialReport, status: "no_defects" };
    }

    const failingDiagnostics = initialReport.tests.filter(
      (t) => t.status === "failed" || t.status === "error"
    );

    const defaultSummary =
      initialReport.summary || "Test suite execution failed";
    const primaryDiagnostic: TestDiagnostic = failingDiagnostics[0] ?? {
      assertionFailure: defaultSummary,
      message: defaultSummary,
      status: "failed",
      testFile: "tests",
      testTitle: "Suite failure",
    };

    const classification = classifyTestFailure(primaryDiagnostic);
    const owningFile = resolveOwningFile(primaryDiagnostic);
    const defectId = randomUUID() as DefectId;
    const reproductionCommand = buildReproductionCommand({
      framework: initialReport.framework,
      testFile: primaryDiagnostic.testFile,
      testTitle: primaryDiagnostic.testTitle,
    });
    const summary = `${classification} in ${primaryDiagnostic.testTitle}: ${primaryDiagnostic.assertionFailure ?? primaryDiagnostic.message}`;

    const envelope: FailureEnvelope = {
      classification,
      defectId,
      diagnostics:
        failingDiagnostics.length > 0
          ? failingDiagnostics
          : [primaryDiagnostic],
      occurredAt: new Date().toISOString(),
      owningFile,
      reproductionCommand,
      summary,
    };

    await this.#emit("run.defect_detected", {
      classification,
      defectId,
      diagnostics: envelope.diagnostics,
      failingTestsCount: envelope.diagnostics.length,
      owningFile,
      reproductionCommand,
      summary,
    });

    const history: RepairAttemptRecord[] = [];

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential repair attempts require awaiting previous verification
      const step = await this.#executeSingleAttempt({
        attempt,
        classification,
        defectId,
        envelope,
        history,
        owningFile,
        primaryDiagnostic,
      });

      if (step.terminal) {
        return step.outcome;
      }
      history.push(step.record);
    }

    const exhaustedReason = `Bounded retries exhausted (${this.#maxAttempts} attempts) without resolving defect.`;
    await this.#emit("run.repair_failed", {
      attemptNumber: this.#maxAttempts,
      defectId,
      escalated: true,
      fullSuitePassed: false,
      isolatedTestPassed: false,
      reason: exhaustedReason,
    });

    return {
      attempts: history,
      defectId,
      envelope,
      escalated: true,
      reason: exhaustedReason,
      status: "failed",
    };
  }
}
