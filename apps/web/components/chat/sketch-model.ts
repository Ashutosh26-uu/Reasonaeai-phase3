export const BOARD_WIDTH = 1200;
export const BOARD_HEIGHT = 800;
export const MAX_SKETCH_ITEMS = 100;
export const MAX_STROKE_POINTS = 1500;
const MAX_TOTAL_POINTS = 6000;
const HISTORY_LIMIT = 30;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
export interface Point {
  x: number;
  y: number;
}
export type ShapeKind =
  | "rectangle"
  | "ellipse"
  | "line"
  | "arrow"
  | "text"
  | "button"
  | "input"
  | "image"
  | "card"
  | "navbar";
export interface SketchStyle {
  fill: string;
  fontSize: number;
  stroke: string;
  strokeWidth: number;
}
interface ShapeBase extends SketchStyle {
  height: number;
  id: string;
  label: string;
  width: number;
  x: number;
  y: number;
}
export type SketchItem = ShapeBase &
  (
    | { kind: Exclude<ShapeKind, "line" | "arrow"> }
    | { kind: "line" | "arrow"; rising: boolean; backwards: boolean }
    | { kind: "pen"; points: Point[] }
  );
export const DEFAULT_STYLE: SketchStyle = {
  fill: "none",
  fontSize: 20,
  stroke: "#f1f5f9",
  strokeWidth: 2,
};
export interface SketchHistory {
  future: SketchItem[][];
  items: SketchItem[];
  past: SketchItem[][];
}
export const EMPTY_SKETCH: SketchHistory = {
  future: [],
  items: [],
  past: [],
};
export type SketchAction =
  | { type: "commit"; items: SketchItem[] }
  | { type: "undo" }
  | { type: "redo" };
export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));
export const snap = (value: number, enabled: boolean): number =>
  enabled ? Math.round(value / 10) * 10 : value;
