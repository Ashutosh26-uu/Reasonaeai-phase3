import { ArrowDownToLine, ArrowUpToLine, Copy, Trash2 } from "lucide-react";
import { useCallback } from "react";
import styles from "./sketch.module.css";
import type { SketchItem, SketchStyle } from "./sketch-model";

export function SketchInspector({
  selected,
  style,
  onPatch,
  onStyle,
  onDuplicate,
  onDelete,
  onLayer,
}: {
  selected: SketchItem | undefined;
  style: SketchStyle;
  onPatch: (
    patch: Partial<Pick<SketchItem, "x" | "y" | "width" | "height" | "label">>
  ) => void;
  onStyle: (patch: Partial<SketchStyle>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onLayer: (front: boolean) => void;
}) {
  const appearance = selected ?? style;
  const label = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) =>
      onPatch({ label: event.currentTarget.value }),
    [onPatch]
  );
  const dimension = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const { name, valueAsNumber } = event.currentTarget;
      if (
        name === "x" ||
        name === "y" ||
        name === "width" ||
        name === "height"
      ) {
        onPatch({ [name]: valueAsNumber });
      }
    },
    [onPatch]
  );
  const color = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const { name, value } = event.currentTarget;
      if (name === "stroke" || name === "fill") {
        onStyle({ [name]: value });
      }
    },
    [onStyle]
  );
  const transparent = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      onStyle({ fill: event.currentTarget.checked ? "none" : "#ffffff" }),
    [onStyle]
  );
  const size = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const { name, value } = event.currentTarget;
      if (name === "strokeWidth" || name === "fontSize") {
        onStyle({ [name]: Number(value) });
      }
    },
    [onStyle]
  );
  const front = useCallback(() => onLayer(true), [onLayer]);
  const back = useCallback(() => onLayer(false), [onLayer]);
  return (
    <section aria-label="Object properties" className={styles.inspector}>
      <h3>{selected ? "Selected object" : "Drawing style"}</h3>
      {selected && (
        <>
          <label>
            Label
            <textarea
              aria-label="Object label"
              maxLength={240}
              onChange={label}
              rows={3}
              value={selected.label}
            />
          </label>
          <div className={styles.dimensions}>
            {(["x", "y", "width", "height"] as const).map((field) => (
              <label key={field}>
                {field}
                <input
                  aria-label={`Object ${field}`}
                  max={field === "x" || field === "width" ? 1200 : 800}
                  min={field === "width" || field === "height" ? 8 : 0}
                  name={field}
                  onChange={dimension}
                  type="number"
                  value={Math.round(selected[field])}
                />
              </label>
            ))}
          </div>
        </>
      )}
      <div className={styles.colors}>
        <label>
          Outline
          <input
            aria-label="Outline color"
            name="stroke"
            onChange={color}
            type="color"
            value={appearance.stroke}
          />
        </label>
        <label>
          Fill
          <input
            aria-label="Fill color"
            name="fill"
            onChange={color}
            type="color"
            value={appearance.fill === "none" ? "#ffffff" : appearance.fill}
          />
        </label>
      </div>
      <label className={styles.check}>
        <input
          checked={appearance.fill === "none"}
          onChange={transparent}
          type="checkbox"
        />
        Transparent fill
      </label>
      <label>
        Line weight
        <select
          aria-label="Line weight"
          name="strokeWidth"
          onChange={size}
          value={appearance.strokeWidth}
        >
          <option value={1}>Thin</option>
          <option value={2}>Regular</option>
          <option value={4}>Bold</option>
          <option value={6}>Heavy</option>
        </select>
      </label>
      <label>
        Text size
        <select
          aria-label="Text size"
          name="fontSize"
          onChange={size}
          value={appearance.fontSize}
        >
          <option value={16}>Small</option>
          <option value={20}>Regular</option>
          <option value={28}>Heading</option>
          <option value={36}>Title</option>
        </select>
      </label>
      {selected && (
        <div className={styles.selectionActions}>
          <button
            onClick={onDuplicate}
            title="Duplicate (Ctrl/⌘ D)"
            type="button"
          >
            <Copy size={16} />
            Duplicate
          </button>
          <button onClick={onDelete} type="button">
            <Trash2 size={16} />
            Delete
          </button>
          <button onClick={front} type="button">
            <ArrowUpToLine size={16} />
            To front
          </button>
          <button onClick={back} type="button">
            <ArrowDownToLine size={16} />
            To back
          </button>
        </div>
      )}
      {!selected && (
        <p>
          Select an object to edit its label, size, or position. Use arrow keys
          to nudge; Shift moves ten pixels.
        </p>
      )}
    </section>
  );
}
