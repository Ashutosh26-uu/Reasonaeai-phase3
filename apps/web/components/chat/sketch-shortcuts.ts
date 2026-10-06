export type SketchShortcut = "undo" | "redo" | "duplicate" | "remove";
export function sketchShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): SketchShortcut | undefined {
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === "z") {
      return event.shiftKey ? "redo" : "undo";
    }
    const shortcuts: Record<string, SketchShortcut> = {
      d: "duplicate",
      y: "redo",
    };
    return shortcuts[event.key.toLowerCase()];
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    return "remove";
  }
  return undefined;
}
