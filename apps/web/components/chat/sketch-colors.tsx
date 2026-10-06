import { useCallback } from "react";
import styles from "./sketch.module.css";
import type { SketchStyle } from "./sketch-model";

const colors = [
  ["White", "#f1f5f9"],
  ["Slate", "#94a3b8"],
  ["Red", "#ef4444"],
  ["Orange", "#f97316"],
  ["Amber", "#f59e0b"],
  ["Green", "#22c55e"],
  ["Teal", "#14b8a6"],
  ["Cyan", "#06b6d4"],
  ["Blue", "#3478f6"],
  ["Violet", "#8b5cf6"],
  ["Pink", "#ec4899"],
];

export function SketchColors({
  color,
  onStyle,
}: {
  color: string;
  onStyle: (patch: Partial<SketchStyle>) => void;
}) {
  const choose = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onStyle({ stroke: event.currentTarget.value });
    },
    [onStyle]
  );
  const custom = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      onStyle({ stroke: event.currentTarget.value });
    },
    [onStyle]
  );
  return (
    <div aria-label="Drawing colors" className={styles.swatches} role="toolbar">
      <label className={styles.customColor} title="Custom outline color">
        <span className={styles.accessibleDescription}>
          Custom outline color
        </span>
        <input
          aria-label="Custom outline color"
          onChange={custom}
          type="color"
          value={color}
        />
      </label>
      {colors.map(([name, value]) => (
        <button
          aria-label={`${name} outline`}
          aria-pressed={color === value}
          key={value}
          onClick={choose}
          style={{ "--swatch": value } as React.CSSProperties}
          title={name}
          type="button"
          value={value}
        />
      ))}
    </div>
  );
}
