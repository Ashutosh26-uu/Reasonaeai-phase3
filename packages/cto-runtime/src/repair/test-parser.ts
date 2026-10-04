import type {
  DefectClassification,
  SourceLocation,
  TestDiagnostic,
  TestFramework,
  TestReport,
} from "@reasonateai/contracts/repair";

const ANSI_REGEX =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: necessary for stripping terminal ANSI codes
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

const SOURCE_LOC_REGEX =
  /(?:at\s+(?:.+?\s+\()?)?([a-zA-Z0-9_\-./\\]+\.(?:ts|tsx|js|jsx|mjs|cjs)):(\d+)(?::(\d+))?\)?/;

const EXPECTED_VAL_REGEX = /Expected(?:\s+value)?:\s*([^\n]+)/i;
const RECEIVED_VAL_REGEX = /(?:Received|Actual)(?:\s+value)?:\s*([^\n]+)/i;
const DIFF_REGEX =
  /-\s+Expected\s*\n\+?\s*Received\s*\n\s*-\s+([^\n]+)\n\s*\+\s+([^\n]+)/i;
const TO_EQUAL_REGEX =
  /expected\s+([^\n]+?)\s+to\s+(?:deeply\s+)?equal\s+([^\n]+)/i;

const TAP_RESULT_REGEX = /^(not ok|ok)\s+(\d+)\s*-\s*(.+)$/;
const TAP_ERROR_REGEX = /error:\s*['"]?([^\n'"]+)['"]?/i;
const TAP_EXPECTED_REGEX = /expected:\s*([^\n]+)/i;
const TAP_ACTUAL_REGEX = /actual:\s*([^\n]+)/i;
const TAP_STACK_REGEX =
  /stack:\s*\|-?\s*\n([\s\S]+?)(?=\n\s*[a-zA-Z0-9_-]+:|\.\.\.|$)/i;
const TAP_LOCATION_REGEX =
  /location:\s*['"]?([^\n'":]+):(\d+)(?::(\d+))?['"]?/i;

const FAIL_LINE_REGEX = /FAIL\s+([^\s>]+)(?:\s*>\s*(.+))?/;
const PASS_LINE_REGEX = /PASS\s+([^\s>]+)(?:\s*>\s*(.+))?/;
const SUMMARY_LINE_REGEX = /(\d+)\s+failed.*(\d+)\s+passed/i;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

export function cleanStackTrace(rawStack?: string): string | undefined {
  if (!rawStack) {
    return undefined;
  }
  const lines = rawStack.split("\n");
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) {
      return true;
    }
    return !(
      trimmed.includes("node_modules/") ||
      trimmed.includes("node_modules\\") ||
      trimmed.includes("node:internal/") ||
      trimmed.includes("node:internal\\") ||
      trimmed.includes("internal/process/") ||
      trimmed.includes("@vitest/") ||
      trimmed.includes("vitest/dist/") ||
      trimmed.includes("@jest/") ||
      trimmed.includes("jest-runner")
    );
  });

  const result = filtered.join("\n").trim();
  return result.length > 0 ? result : lines[0]?.trim();
}

export function extractSourceLocation(
  text: string
): SourceLocation | undefined {
  const lines = text.split("\n");
  for (const line of lines) {
    if (
      line.includes("node_modules/") ||
      line.includes("node_modules\\") ||
      line.includes("node:internal/") ||
      line.includes("node:internal\\")
    ) {
      continue;
    }

    const atMatch: RegExpExecArray | null = SOURCE_LOC_REGEX.exec(line);
    if (atMatch === null) {
      continue;
    }
    const [, filePart = "", linePart = "", colPart] = atMatch;
    if (filePart && linePart) {
      const file = filePart.replace(/\\/g, "/");
      const lineNum = Number.parseInt(linePart, 10);
      const colNum = colPart ? Number.parseInt(colPart, 10) : undefined;
      if (lineNum > 0) {
        return {
          ...(colNum && colNum > 0 ? { column: colNum } : {}),
          file,
          line: lineNum,
        };
      }
    }
  }
  return undefined;
}

