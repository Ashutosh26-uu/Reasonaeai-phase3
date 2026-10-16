#!/usr/bin/env node
/**
 * Embed the authored guidance markdown into a TypeScript module.
 *
 * Rules and skills are prose with code samples. Keeping them as markdown makes
 * them reviewable and keeps the diff of a rule change readable; embedding them in
 * a module makes the compiled artifact self-contained, so a run never depends on
 * a `guidance/` directory existing next to `dist/`. This script is the bridge.
 *
 * Invariants it enforces, because a malformed guidance file costs a run its
 * prompt without failing anything at runtime:
 *   - every file has frontmatter with a unique kebab-case `name` and a description
 *   - a rule is either `always: true` (injected everywhere, no globs) or scoped
 *     with at least one glob, never both and never neither
 *   - skills declare neither `always` nor `globs`: a skill is selected by its
 *     description, not by a file pattern
 *   - names are unique across rules and skills, since both are addressed by name
 *   - a rule's `name` matches its file name, so a reader can find the source
 *
 * Run with `--check` to verify the generated module is current without writing.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUIDANCE_DIR = join(PACKAGE_ROOT, "guidance");
const OUTPUT_PATH = join(PACKAGE_ROOT, "src", "guidance", "bundled.ts");

const LINE_BREAK_PATTERN = /\r?\n/;
const LEADING_BREAKS_PATTERN = /^\n+/;
const MARKDOWN_SUFFIX_PATTERN = /\.md$/;
const TRAILING_BREAKS_PATTERN = /\n+$/;
const STRUCTURED_VALUE_PATTERN = /^[["]/;
const MAX_DESCRIPTION_CHARS = 1024;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RULE_KEYS = new Set(["always", "description", "globs", "name"]);
const SKILL_KEYS = new Set(["description", "name"]);

const GENERATED_HEADER = `/**
 * GENERATED FILE — do not edit.
 *
 * Source: packages/cto-runtime/guidance/{rules,skills}/*.md
 * Regenerate: pnpm --filter @reasonateai/cto-runtime generate:guidance
 *
 * A test fails when this module is stale, so a rule edited without regenerating
 * cannot reach a run.
 */
`;

function fail(label, message) {
  throw new Error(`${label}: ${message}`);
}

function parseValue(raw, label, key) {
  if (raw === "true" || raw === "false") {
    return raw === "true";
  }
  if (STRUCTURED_VALUE_PATTERN.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {
      return fail(
        label,
        `frontmatter value for ${key} is not valid JSON: ${raw}`
      );
    }
  }
  return raw;
}

function parseFrontmatter(label, rawFrontmatter) {
  const frontmatter = {};
  for (const line of rawFrontmatter.split(LINE_BREAK_PATTERN)) {
    if (line.trim() === "") {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator === -1) {
      return fail(label, `frontmatter line is not a key/value pair: ${line}`);
    }
    const key = line.slice(0, separator).trim();
    if (Object.hasOwn(frontmatter, key)) {
      return fail(label, `duplicate frontmatter key: ${key}`);
    }
    frontmatter[key] = parseValue(line.slice(separator + 1).trim(), label, key);
  }
  return frontmatter;
}

function parseDocument(source, label) {
  const lines = source.split(LINE_BREAK_PATTERN);
  const closingIndex = lines.indexOf("---", 1);
  if (lines[0] !== "---" || closingIndex <= 0) {
    return fail(label, "missing --- frontmatter block");
  }
  const rawBody = lines.slice(closingIndex + 1).join("\n");
  return {
    content: `${rawBody
      .replace(LEADING_BREAKS_PATTERN, "")
      .replace(TRAILING_BREAKS_PATTERN, "")}\n`,
    frontmatter: parseFrontmatter(
      label,
      lines.slice(1, closingIndex).join("\n")
    ),
  };
}

function describeValue(value) {
  return Array.isArray(value) ? `[${value.join(", ")}]` : String(value);
}

function buildRule(label, document) {
  const { content, frontmatter } = document;
  const { name, description } = frontmatter;
  const { always, globs = [] } = frontmatter;

  if (typeof always !== "boolean") {
    return fail(label, "a rule requires always: true or always: false");
  }
  if (!Array.isArray(globs) || globs.some((glob) => typeof glob !== "string")) {
    return fail(label, "globs must be a JSON array of strings");
  }
  if (always && globs.length > 0) {
    return fail(label, "an always-applied rule cannot declare globs");
  }
  if (!always && globs.length === 0) {
    return fail(
      label,
      "a scoped rule needs globs; use always: true for guidance that applies everywhere"
    );
  }
  return { always, content, description, globs, name };
}

function buildSkill(document) {
  const { content, frontmatter } = document;
  const { name, description } = frontmatter;
  return { content, description, name };
}

function validateEntry(label, entry) {
  const { name, description, content } = entry;
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    return fail(
      label,
      `name must be kebab-case, received ${describeValue(name)}`
    );
  }
  if (name !== label.split("/")[2].replace(MARKDOWN_SUFFIX_PATTERN, "")) {
    return fail(label, `name must match the file name, received ${name}`);
  }
  if (typeof description !== "string" || description.trim() === "") {
    return fail(label, "description is required");
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return fail(
      label,
      `description exceeds ${MAX_DESCRIPTION_CHARS} characters`
    );
  }
  if (content.trim() === "") {
    return fail(label, "body is empty");
  }
  return entry;
}

function buildEntry(file, kind) {
  const label = `guidance/${kind}/${file.name}`;
  const allowed = kind === "rules" ? RULE_KEYS : SKILL_KEYS;
  const document = parseDocument(file.source, label);
  for (const key of Object.keys(document.frontmatter)) {
    if (!allowed.has(key)) {
      return fail(label, `unsupported frontmatter key ${key}`);
    }
  }
  const entry =
    kind === "rules" ? buildRule(label, document) : buildSkill(document);
  return validateEntry(label, entry);
}

async function loadKind(kind) {
  const directory = join(GUIDANCE_DIR, kind);
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return fail(`guidance/${kind}`, "directory is missing");
  }

  const files = names
    .filter((name) => name.endsWith(".md"))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) {
    return fail(`guidance/${kind}`, "contains no markdown files");
  }

  const sources = await Promise.all(
    files.map(async (name) => ({
      name,
      source: await readFile(join(directory, name), "utf8"),
    }))
  );
  return sources.map((file) => buildEntry(file, kind));
}

// Render a value the way the formatter wants it: a plain quoted string when it
// fits on one line, a template literal when it does not, with the three
// characters that would terminate or interpolate a template literal escaped.
function renderString(value) {
  if (!value.includes("\n")) {
    return JSON.stringify(value);
  }
  return `\`${value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${")}\``;
}