export function boardPoint(
  client: Point,
  rect: { left: number; top: number; width: number; height: number }
): Point {
  return {
    x: clamp(
      ((client.x - rect.left) * BOARD_WIDTH) / rect.width,
      0,
      BOARD_WIDTH
    ),
    y: clamp(
      ((client.y - rect.top) * BOARD_HEIGHT) / rect.height,
      0,
      BOARD_HEIGHT
    ),
  };
}
export function sketchHistory(
  state: SketchHistory,
  action: SketchAction
): SketchHistory {
  if (action.type === "undo") {
    const items = state.past.at(-1);
    return items
      ? {
          future: [state.items, ...state.future].slice(0, HISTORY_LIMIT),
          items,
          past: state.past.slice(0, -1),
        }
      : state;
  }
  if (action.type === "redo") {
    const [items] = state.future;
    return items
      ? {
          future: state.future.slice(1),
          items,
          past: [...state.past, state.items].slice(-HISTORY_LIMIT),
        }
      : state;
  }
  validateItems(action.items);
  if (JSON.stringify(state.items) === JSON.stringify(action.items)) {
    return state;
  }
  return {
    future: [],
    items: action.items,
    past: [...state.past, state.items].slice(-HISTORY_LIMIT),
  };
}
export function validateItems(items: SketchItem[]): void {
  if (items.length > MAX_SKETCH_ITEMS) {
    throw new Error(
      "Use up to 100 objects per sketch. Remove an object to add another."
    );
  }
  let points = 0;
  for (const item of items) {
    validateStyle(item);
    if (
      ![
        item.x,
        item.y,
        item.width,
        item.height,
        item.strokeWidth,
        item.fontSize,
      ].every(Number.isFinite)
    ) {
      throw new Error("Block dimensions must be valid numbers.");
    }
    if (
      item.width < 8 ||
      item.height < 8 ||
      item.x < 0 ||
      item.y < 0 ||
      item.x + item.width > BOARD_WIDTH ||
      item.y + item.height > BOARD_HEIGHT
    ) {
      throw new Error("Keep blocks within the canvas.");
    }
    if (item.kind === "pen") {
      if (
        item.points.length === 0 ||
        item.points.length > MAX_STROKE_POINTS ||
        item.points.some(
          (point) => !(Number.isFinite(point.x) && Number.isFinite(point.y))
        )
      ) {
        throw new Error("Pen strokes must contain valid, bounded points.");
      }
      points += item.points.length;
    }
  }
  if (points > MAX_TOTAL_POINTS) {
    throw new Error(
      "This sketch has many pen strokes. Remove a stroke or use shapes for the remaining detail."
    );
  }
}
function validateStyle(item: SketchItem): void {
  if (item.label.length > 240) {
    throw new Error("Keep each label within 240 characters.");
  }
  if (
    !HEX_COLOR.test(item.stroke) ||
    (item.fill !== "none" && !HEX_COLOR.test(item.fill))
  ) {
    throw new Error("Choose a valid outline and fill color.");
  }
  if (
    item.strokeWidth < 1 ||
    item.strokeWidth > 6 ||
    item.fontSize < 12 ||
    item.fontSize > 64
  ) {
    throw new Error(
      "Choose a line weight and text size within the supported range."
    );
  }
}
export function createShape(
  kind: ShapeKind,
  x = 100,
  y = 100,
  style: SketchStyle = DEFAULT_STYLE
): SketchItem {
  const defaults: Record<
    ShapeKind,
    { width: number; height: number; label: string }
  > = {
    arrow: { height: 8, label: "", width: 220 },
    button: { height: 48, label: "Button", width: 160 },
    card: { height: 180, label: "Card title", width: 260 },
    ellipse: { height: 100, label: "", width: 100 },
    image: { height: 160, label: "Image", width: 240 },
    input: { height: 48, label: "Input placeholder", width: 280 },
    line: { height: 8, label: "", width: 220 },
    navbar: {
      height: 64,
      label: "Logo                 Home    About    Contact",
      width: 640,
    },
    rectangle: { height: 120, label: "", width: 220 },
    text: { height: 60, label: "Your text", width: 280 },
  };
  const props = defaults[kind];
  const base = {
    ...style,
    ...props,
    id: crypto.randomUUID(),
    x: clamp(x, 0, BOARD_WIDTH - props.width),
    y: clamp(y, 0, BOARD_HEIGHT - props.height),
  };
  if (kind === "line" || kind === "arrow") {
    return { ...base, backwards: false, kind, rising: false };
  }
  return { ...base, kind };
}
export function drawShape(
  item: SketchItem,
  start: Point,
  end: Point,
  snapping: boolean
): SketchItem {
  const startX = snap(start.x, snapping);
  const startY = snap(start.y, snapping);
  const endX = snap(end.x, snapping);
  const endY = snap(end.y, snapping);
  const x = clamp(Math.min(startX, endX), 0, BOARD_WIDTH - 8);
  const y = clamp(Math.min(startY, endY), 0, BOARD_HEIGHT - 8);
  return {
    ...item,
    height: clamp(Math.abs(endY - startY), 8, BOARD_HEIGHT - y),
    width: clamp(Math.abs(endX - startX), 8, BOARD_WIDTH - x),
    x,
    y,
    ...(item.kind === "line" || item.kind === "arrow"
      ? {
          backwards: end.x < start.x,
          rising: (end.x - start.x) * (end.y - start.y) < 0,
        }
      : {}),
  };
}
export function moveItem(
  item: SketchItem,
  dx: number,
  dy: number,
  snapping: boolean
): SketchItem {
  return {
    ...item,
    x: clamp(snap(item.x + dx, snapping), 0, BOARD_WIDTH - item.width),
    y: clamp(snap(item.y + dy, snapping), 0, BOARD_HEIGHT - item.height),
  };
}
export function resizeItem(
  item: SketchItem,
  width: number,
  height: number,
  snapping: boolean
): SketchItem {
  return {
    ...item,
    height: clamp(snap(height, snapping), 8, BOARD_HEIGHT - item.y),
    width: clamp(snap(width, snapping), 8, BOARD_WIDTH - item.x),
  };
}
export function penStroke(
  points: Point[],
  style: SketchStyle,
  id: string
): SketchItem {
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const width = Math.max(8, Math.max(...points.map((point) => point.x)) - left);
  const height = Math.max(8, Math.max(...points.map((point) => point.y)) - top);
  const x = Math.min(left, BOARD_WIDTH - width);
  const y = Math.min(top, BOARD_HEIGHT - height);
  return {
    ...style,
    height,
    id,
    kind: "pen",
    label: "Pen stroke",
    points: points.map((point) => ({ x: point.x - x, y: point.y - y })),
    width,
    x,
    y,
  };
}
export function duplicateItem(item: SketchItem): SketchItem {
  return { ...moveItem(item, 20, 20, false), id: crypto.randomUUID() };
}
export function sketchTemplate(
  name: "landing" | "dashboard" | "mobile"
): SketchItem[] {
  const make = (
    kind: ShapeKind,
    x: number,
    y: number,
    width: number,
    height: number,
    label: string
  ) => ({ ...createShape(kind, x, y), height, label, width });
  if (name === "mobile") {
    return [
      make("rectangle", 400, 30, 400, 740, ""),
      make("navbar", 420, 50, 360, 60, "Your app                     ☰"),
      make("text", 440, 140, 320, 60, "Welcome back"),
      make("image", 440, 230, 320, 200, "Hero image"),
      make("input", 440, 470, 320, 48, "Email address"),
      make("button", 440, 550, 320, 48, "Get started"),
      make("text", 440, 660, 320, 48, "Home     Search     Profile"),
    ];
  }
  if (name === "dashboard") {
    return [
      make("navbar", 30, 30, 1140, 64, "Your workspace"),
      make("rectangle", 30, 120, 200, 650, ""),
      make(
        "text",
        50,
        150,
        160,
        160,
        "Overview\nProjects\nAnalytics\nSettings"
      ),
      make("text", 270, 120, 860, 60, "Dashboard overview"),
      ...["Revenue", "Customers", "Activity"].map((label, index) =>
        make("card", 270 + index * 300, 220, 270, 160, label)
      ),
      make("image", 270, 420, 570, 310, "Chart"),
      make("card", 870, 420, 270, 310, "Recent activity"),
    ];
  }
  return [
    make(
      "navbar",
      40,
      30,
      1120,
      64,
      "Logo                          Product    About    Contact"
    ),
    make("text", 80, 160, 500, 100, "Your big idea starts here"),
    make(
      "text",
      80,
      280,
      480,
      80,
      "Describe the value of your product.\nKeep the message clear and simple."
    ),
    make("button", 80, 400, 200, 48, "Get started"),
    make("image", 660, 160, 440, 300, "Product preview"),
    ...["Feature one", "Feature two", "Feature three"].map((label, index) =>
      make("card", 80 + index * 360, 560, 320, 170, label)
    ),
  ];
}
