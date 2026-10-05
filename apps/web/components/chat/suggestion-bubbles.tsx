"use client";

import {
  LayoutGrid,
  PencilRuler,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { memo, useCallback } from "react";
import styles from "./suggestion-bubbles.module.css";
import type { PromptSuggestion } from "./suggestions";

export interface SuggestionBubblesProps {
  /** Whether interaction is disabled (e.g. while composer is busy). */
  disabled?: boolean | undefined;
  /** Optional callback to dismiss the suggestions row. */
  onDismiss?: (() => void) | undefined;
  /** Optional callback to refresh / shuffle alternative suggestions. */
  onRefresh?: (() => void) | undefined;
  /** Callback triggered when a user clicks a suggestion bubble. */
  onSelect: (suggestion: PromptSuggestion) => void;
  /** Array of 4 suggestions to render in the scrollable row. */
  suggestions: PromptSuggestion[];
}

function CategoryIcon({ icon }: { icon: PromptSuggestion["icon"] }) {
  switch (icon) {
    case "sparkles":
      return (
        <Sparkles aria-hidden="true" className={styles.watermark} size={24} />
      );
    case "design":
      return (
        <PencilRuler
          aria-hidden="true"
          className={styles.watermark}
          size={24}
        />
      );
    case "feature":
      return (
        <LayoutGrid aria-hidden="true" className={styles.watermark} size={24} />
      );
    case "quality":
      return (
        <ShieldCheck
          aria-hidden="true"
          className={styles.watermark}
          size={24}
        />
      );
    default:
      return (
        <Sparkles aria-hidden="true" className={styles.watermark} size={24} />
      );
  }
}

function badgeClass(category: PromptSuggestion["category"]): string {
  switch (category) {
    case "ai":
      return `${styles.badge ?? ""} ${styles.badgeAi ?? ""}`.trim();
    case "design":
      return `${styles.badge ?? ""} ${styles.badgeDesign ?? ""}`.trim();
    case "feature":
      return `${styles.badge ?? ""} ${styles.badgeFeature ?? ""}`.trim();
    case "quality":
      return `${styles.badge ?? ""} ${styles.badgeQuality ?? ""}`.trim();
    default:
      return styles.badge ?? "";
  }
}

export const SuggestionBubbles = memo(function SuggestionBubblesView({
  suggestions,
  onSelect,
  onDismiss,
  onRefresh,
  disabled = false,
}: SuggestionBubblesProps) {
  const handleSelect = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const { id } = event.currentTarget.dataset;
      const found = suggestions.find((item) => item.id === id);
      if (found) {
        onSelect(found);
      }
    },
    [onSelect, suggestions]
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLUListElement>) => {
      if (event.deltaY !== 0 && event.deltaX === 0) {
        event.currentTarget.scrollLeft += event.deltaY;
      }
    },
    []
  );

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <section aria-label="Suggested next actions" className={styles.container}>
      <ul className={styles.scrollArea} onWheel={handleWheel}>
        {suggestions.map((suggestion) => (
          <li className={styles.item} key={suggestion.id}>
            <button
              aria-label={`Suggestion: ${suggestion.title} (${suggestion.categoryLabel})`}
              className={styles.bubble}
              data-id={suggestion.id}
              disabled={disabled}
              onClick={handleSelect}
              title={suggestion.prompt}
              type="button"
            >
              <CategoryIcon icon={suggestion.icon} />
              <p className={styles.title}>{suggestion.title}</p>
              <div className={styles.badgeRow}>
                <span className={badgeClass(suggestion.category)}>
                  {suggestion.categoryLabel}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>

      {(onRefresh || onDismiss) && (
        <div className={styles.actions}>
          {onRefresh && (
            <button
              aria-label="More suggestions"
              className={styles.actionButton}
              disabled={disabled}
              onClick={onRefresh}
              title="More suggestions"
              type="button"
            >
              <RefreshCw aria-hidden="true" size={13} />
            </button>
          )}
          {onDismiss && (
            <button
              aria-label="Dismiss suggestions"
              className={styles.actionButton}
              disabled={disabled}
              onClick={onDismiss}
              title="Dismiss suggestions"
              type="button"
            >
              <X aria-hidden="true" size={14} />
            </button>
          )}
        </div>
      )}
    </section>
  );
});