// The generated module is linted like any other source. Biome's formatter breaks
// a property whose line exceeds the print width, and it must be reproduced here
// exactly: a generator that emits a line the formatter then rewrites would leave
// the freshness check permanently failing.
const PRINT_WIDTH = 80;

function renderAttribute(indent, key, renderedValue) {
  const single = `${indent}${key}: ${renderedValue},`;
  if (single.length <= PRINT_WIDTH) {
    return single;
  }
  return `${indent}${key}:\n${indent}  ${renderedValue},`;
}

function renderGlobs(globs) {
  const inline = `    globs: [${globs.map((glob) => JSON.stringify(glob)).join(", ")}],`;
  if (inline.length <= PRINT_WIDTH) {
    return inline;
  }
  return [
    "    globs: [",
    ...globs.map((glob) => `      ${JSON.stringify(glob)},`),
    "    ],",
  ].join("\n");
}

function renderRule(entry) {
  return [
    "  {",
    `    always: ${entry.always},`,
    `    content: ${renderString(entry.content)},`,
    renderAttribute("    ", "description", renderString(entry.description)),
    renderGlobs(entry.globs),
    renderAttribute("    ", "name", renderString(entry.name)),
    "  },",
  ].join("\n");
}

function renderSkill(entry) {
  return [
    "  {",
    `    content: ${renderString(entry.content)},`,
    renderAttribute("    ", "description", renderString(entry.description)),
    renderAttribute("    ", "name", renderString(entry.name)),
    "  },",
  ].join("\n");
}

function renderModule(bundle) {
  return [
    GENERATED_HEADER,
    'import type { GuidanceEntry, GuidanceRule } from "./types.js";',
    "",
    "/** Every rule, in authored order. `always` decides how the prompt uses it. */",
    "export const BUNDLED_RULES: readonly GuidanceRule[] = [",
    bundle.rules.map(renderRule).join("\n"),
    "];",
    "",
    "/** Every skill. Selected by description, read on demand through `skill://`. */",
    "export const BUNDLED_SKILLS: readonly GuidanceEntry[] = [",
    bundle.skills.map(renderSkill).join("\n"),
    "];",
    "",
  ].join("\n");
}

function assertUniqueNames(bundle) {
  const seen = new Set();
  for (const { name } of [...bundle.rules, ...bundle.skills]) {
    if (seen.has(name)) {
      throw new Error(`guidance name ${name} is used more than once`);
    }
    seen.add(name);
  }
}

const entries = {
  rules: await loadKind("rules"),
  skills: await loadKind("skills"),
};
assertUniqueNames(entries);
const generated = renderModule(entries);

if (process.argv.includes("--check")) {
  const existing = await readFile(OUTPUT_PATH, "utf8").catch(() => "");
  if (existing !== generated) {
    process.stderr.write(
      "src/guidance/bundled.ts is stale. Run: pnpm --filter @reasonateai/cto-runtime generate:guidance\n"
    );
    process.exit(1);
  }
  process.stdout.write(
    `guidance is current: ${entries.rules.length} rules, ${entries.skills.length} skills\n`
  );
} else {
  await writeFile(OUTPUT_PATH, generated);
  process.stdout.write(
    `wrote src/guidance/bundled.ts: ${entries.rules.length} rules, ${entries.skills.length} skills\n`
  );
}