export function extractExpectedActual(message: string): {
  actual?: string;
  expected?: string;
} {
  const expectedMatch: RegExpExecArray | null =
    EXPECTED_VAL_REGEX.exec(message);
  const receivedMatch: RegExpExecArray | null =
    RECEIVED_VAL_REGEX.exec(message);
  if (expectedMatch !== null || receivedMatch !== null) {
    const res: { actual?: string; expected?: string } = {};
    if (receivedMatch !== null) {
      const [, receivedVal = ""] = receivedMatch;
      if (receivedVal) {
        res.actual = receivedVal.trim();
      }
    }
    if (expectedMatch !== null) {
      const [, expectedVal = ""] = expectedMatch;
      if (expectedVal) {
        res.expected = expectedVal.trim();
      }
    }
    return res;
  }

  const diffMatch: RegExpExecArray | null = DIFF_REGEX.exec(message);
  if (diffMatch !== null) {
    const [, expectedVal = "", actualVal = ""] = diffMatch;
    if (expectedVal && actualVal) {
      return {
        actual: actualVal.trim(),
        expected: expectedVal.trim(),
      };
    }
  }

  const toEqualMatch: RegExpExecArray | null = TO_EQUAL_REGEX.exec(message);
  if (toEqualMatch !== null) {
    const [, actualVal = "", expectedVal = ""] = toEqualMatch;
    if (actualVal && expectedVal) {
      return {
        actual: actualVal.trim(),
        expected: expectedVal.trim(),
      };
    }
  }

  return {};
}

export function classifyTestFailure(
  diagnostic: Partial<TestDiagnostic>
): DefectClassification {
  const combined =
    `${diagnostic.message ?? ""} ${diagnostic.assertionFailure ?? ""} ${diagnostic.rawError ?? ""} ${diagnostic.stackFrame ?? ""}`.toLowerCase();

  if (
    combined.includes("assertionerror") ||
    combined.includes("err_assertion") ||
    (combined.includes("expected") && combined.includes("received")) ||
    (combined.includes("expected") && combined.includes("equal")) ||
    combined.includes("expect(")
  ) {
    return "assertion_failure";
  }

  if (
    combined.includes("typeerror") ||
    combined.includes("is not a function") ||
    combined.includes("cannot read property") ||
    combined.includes("cannot read properties") ||
    combined.includes("is undefined") ||
    combined.includes("is not defined")
  ) {
    return "type_error";
  }

  if (
    combined.includes("syntaxerror") ||
    combined.includes("unexpected token") ||
    combined.includes("parsing error")
  ) {
    return "syntax_error";
  }

  if (
    combined.includes("timeout") ||
    combined.includes("timed out") ||
    combined.includes("timeouterror")
  ) {
    return "timeout";
  }

  if (
    combined.includes("unhandledrejection") ||
    combined.includes("unhandledpromiserejection")
  ) {
    return "unhandled_rejection";
  }

  if (diagnostic.status === "failed" || diagnostic.status === "error") {
    return "runtime_error";
  }

  return "unknown";
}

interface JestOrVitestAssertionResult {
  ancestorTitles?: string[];
  duration?: number;
  failureMessages?: string[];
  fullName?: string;
  location?: { column?: number; line: number };
  status: string;
  title: string;
}

interface JestOrVitestTestFileResult {
  assertionResults?: JestOrVitestAssertionResult[];
  endTime?: number;
  message?: string;
  name: string;
  startTime?: number;
  status: string;
}

interface JestOrVitestJsonOutput {
  numFailedTests?: number;
  numPassedTests?: number;
  numPendingTests?: number;
  numTotalTests?: number;
  startTime?: number;
  testResults?: JestOrVitestTestFileResult[];
}

function tryParseJsonBlob(text: string): JestOrVitestJsonOutput | null {
  const clean = stripAnsi(text);
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  const candidate = clean.slice(firstBrace, lastBrace + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && "testResults" in parsed) {
      return parsed as JestOrVitestJsonOutput;
    }
  } catch {
    // JSON parse error, ignore and fall through
  }
  return null;
}

