import type { WorkerLogLevel } from "./config.js";

/**
 * Structured logs for the execution plane.
 *
 * Every line carries the run, build session, organization, and project it
 * belongs to, so a run can be followed from claim to terminal status without
 * correlating free text. Fields are explicit and primitive: the logger has no
 * way to accept a prompt, a tool result, or a provider body, and a field whose
 * name looks like a credential is redacted even if a caller passes one by
 * mistake.
 */

export type LogFields = Readonly<
  Record<string, boolean | null | number | string | undefined>
>;

export interface Logger {
  debug: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
}

const LEVEL_RANK: Record<WorkerLogLevel, number> = {
  debug: 0,
  error: 3,
  info: 1,
  warn: 2,
};

/**
 * A field named after a credential never reaches the log line. Comparison is on
 * the normalized name, so `apiKey`, `api_key`, and `API-KEY` all match.
 */
const REDACTED_FIELD_NAMES: Record<string, true> = {
  apikey: true,
  authorization: true,
  cookie: true,
  credential: true,
  password: true,
  prompt: true,
  secret: true,
  token: true,
};

const REDACTED = "[redacted]";

/** A logged value stays one bounded line. */
const MAX_VALUE_LENGTH = 512;

export interface LoggerOptions {
  level: WorkerLogLevel;
  now?: () => Date;
  write?: (line: string) => void;
}

function isRedactedField(name: string): boolean {
  const normalized = name.toLowerCase().replaceAll(/[^a-z]/g, "");
  return REDACTED_FIELD_NAMES[normalized] === true;
}

function sanitize(
  value: boolean | null | number | string
): boolean | null | number | string {
  if (typeof value === "string" && value.length > MAX_VALUE_LENGTH) {
    return `${value.slice(0, MAX_VALUE_LENGTH)}…`;
  }
  return value;
}

export function createLogger(options: LoggerOptions): Logger {
  const write =
    options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const emit = (
    level: WorkerLogLevel,
    event: string,
    fields: LogFields = {}
  ): void => {
    if (LEVEL_RANK[level] < LEVEL_RANK[options.level]) {
      return;
    }

    const line: Record<string, boolean | null | number | string> = {
      at: now().toISOString(),
      event,
      level,
    };
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined) {
        continue;
      }
      line[name] = isRedactedField(name) ? REDACTED : sanitize(value);
    }

    write(JSON.stringify(line));
  };

  return {
    debug: (event, fields) => emit("debug", event, fields),
    error: (event, fields) => emit("error", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
  };
}
