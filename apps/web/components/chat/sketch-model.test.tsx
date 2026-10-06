import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SketchArt } from "./sketch-art";
import {
  boardPoint,
  createShape,
  DEFAULT_STYLE,
  drawShape,
  duplicateItem,
  EMPTY_SKETCH,
  MAX_STROKE_POINTS,
  moveItem,
  penStroke,
  resizeItem,
  sketchHistory,
  sketchTemplate,
  validateItems,
} from "./sketch-model";
import { sketchShortcut } from "./sketch-shortcuts";

describe("sketch canvas", () => {
  it("maps mouse/touch positions correctly at mobile size and zoom", () => {
    expect(
      boardPoint(
        { x: 320, y: 240 },
        { height: 400, left: 20, top: 40, width: 600 }
      )
    ).toEqual({ x: 600, y: 400 });
    expect(
      boardPoint(
        { x: -20, y: 2000 },
        { height: 200, left: 0, top: 0, width: 300 }
      )
    ).toEqual({ x: 0, y: 800 });
  });
  it("draws in either direction, snaps, and keeps objects inside the canvas", () => {
    const item = createShape("rectangle");
    expect(
      drawShape(item, { x: 250, y: 260 }, { x: 103, y: 105 }, true)
    ).toMatchObject({ height: 150, width: 150, x: 100, y: 110 });
    expect(
      drawShape(item, { x: 103, y: 105 }, { x: 250, y: 260 }, true)
    ).toEqual(drawShape(item, { x: 250, y: 260 }, { x: 103, y: 105 }, true));
    const edge = drawShape(
      item,
      { x: 1200, y: 800 },
      { x: 1200, y: 800 },
      true
    );
    expect(edge).toMatchObject({ height: 8, width: 8, x: 1192, y: 792 });
    expect(() => validateItems([edge])).not.toThrow();
  });
  it("preserves arrow direction for reversed drags", () => {
    const item = drawShape(
      createShape("arrow"),
      { x: 300, y: 200 },
      { x: 100, y: 400 },
      false
    );
    expect(item).toMatchObject({ backwards: true, rising: true });
    const html = renderToStaticMarkup(<SketchArt item={item} />);
    expect(html).toContain('x1="200"');
    expect(html).toContain('x2="0"');
    expect(html).toContain("marker-end=");
  });
  it("bounds movement and resize, and duplicates with a new identity", () => {
    const item = createShape("card", 100, 100);
    expect(moveItem(item, -500, 900, true)).toMatchObject({ x: 0, y: 620 });
    expect(resizeItem(item, 2000, -500, true)).toMatchObject({
      height: 8,
      width: 1100,
    });
    const duplicate = duplicateItem(item);
    expect(duplicate.id).not.toBe(item.id);
    expect(duplicate).toMatchObject({ label: item.label, x: 120, y: 120 });
  });
  it("undoes/redoes edits and discards redo when a new edit is made", () => {
    const item = createShape("text");
    const first = sketchHistory(EMPTY_SKETCH, {
      items: [item],
      type: "commit",
    });
    const changed = sketchHistory(first, {
      items: [{ ...item, label: "Diagram" }],
      type: "commit",
    });
    const undone = sketchHistory(changed, { type: "undo" });
    expect(undone.items[0]?.label).toBe("Your text");
    expect(sketchHistory(undone, { type: "redo" }).items[0]?.label).toBe(
      "Diagram"
    );
    expect(sketchHistory(undone, { items: [], type: "commit" }).future).toEqual(
      []
    );
    expect(sketchHistory(first, { items: [item], type: "commit" })).toBe(first);
  });
  it("caps undo memory and rejects over-budget objects and pen strokes", () => {
    let state = EMPTY_SKETCH;
    const item = createShape("text");
    for (let i = 0; i < 40; i += 1) {
      state = sketchHistory(state, {
        items: [{ ...item, label: String(i) }],
        type: "commit",
      });
    }
    expect(state.past).toHaveLength(30);
    expect(() =>
      validateItems(Array.from({ length: 101 }, () => createShape("rectangle")))
    ).toThrow("100 objects");
    const stroke = penStroke(
      Array.from({ length: MAX_STROKE_POINTS + 1 }, () => ({ x: 1, y: 1 })),
      DEFAULT_STYLE,
      "stroke"
    );
    expect(() => validateItems([stroke])).toThrow("bounded points");
    const full = penStroke(
      Array.from({ length: MAX_STROKE_POINTS }, () => ({ x: 1, y: 1 })),
      DEFAULT_STYLE,
      "stroke"
    );
    expect(() => validateItems(Array.from({ length: 5 }, () => full))).toThrow(
      "many pen strokes"
    );
  });
  it("keeps a single pen tap visible and renders labels as escaped text", () => {
    const tap = penStroke([{ x: 1200, y: 800 }], DEFAULT_STYLE, "tap");
    expect(() => validateItems([tap])).not.toThrow();
    expect(renderToStaticMarkup(<SketchArt item={tap} />)).toContain("<circle");
    const text = {
      ...createShape("text"),
      label: '<script>alert("test")</script>',
    };
    const html = renderToStaticMarkup(<SketchArt item={text} />);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(() => validateItems([{ ...text, width: Number.NaN }])).toThrow(
      "valid numbers"
    );
    expect(() => validateItems([{ ...text, label: "x".repeat(241) }])).toThrow(
      "240 characters"
    );
  });
  it.each(["landing", "dashboard", "mobile"] as const)(
    "provides real editable %s blocks within the canvas",
    (name) => {
      const items = sketchTemplate(name);
      expect(items.length).toBeGreaterThan(5);
      expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
      expect(() => validateItems(items)).not.toThrow();
    }
  );
  it("supports platform shortcuts without swallowing unrelated keys", () => {
    const event = { ctrlKey: true, key: "z", metaKey: false, shiftKey: false };
    expect(sketchShortcut(event)).toBe("undo");
    expect(sketchShortcut({ ...event, shiftKey: true })).toBe("redo");
    expect(
      sketchShortcut({ ...event, ctrlKey: false, key: "d", metaKey: true })
    ).toBe("duplicate");
    expect(sketchShortcut({ ...event, ctrlKey: false, key: "Delete" })).toBe(
      "remove"
    );
    expect(sketchShortcut({ ...event, key: "a" })).toBeUndefined();
  });
});