function buildFailedAssertionDiagnostic(
  testCase: JestOrVitestAssertionResult,
  testFile: string,
  suite?: string
): TestDiagnostic {
  const rawError = testCase.failureMessages?.join("\n") ?? "Test failed";
  const firstLine =
    rawError.split("\n").find((line) => line.trim().length > 0) ??
    "Assertion failed";
  const { actual, expected } = extractExpectedActual(rawError);
  let location: SourceLocation | undefined;
  if (testCase.location?.line) {
    location = {
      ...(testCase.location.column ? { column: testCase.location.column } : {}),
      file: testFile,
      line: testCase.location.line,
    };
  } else {
    location = extractSourceLocation(rawError);
  }

  return {
    ...(actual === undefined ? {} : { actual }),
    assertionFailure: firstLine.trim(),
    ...(testCase.duration === undefined
      ? {}
      : { durationMs: testCase.duration }),
    ...(expected === undefined ? {} : { expected }),
    ...(location ? { location } : {}),
    message: firstLine.trim(),
    rawError,
    stackFrame: cleanStackTrace(rawError),
    status: "failed",
    ...(suite ? { suite } : {}),
    testFile,
    testTitle: testCase.title,
  };
}

function parseAssertionResult(
  testCase: JestOrVitestAssertionResult,
  testFile: string
): TestDiagnostic {
  const suite = testCase.ancestorTitles?.join(" > ") || undefined;
  const testTitle = testCase.title;
  const durationMs = testCase.duration;

  if (testCase.status === "passed") {
    return {
      ...(durationMs === undefined ? {} : { durationMs }),
      message: "Passed",
      status: "passed",
      ...(suite ? { suite } : {}),
      testFile,
      testTitle,
    };
  }

  if (testCase.status === "failed" || testCase.status === "error") {
    return buildFailedAssertionDiagnostic(testCase, testFile, suite);
  }

  return {
    ...(durationMs === undefined ? {} : { durationMs }),
    message: "Skipped",
    status: "skipped",
    ...(suite ? { suite } : {}),
    testFile,
    testTitle,
  };
}

function parseFileExecutionFailure(
  fileResult: JestOrVitestTestFileResult,
  testFile: string
): TestDiagnostic {
  const msg = fileResult.message ?? "Test file failed to execute";
  return {
    location: extractSourceLocation(msg),
    message: msg.split("\n")[0] || "Test file failed",
    rawError: msg,
    stackFrame: cleanStackTrace(msg),
    status: "failed",
    testFile,
    testTitle: "File execution",
  };
}

function parseJsonTestResults(
  json: JestOrVitestJsonOutput,
  framework: "vitest" | "jest",
  rawOutput: string
): TestReport {
  const tests: TestDiagnostic[] = [];
  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const fileResult of json.testResults ?? []) {
    const testFile = fileResult.name.replace(/\\/g, "/");

    if (
      (!fileResult.assertionResults ||
        fileResult.assertionResults.length === 0) &&
      fileResult.status === "failed"
    ) {
      failedCount += 1;
      tests.push(parseFileExecutionFailure(fileResult, testFile));
      continue;
    }

    for (const testCase of fileResult.assertionResults ?? []) {
      const diag = parseAssertionResult(testCase, testFile);
      if (diag.status === "passed") {
        passedCount += 1;
      } else if (diag.status === "failed") {
        failedCount += 1;
      } else {
        skippedCount += 1;
      }
      tests.push(diag);
    }
  }

  const totalCount =
    json.numTotalTests ?? passedCount + failedCount + skippedCount;
  const passed = failedCount === 0 && (totalCount > 0 || tests.length === 0);

  return {
    durationMs: 0,
    failedCount,
    framework,
    passed,
    passedCount,
    rawOutput,
    skippedCount,
    summary: `${passedCount} passed, ${failedCount} failed, ${totalCount} total`,
    tests,
    totalCount,
  };
}

