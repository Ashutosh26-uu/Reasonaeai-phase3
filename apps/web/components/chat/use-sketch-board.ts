import { useCallback, useRef, useState } from "react";
import {
  boardPoint,
  createShape,
  drawShape,
  MAX_STROKE_POINTS,
  moveItem,
  type Point,
  penStroke,
  resizeItem,
  type ShapeKind,
  type SketchItem,
  type SketchStyle,
} from "./sketch-model";

export type SketchTool =
  | "select"
  | "erase"
  | "pen"
  | "rectangle"
  | "ellipse"
  | "line"
  | "arrow"
  | "text";
interface GestureBase {
  original: SketchItem[];
  pointerId: number;
  preview: SketchItem[];
  start: Point;
}
type Gesture = GestureBase &
  (
    | { kind: "move" | "resize" | "draw"; item: SketchItem }
    | { kind: "pen"; points: Point[]; id: string; style: SketchStyle }
  );
function shapeTool(tool: SketchTool): tool is Extract<ShapeKind, SketchTool> {
  return ["rectangle", "ellipse", "line", "arrow", "text"].includes(tool);
}

function beginGesture(
  base: GestureBase,
  tool: SketchTool,
  style: SketchStyle,
  item: SketchItem | undefined,
  resizing: boolean
): Gesture | null {
  if (tool === "select" && item) {
    return { ...base, item, kind: resizing ? "resize" : "move" };
  }
  if (tool === "pen") {
    return {
      ...base,
      id: crypto.randomUUID(),
      kind: "pen",
      points: [base.start],
      style,
    };
  }
  if (shapeTool(tool)) {
    return {
      ...base,
      item: createShape(tool, base.start.x, base.start.y, style),
      kind: "draw",
    };
  }
  return null;
}

export function useSketchBoard({
  items,
  tool,
  style,
  snapping,
  commit,
  select,
  onError,
}: {
  items: SketchItem[];
  tool: SketchTool;
  style: SketchStyle;
  snapping: boolean;
  commit: (items: SketchItem[]) => void;
  select: (id: string | null) => void;
  onError: (message: string) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [preview, setPreview] = useState<SketchItem[] | null>(null);
  const point = useCallback((event: React.PointerEvent): Point | null => {
    const bounds = svg.current?.getBoundingClientRect();
    return bounds
      ? boardPoint({ x: event.clientX, y: event.clientY }, bounds)
      : null;
  }, []);
  const cancel = useCallback(() => {
    gesture.current = null;
    setPreview(null);
  }, []);
  const down = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || gesture.current) {
        return;
      }
      const start = point(event);
      if (!start) {
        return;
      }
      event.preventDefault();
      event.currentTarget.focus();
      const target = event.target instanceof Element ? event.target : null;
      const id = target
        ?.closest("[data-item-id]")
        ?.getAttribute("data-item-id");
      const item = items.find((entry) => entry.id === id);
      if (tool === "erase") {
        if (item) {
          commit(items.filter((entry) => entry.id !== item.id));
          select(null);
        }
        return;
      }
      const base = {
        original: items,
        pointerId: event.pointerId,
        preview: items,
        start,
      };
      gesture.current = beginGesture(
        base,
        tool,
        style,
        item,
        Boolean(target?.hasAttribute("data-resize"))
      );
      const active = gesture.current;
      select(active?.kind === "pen" ? active.id : (active?.item.id ?? null));
      if (gesture.current) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    },
    [commit, items, point, select, style, tool]
  );
  const move = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const active = gesture.current;
      const end = point(event);
      if (!active || active.pointerId !== event.pointerId || !end) {
        return;
      }
      let updated: SketchItem;
      if (active.kind === "pen") {
        const last = active.points.at(-1);
        if (last && Math.hypot(end.x - last.x, end.y - last.y) < 2) {
          return;
        }
        if (active.points.length >= MAX_STROKE_POINTS) {
          onError(
            "This stroke is full. Release the pen and start another stroke."
          );
          return;
        }
        active.points.push(end);
        updated = penStroke(active.points, active.style, active.id);
      } else if (active.kind === "draw") {
        updated = drawShape(active.item, active.start, end, snapping);
      } else if (active.kind === "resize") {
        updated = resizeItem(
          active.item,
          active.item.width + end.x - active.start.x,
          active.item.height + end.y - active.start.y,
          snapping
        );
      } else {
        updated = moveItem(
          active.item,
          end.x - active.start.x,
          end.y - active.start.y,
          snapping
        );
      }
      active.preview =
        active.kind === "draw" || active.kind === "pen"
          ? [...active.original, updated]
          : active.original.map((entry) =>
              entry.id === updated.id ? updated : entry
            );
      setPreview(active.preview);
    },
    [onError, point, snapping]
  );
  const up = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const active = gesture.current;
      if (!active || active.pointerId !== event.pointerId) {
        return;
      }
      if (active.preview === active.original && active.kind === "draw") {
        active.preview = [...active.original, active.item];
      }
      if (active.preview === active.original && active.kind === "pen") {
        active.preview = [
          ...active.original,
          penStroke(active.points, active.style, active.id),
        ];
      }
      commit(active.preview);
      cancel();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [cancel, commit]
  );
  return { cancel, displayed: preview ?? items, down, move, svg, up };
}
