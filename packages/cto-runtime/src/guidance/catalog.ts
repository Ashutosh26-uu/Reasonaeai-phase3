/**
 * Bundled guidance: the policy applied to every run, plus the catalogs a run
 * selects scoped rules and skills from.
 *
 * The content lives as markdown under `packages/cto-runtime/guidance/` and is
 * embedded into `bundled.ts` by `scripts/generate-guidance.mjs`. Prose with code
 * samples is what these rules are; reviewing them inside TypeScript string
 * literals is how a wrong rule survives review, and reading them from disk at run
 * time would depend on a `guidance/` directory existing beside the compiled
 * output.
 *
 * Two scheduling rules matter to a prompt:
 *
 * - An always-applied rule is injected verbatim. Keep this set small and stable,
 *   because it is paid for on every model step of every run.
 * - A scoped rule is advertised by name, globs, and description only. The model
 *   reads it through `rule://<name>` when the files it governs are in scope, so a
 *   Go rule costs nothing on a Next.js run.
 *
 * Skills follow the same on-demand contract, keyed by description rather than by
 * a file pattern, because a skill is chosen by the task and not by the file.
 */

import { BUNDLED_RULES, BUNDLED_SKILLS } from "./bundled.js";

/** Rules injected into every prompt, in authored order. */
export function renderBundledRules(): string {
  return BUNDLED_RULES.filter((rule) => rule.always)
    .map((rule) => rule.content)
    .join("\n\n");
}

/**
 * The catalog of scoped rules.
 *
 * Globs are part of the advertisement: they are how the model decides that the
 * TypeScript rule applies to the `.tsx` file it is about to edit without reading
 * the rule first.
 */
export function renderRuleCatalog(): string {
  const scoped = BUNDLED_RULES.filter((rule) => !rule.always);
  if (scoped.length === 0) {
    return "";
  }

  return [
    "# Scoped rules",
    "Rules are constraints, not permission. Read a named rule only when the files it governs are in scope; the policy above is already applied and needs no startup enumeration.",
    ...scoped.map(
      (rule) =>
        `- rule://${rule.name} (${rule.globs.join(", ")}) — ${rule.description}`
    ),
  ].join("\n");
}

export function renderSkillCatalog(): string {
  return [
    "# Available skills",
    "Skills are task procedures, not permission. Read a named skill only when relevant; this bundled catalog needs no startup enumeration.",
    ...BUNDLED_SKILLS.map(
      (skill) => `- skill://${skill.name} — ${skill.description}`
    ),
  ].join("\n");
}