function applyTapMessages(
  target: Partial<TestDiagnostic>,
  yamlText: string
): void {
  const errorMatch: RegExpExecArray | null = TAP_ERROR_REGEX.exec(yamlText);
  if (errorMatch !== null) {
    const [, errorVal = ""] = errorMatch;
    if (errorVal) {
      target.message = errorVal.trim();
      target.assertionFailure = errorVal.trim();
    }
  }

  const expectedMatch: RegExpExecArray | null =
    TAP_EXPECTED_REGEX.exec(yamlText);
  if (expectedMatch !== null) {
    const [, expectedVal = ""] = expectedMatch;
    if (expectedVal) {
      target.expected = expectedVal.trim();
    }
  }

  const actualMatch: RegExpExecArray | null = TAP_ACTUAL_REGEX.exec(yamlText);
  if (actualMatch !== null) {
    const [, actualVal = ""] = actualMatch;
    if (actualVal) {
      target.actual = actualVal.trim();
    }
  }
}

function applyTapLocation(
  target: Partial<TestDiagnostic>,
  yamlText: string
): void {
  const locationMatch: RegExpExecArray | null =
    TAP_LOCATION_REGEX.exec(yamlText);
  if (locationMatch === null) {
    return;
  }
  const [, locFile = "", locLine = "", locCol] = locationMatch;
  if (locFile && locLine) {
    const file = locFile.replace(/\\/g, "/");
    const line = Number.parseInt(locLine, 10);
    const col = locCol ? Number.parseInt(locCol, 10) : undefined;
    target.location = {
      ...(col ? { column: col } : {}),
      file,
      line,
    };
    if (target.testFile === "unknown.test.ts") {
      target.testFile = file;
    }
  }
}

function applyTapStack(
  target: Partial<TestDiagnostic>,
  yamlText: string
): void {
  const stackMatch: RegExpExecArray | null = TAP_STACK_REGEX.exec(yamlText);
  if (stackMatch === null) {
    return;
  }
  const [, stackVal = ""] = stackMatch;
  if (!stackVal) {
    return;
  }
  target.stackFrame = cleanStackTrace(stackVal);
  const loc = extractSourceLocation(stackVal);
  if (loc) {
    target.location = target.location ?? loc;
    if (target.testFile === "unknown.test.ts") {
      target.testFile = loc.file;
    }
  }
}

function applyTapYaml(target: Partial<TestDiagnostic>, yamlText: string): void {
  applyTapMessages(target, yamlText);
  applyTapLocation(target, yamlText);
  applyTapStack(target, yamlText);
  target.rawError = yamlText;
}

function parseTapSubtestHeader(trimmed: string): {
  file?: string;
  suite?: string;
} {
  const name = trimmed.slice(10).trim();
  if (name.endsWith(".ts") || name.endsWith(".js") || name.endsWith(".mjs")) {
    return { file: name.replace(/\\/g, "/") };
  }
  return { suite: name };
}

function parseTapResultLine(
  trimmed: string,
  currentFile: string,
  currentSuite?: string
): Partial<TestDiagnostic> | null {
  const testMatch: RegExpExecArray | null = TAP_RESULT_REGEX.exec(trimmed);
  if (testMatch === null) {
    return null;
  }
  const [, okStatus = "", , testTitle = ""] = testMatch;
  if (!(okStatus && testTitle)) {
    return null;
  }
  const title = testTitle.trim();
  if (title === currentFile || title.endsWith(".ts") || title.endsWith(".js")) {
    return null;
  }
  const isFailed = okStatus === "not ok";
  return {
    message: isFailed ? `Test failed: ${title}` : "Passed",
    status: isFailed ? "failed" : "passed",
    ...(currentSuite ? { suite: currentSuite } : {}),
    testFile: currentFile,
    testTitle: title,
  };
}

