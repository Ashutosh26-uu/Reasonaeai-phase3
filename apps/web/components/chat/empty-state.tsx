"use client";

import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";

export interface EmptyStateProps {
  /** The composer, placed where the first message is written. */
  children: ReactNode;
  /** The icon shown above the heading. */
  mark: ReactNode;
  /** Selects a starter prompt into the composer. */
  onStarter: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** True when the conversation already has a run in flight. */
  pending: boolean;
  starters: readonly string[];
}

/**
 * The conversation before it has content.
 *
 * One prompt field, centered, with nothing else competing for attention: the
 * first thing a person does is type, and every control that is not typing is
 * noise until then. Starters are offered because an empty field is the hardest
 * place to start, and the mark names whose field it is.
 */
export function EmptyState({
  children,
  mark,
  onStarter,
  pending,
  starters,
}: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="empty-mark">{mark}</div>
      <h2 className="empty-title">What are we building?</h2>
      <p className="empty-note">
        {pending
          ? "Your CTO is working in the project sandbox. Send the next message when this run finishes."
          : "Describe the product, the change, or the problem. Everything stays with this project."}
      </p>
      {children}
      <div className="starters">
        {starters.map((starter) => (
          <button
            className="starter"
            key={starter}
            onClick={onStarter}
            type="button"
            value={starter}
          >
            <Sparkles aria-hidden="true" size={13} />
            {starter}
          </button>
        ))}
      </div>
    </div>
  );
}
