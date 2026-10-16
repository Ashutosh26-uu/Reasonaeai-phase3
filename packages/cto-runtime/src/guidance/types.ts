/**
 * The shape of one piece of bundled guidance.
 *
 * A rule states a constraint and a skill describes a procedure. Both are
 * addressed by name and both are immutable once loaded, so the only difference
 * that reaches the code is how a rule is scheduled: `always` rules are injected
 * into every prompt, while a scoped rule carries the globs it governs and is
 * read on demand, so a Go rule never spends context on a Next.js run.
 */
export interface GuidanceEntry {
  readonly content: string;
  readonly description: string;
  readonly name: string;
}

/** A rule, with the scheduling that decides whether it is always in the prompt. */
export interface GuidanceRule extends GuidanceEntry {
  /** Injected into every system prompt rather than advertised for on-demand reading. */
  readonly always: boolean;
  /** File patterns the rule governs. Empty exactly when `always` is true. */
  readonly globs: readonly string[];
}