function summarizeTapReport(
  tests: TestDiagnostic[],
  rawText: string
): TestReport {
  const passedCount = tests.filter((t) => t.status === "passed").length;
  const failedCount = tests.filter(
    (t) => t.status === "failed" || t.status === "error"
  ).length;
  const skippedCount = tests.filter((t) => t.status === "skipped").length;
  const totalCount = tests.length;

  return {
    durationMs: 0,
    failedCount,
    framework: "tap",
    passed: failedCount === 0 && totalCount > 0,
    passedCount,
    rawOutput: rawText,
    skippedCount,
    summary: `TAP: ${passedCount} passed, ${failedCount} failed, ${totalCount} total`,
    tests,
    totalCount,
  };
}

function flushTapTest(
  currentTest: Partial<TestDiagnostic> | null,
  yamlLines: string[],
  tests: TestDiagnostic[]
): void {
  if (!currentTest) {
    return;
  }
  const yamlText = yamlLines.join("\n");
  if (yamlText.length > 0) {
    applyTapYaml(currentTest, yamlText);
  }
  tests.push(currentTest as TestDiagnostic);
}

function handleTapYamlLine(
  line: string,
  trimmed: string,
  yamlLines: string[],
  flush: () => void
): boolean {
  if (trimmed === "...") {
    flush();
    return false;
  }
  yamlLines.push(line);
  return true;
}

export function parseTapOutput(rawText: string): TestReport {
  const clean = stripAnsi(rawText);
  const lines = clean.split("\n");
  const tests: TestDiagnostic[] = [];
  let currentFile = "unknown.test.ts";
  let currentSuite: string | undefined;

  let inYaml = false;
  let yamlLines: string[] = [];
  let currentTest: Partial<TestDiagnostic> | null = null;

  const flush = () => {
    flushTapTest(currentTest, yamlLines, tests);
    currentTest = null;
    yamlLines = [];
    inYaml = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("# Subtest:")) {
      const header = parseTapSubtestHeader(trimmed);
      if (header.file) {
        currentFile = header.file;
      } else if (header.suite) {
        currentSuite = header.suite;
      }
      continue;
    }

    if (inYaml) {
      inYaml = handleTapYamlLine(line, trimmed, yamlLines, flush);
      continue;
    }

    if (trimmed === "---") {
      inYaml = true;
      yamlLines = [];
      continue;
    }

    const testDiag = parseTapResultLine(trimmed, currentFile, currentSuite);
    if (testDiag !== null) {
      if (currentTest) {
        flush();
      }
      currentTest = testDiag;
    }
  }

  if (currentTest) {
    flush();
  }

  return summarizeTapReport(tests, rawText);
}

function parseHumanReadableFailure(
  failMatch: RegExpExecArray,
  lines: string[],
  startIndex: number
): { diagnostic: TestDiagnostic; nextIndex: number } {
  const currentFile = failMatch[1]?.replace(/\\/g, "/") ?? "test";
  const title = failMatch[2]?.trim() || "Assertion failed";

  const errorLines: string[] = [];
  let j = startIndex + 1;
  while (
    j < lines.length &&
    !(lines[j] ?? "").trim().startsWith("FAIL") &&
    !(lines[j] ?? "").trim().startsWith("PASS") &&
    !(lines[j] ?? "").trim().startsWith("Tests:")
  ) {
    errorLines.push(lines[j] ?? "");
    j += 1;
  }
  const rawError = errorLines.join("\n").trim();
  const firstLine =
    errorLines.find((l) => l.trim().length > 0)?.trim() || title;
  const { actual, expected } = extractExpectedActual(rawError);
  const location =
    extractSourceLocation(rawError) ??
    extractSourceLocation(lines[startIndex] ?? "");

  return {
    diagnostic: {
      ...(actual ? { actual } : {}),
      assertionFailure: firstLine,
      ...(expected ? { expected } : {}),
      ...(location ? { location } : {}),
      message: firstLine,
      rawError,
      stackFrame: cleanStackTrace(rawError),
      status: "failed",
      testFile: currentFile,
      testTitle: title,
    },
    nextIndex: j - 1,
  };
}

function parseHumanReadablePass(trimmed: string): TestDiagnostic | null {
  const passMatch: RegExpExecArray | null = PASS_LINE_REGEX.exec(trimmed);
  if (passMatch === null) {
    return null;
  }
  const [, passFile = "", passTitle] = passMatch;
  if (!passFile) {
    return null;
  }
  return {
    message: "Passed",
    status: "passed",
    testFile: passFile.replace(/\\/g, "/"),
    testTitle: passTitle?.trim() || "Suite passed",
  };
}

function parseHumanReadableSummary(trimmed: string): {
  failed: number;
  passed: number;
} | null {
  const summaryMatch: RegExpExecArray | null = SUMMARY_LINE_REGEX.exec(trimmed);
  if (summaryMatch === null) {
    return null;
  }
  const [, failedStr = "", passedStr = ""] = summaryMatch;
  if (failedStr && passedStr) {
    return {
      failed: Number.parseInt(failedStr, 10),
      passed: Number.parseInt(passedStr, 10),
    };
  }
  return null;
}

function buildExecutionFallbackDiagnostic(
  clean: string,
  lines: string[]
): TestDiagnostic {
  const firstNonEmpty =
    lines.find((l) => l.trim().length > 0)?.trim() ||
    "Test runner exited with failure";
  const loc = extractSourceLocation(clean);
  return {
    assertionFailure: firstNonEmpty,
    ...(loc ? { location: loc } : {}),
    message: firstNonEmpty,
    rawError: clean,
    stackFrame: cleanStackTrace(clean),
    status: "failed",
    testFile: loc?.file || "test",
    testTitle: "Test command execution",
  };
}

export function parseHumanReadableOutput(
  rawText: string,
  exitCode: number
): TestReport {
  const clean = stripAnsi(rawText);
  const lines = clean.split("\n");
  const tests: TestDiagnostic[] = [];

  let failedCount = 0;
  let passedCount = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    const failMatch: RegExpExecArray | null = FAIL_LINE_REGEX.exec(trimmed);
    if (failMatch !== null) {
      const [, failFile = ""] = failMatch;
      if (failFile) {
        failedCount += 1;
        const { diagnostic, nextIndex } = parseHumanReadableFailure(
          failMatch,
          lines,
          i
        );
        tests.push(diagnostic);
        i = nextIndex;
        continue;
      }
    }

    const passDiag = parseHumanReadablePass(trimmed);
    if (passDiag !== null) {
      passedCount += 1;
      tests.push(passDiag);
      continue;
    }

    const summary = parseHumanReadableSummary(trimmed);
    if (summary !== null) {
      failedCount = Math.max(failedCount, summary.failed);
      passedCount = Math.max(passedCount, summary.passed);
    }
  }

  if (exitCode !== 0 && tests.length === 0) {
    tests.push(buildExecutionFallbackDiagnostic(clean, lines));
    failedCount = 1;
  }

  const totalCount = passedCount + failedCount;
  return {
    durationMs: 0,
    failedCount,
    framework: "custom",
    passed: exitCode === 0 && failedCount === 0,
    passedCount,
    rawOutput: rawText,
    skippedCount: 0,
    summary: `${passedCount} passed, ${failedCount} failed, ${totalCount} total`,
    tests,
    totalCount,
  };
}

export function parseTestExecutionOutput(input: {
  exitCode: number;
  framework?: TestFramework;
  stderr?: string;
  stdout?: string;
}): TestReport {
  const stdout = input.stdout ?? "";
  const stderr = input.stderr ?? "";
  const combined = `${stdout}\n${stderr}`.trim();

  const json = tryParseJsonBlob(combined);
  if (json) {
    const framework = input.framework === "jest" ? "jest" : "vitest";
    return parseJsonTestResults(json, framework, combined);
  }

  if (
    combined.includes("TAP version") ||
    combined.includes("1..") ||
    combined.includes("not ok ") ||
    combined.includes("ok 1")
  ) {
    const tapReport = parseTapOutput(combined);
    if (tapReport.tests.length > 0) {
      return tapReport;
    }
  }

  return parseHumanReadableOutput(combined, input.exitCode);
}
