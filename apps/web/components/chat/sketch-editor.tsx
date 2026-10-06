"use client";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@reasonateai/ui/components/dialog";
import type { LucideIcon } from "lucide-react";
import {
  ArrowUpRight,
  Check,
  Circle,
  Eraser,
  ImageIcon,
  Layers,
  LayoutDashboard,
  LayoutPanelTop,
  LoaderCircle,
  Minus,
  MousePointer2,
  PanelTop,
  Pencil,
  Plus,
  RectangleHorizontal,
  Redo2,
  SlidersHorizontal,
  Smartphone,
  Square,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useReducer, useRef, useState } from "react";
import styles from "./sketch.module.css";
import { SketchArt, sketchPng } from "./sketch-art";
import { SketchColors } from "./sketch-colors";
import { SketchInspector } from "./sketch-inspector";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  clamp,
  createShape,
  DEFAULT_STYLE,
  duplicateItem,
  EMPTY_SKETCH,
  moveItem,
  type ShapeKind,
  type SketchItem,
  type SketchStyle,
  sketchHistory,
  sketchTemplate,
  validateItems,
} from "./sketch-model";
import { sketchShortcut } from "./sketch-shortcuts";
import { type SketchTool, useSketchBoard } from "./use-sketch-board";

const tools: { id: SketchTool; label: string; icon: LucideIcon }[] = [
  { icon: MousePointer2, id: "select", label: "Select" },
  { icon: Pencil, id: "pen", label: "Pen" },
  { icon: Square, id: "rectangle", label: "Rectangle" },
  { icon: Circle, id: "ellipse", label: "Ellipse" },
  { icon: Minus, id: "line", label: "Line" },
  { icon: ArrowUpRight, id: "arrow", label: "Arrow" },
  { icon: Type, id: "text", label: "Text" },
  { icon: Eraser, id: "erase", label: "Eraser" },
];
const blocks: { id: ShapeKind; label: string; icon: LucideIcon }[] = [
  { icon: PanelTop, id: "navbar", label: "Navigation" },
  { icon: LayoutPanelTop, id: "card", label: "Card" },
  { icon: RectangleHorizontal, id: "button", label: "Button" },
  { icon: RectangleHorizontal, id: "input", label: "Input" },
  { icon: ImageIcon, id: "image", label: "Image" },
  { icon: Type, id: "text", label: "Text" },
];
function SketchTools({
  tool,
  onTool,
}: {
  tool: SketchTool;
  onTool: (tool: SketchTool) => void;
}) {
  const choose = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const chosen = tools.find(
        (item) => item.id === event.currentTarget.value
      );
      if (chosen) {
        onTool(chosen.id);
      }
    },
    [onTool]
  );
  return (
    <div aria-label="Drawing tools" className={styles.tools} role="toolbar">
      {tools.map(({ id, label, icon: Icon }) => (
        <button
          aria-label={label}
          aria-pressed={tool === id}
          key={id}
          onClick={choose}
          title={label}
          type="button"
          value={id}
        >
          <Icon size={19} />
        </button>
      ))}
    </div>
  );
}
function BlockPalette({
  add,
  template,
  items,
  selectedId,
  select,
}: {
  add: (kind: ShapeKind) => void;
  template: (name: "landing" | "dashboard" | "mobile") => void;
  items: SketchItem[];
  selectedId: string | null;
  select: (id: string) => void;
}) {
  const addBlock = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const block = blocks.find(
        (item) => item.id === event.currentTarget.value
      );
      if (block) {
        add(block.id);
      }
    },
    [add]
  );
  const landing = useCallback(() => template("landing"), [template]);
  const dashboard = useCallback(() => template("dashboard"), [template]);
  const mobile = useCallback(() => template("mobile"), [template]);
  const selectLayer = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) =>
      select(event.currentTarget.value),
    [select]
  );
  return (
    <aside className={styles.palette}>
      <h3>UI blocks</h3>
      <p>Click to add, then drag into place.</p>
      <div className={styles.blockGrid}>
        {blocks.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={addBlock} type="button" value={id}>
            <Icon size={20} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <h3>Starter layouts</h3>
      <p>Add an editable layout.</p>
      <div className={styles.templates}>
        <button onClick={landing} type="button">
          <LayoutPanelTop size={17} />
          Landing page
        </button>
        <button onClick={dashboard} type="button">
          <LayoutDashboard size={17} />
          Dashboard
        </button>
        <button onClick={mobile} type="button">
          <Smartphone size={17} />
          Mobile screen
        </button>
      </div>
      <h3>
        Layers <span>{items.length}/100</span>
      </h3>
      <section aria-label="Sketch layers" className={styles.layers}>
        {items.length === 0 && <p>Your blocks appear here.</p>}
        {[...items].reverse().map((item) => (
          <button
            aria-pressed={selectedId === item.id}
            key={item.id}
            onClick={selectLayer}
            type="button"
            value={item.id}
          >
            {item.label || item.kind}
          </button>
        ))}
      </section>
    </aside>
  );
}

function updateGeometry(
  item: SketchItem,
  patch: Partial<Pick<SketchItem, "x" | "y" | "width" | "height" | "label">>
): SketchItem {
  const result = { ...item, ...patch };
  for (const field of ["x", "y", "width", "height"] as const) {
    if (!Number.isFinite(result[field])) {
      result[field] = item[field];
    }
  }
  result.width = clamp(result.width, 8, BOARD_WIDTH);
  result.height = clamp(result.height, 8, BOARD_HEIGHT);
  result.x = clamp(result.x, 0, BOARD_WIDTH - result.width);
  result.y = clamp(result.y, 0, BOARD_HEIGHT - result.height);
  result.label = result.label.slice(0, 240);
  return result;
}

export function SketchEditor({
  open,
  onOpenChange,
  onAttach,
  onReturnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAttach: (file: File) => Promise<void>;
  onReturnFocus: () => void;
}) {
  const [history, dispatch] = useReducer(sketchHistory, EMPTY_SKETCH);
  const [tool, setTool] = useState<SketchTool>("pen");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [style, setStyle] = useState(DEFAULT_STYLE);
  const [snapping, setSnapping] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [panel, setPanel] = useState<"blocks" | "properties" | null>(null);
  const [zoom, setZoom] = useState(100);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const exportInFlight = useRef<boolean>(false);
  const selected = history.items.find((item) => item.id === selectedId);
  const commit = useCallback((items: SketchItem[]) => {
    try {
      validateItems(items);
      dispatch({ items, type: "commit" });
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update the sketch."
      );
    }
  }, []);
  const board = useSketchBoard({
    commit,
    items: history.items,
    onError: setError,
    select: setSelectedId,
    snapping,
    style,
    tool,
  });
  const changeOpen = useCallback(
    (value: boolean) => {
      if (!exporting) {
        board.cancel();
        setError("");
        onOpenChange(value);
      }
    },
    [board.cancel, exporting, onOpenChange]
  );
  const undo = useCallback(() => {
    board.cancel();
    dispatch({ type: "undo" });
  }, [board.cancel]);
  const redo = useCallback(() => {
    board.cancel();
    dispatch({ type: "redo" });
  }, [board.cancel]);
  const changeTool = useCallback(
    (value: SketchTool) => {
      board.cancel();
      setTool(value);
    },
    [board.cancel]
  );
  const add = useCallback(
    (kind: ShapeKind) => {
      const item = createShape(
        kind,
        120 + (history.items.length % 10) * 30,
        100 + (history.items.length % 10) * 30,
        style
      );
      commit([...history.items, item]);
      setSelectedId(item.id);
      setTool("select");
    },
    [commit, history.items, style]
  );
  const template = useCallback(
    (name: "landing" | "dashboard" | "mobile") => {
      commit([...history.items, ...sketchTemplate(name)]);
      setTool("select");
      setSelectedId(null);
    },
    [commit, history.items]
  );
  const patch = useCallback(
    (
      change: Partial<
        Pick<SketchItem, "x" | "y" | "width" | "height" | "label">
      >
    ) => {
      commit(
        history.items.map((item) =>
          item.id === selectedId ? updateGeometry(item, change) : item
        )
      );
    },
    [commit, history.items, selectedId]
  );
  const changeStyle = useCallback(
    (change: Partial<SketchStyle>) => {
      setStyle((current) => ({ ...current, ...change }));
      if (selectedId) {
        commit(
          history.items.map((item) =>
            item.id === selectedId ? { ...item, ...change } : item
          )
        );
      }
    },
    [commit, history.items, selectedId]
  );
  const remove = useCallback(() => {
    commit(history.items.filter((item) => item.id !== selectedId));
    setSelectedId(null);
  }, [commit, history.items, selectedId]);
  const duplicate = useCallback(() => {
    if (selected) {
      const item = duplicateItem(selected);
      commit([...history.items, item]);
      setSelectedId(item.id);
    }
  }, [commit, history.items, selected]);
  const layer = useCallback(
    (front: boolean) => {
      if (selected) {
        const others = history.items.filter((item) => item.id !== selected.id);
        commit(front ? [...others, selected] : [selected, ...others]);
      }
    },
    [commit, history.items, selected]
  );
  const attach = useCallback(async () => {
    const svg = board.svg.current;
    if (!svg || exportInFlight.current || !history.items.length) {
      return;
    }
    exportInFlight.current = true;
    setExporting(true);
    setError("");
    try {
      const file = await sketchPng(svg);
      await onAttach(file);
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not attach this sketch. Try again."
      );
    } finally {
      exportInFlight.current = false;
      setExporting(false);
    }
  }, [board.svg, history.items.length, onAttach, onOpenChange]);
  const keyboard = useCallback(
    (event: React.KeyboardEvent) => {
      if (exporting || !(event.target instanceof Element)) {
        return;
      }
      if (event.target.closest("input, textarea, select")) {
        return;
      }
      const action = sketchShortcut(event);
      const commands = { duplicate, redo, remove, undo };
      if (action) {
        event.preventDefault();
        commands[action]();
        return;
      }
      const directions: Record<string, [number, number]> = {
        ArrowDown: [0, 1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
      };
      const delta = directions[event.key];
      if (!(selected && delta && event.target.closest("[data-sketch-board]"))) {
        return;
      }
      event.preventDefault();
      const [dx, dy] = delta;
      const step = event.shiftKey ? 10 : 1;
      commit(
        history.items.map((item) =>
          item.id === selected.id
            ? moveItem(item, dx * step, dy * step, false)
            : item
        )
      );
    },
    [commit, duplicate, exporting, history.items, redo, remove, selected, undo]
  );
  const closeFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      onReturnFocus();
    },
    [onReturnFocus]
  );
  const changeSnapping = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setSnapping(event.currentTarget.checked),
    []
  );
  const changeGrid = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setShowGrid(event.currentTarget.checked),
    []
  );
  const toggleBlocks = useCallback(
    () => setPanel((value) => (value === "blocks" ? null : "blocks")),
    []
  );
  const toggleProperties = useCallback(
    () => setPanel((value) => (value === "properties" ? null : "properties")),
    []
  );
  const zoomOut = useCallback(() => setZoom((value) => value - 25), []);
  const zoomIn = useCallback(() => setZoom((value) => value + 25), []);
  const selectedPreview = board.displayed.find(
    (item) => item.id === selectedId
  );

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      <DialogContent
        className={styles.editor}
        onCloseAutoFocus={closeFocus}
        onKeyDown={keyboard}
        showCloseButton={false}
      >
        <div className={styles.accessibleDescription}>
          <DialogTitle>Sketch canvas</DialogTitle>
          <DialogDescription>
            Draw an idea, diagram, or layout. Add shapes and labels, then attach
            it to your message.
          </DialogDescription>
        </div>
        <div className={styles.close}>
          <DialogClose asChild>
            <button
              aria-label="Close sketch"
              disabled={exporting}
              title="Close sketch"
              type="button"
            >
              <X size={20} />
            </button>
          </DialogClose>
        </div>
        <div className={styles.toolbar}>
          <SketchTools onTool={changeTool} tool={tool} />
        </div>
        <div aria-label="History" className={styles.history} role="toolbar">
          <button
            aria-label="Undo"
            disabled={!history.past.length}
            onClick={undo}
            title="Undo (Ctrl/⌘ Z)"
            type="button"
          >
            <Undo2 size={19} />
          </button>
          <button
            aria-label="Redo"
            disabled={!history.future.length}
            onClick={redo}
            title="Redo (Ctrl/⌘ Shift Z)"
            type="button"
          >
            <Redo2 size={19} />
          </button>
        </div>
        <div
          aria-label="Canvas options"
          className={styles.options}
          role="toolbar"
        >
          <button
            aria-controls="sketch-blocks"
            aria-expanded={panel === "blocks"}
            aria-label="Blocks and layers"
            onClick={toggleBlocks}
            title="Blocks, layouts and layers"
            type="button"
          >
            <Layers size={19} />
          </button>
          <button
            aria-controls="sketch-properties"
            aria-expanded={panel === "properties"}
            aria-label="Drawing properties"
            onClick={toggleProperties}
            title="Drawing properties"
            type="button"
          >
            <SlidersHorizontal size={19} />
          </button>
        </div>
        {panel === "blocks" && (
          <div className={styles.floatingPanel} id="sketch-blocks">
            <BlockPalette
              add={add}
              items={history.items}
              select={setSelectedId}
              selectedId={selectedId}
              template={template}
            />
          </div>
        )}
        <div className={styles.stage}>
          <div
            aria-label="Sketch canvas"
            className={styles.board}
            data-sketch-board
            data-tool={tool}
            onLostPointerCapture={board.cancel}
            onPointerCancel={board.cancel}
            onPointerDown={board.down}
            onPointerMove={board.move}
            onPointerUp={board.up}
            role="application"
            style={{ width: `min(${zoom}cqw, ${zoom * 1.5}cqh)` }}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the drawing application supports keyboard manipulation; layers also provide ordinary selectable buttons.
            tabIndex={0}
          >
            <svg
              aria-label="Sketch artboard"
              height={BOARD_HEIGHT}
              ref={board.svg}
              role="img"
              viewBox={`0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}`}
              width={BOARD_WIDTH}
              xmlns="http://www.w3.org/2000/svg"
            >
              <title>Sketch artboard</title>
              <rect fill="#212121" height={BOARD_HEIGHT} width={BOARD_WIDTH} />
              <g data-editor-only>
                <defs>
                  <pattern
                    height={20}
                    id="sketch-grid"
                    patternUnits="userSpaceOnUse"
                    width={20}
                  >
                    <circle cx={1} cy={1} fill="#444444" r={1} />
                  </pattern>
                </defs>
                {showGrid && (
                  <rect
                    fill="url(#sketch-grid)"
                    height={BOARD_HEIGHT}
                    width={BOARD_WIDTH}
                  />
                )}
              </g>
              {board.displayed.map((item) => (
                <SketchArt item={item} key={item.id} />
              ))}
              {selectedPreview && tool === "select" && (
                <g data-editor-only data-item-id={selectedPreview.id}>
                  <rect
                    fill="none"
                    height={selectedPreview.height + 8}
                    stroke="#3478f6"
                    strokeDasharray="5 3"
                    strokeWidth={2}
                    width={selectedPreview.width + 8}
                    x={selectedPreview.x - 4}
                    y={selectedPreview.y - 4}
                  />
                  <rect
                    aria-label="Resize selected object"
                    data-resize
                    fill="#3478f6"
                    height={14}
                    width={14}
                    x={selectedPreview.x + selectedPreview.width - 7}
                    y={selectedPreview.y + selectedPreview.height - 7}
                  />
                </g>
              )}
            </svg>
          </div>
        </div>
        {panel === "properties" && (
          <div className={styles.floatingPanel} id="sketch-properties">
            <SketchInspector
              onDelete={remove}
              onDuplicate={duplicate}
              onLayer={layer}
              onPatch={patch}
              onStyle={changeStyle}
              selected={selected}
              style={style}
            />
            <div className={styles.gridOptions}>
              <label>
                <input
                  checked={snapping}
                  onChange={changeSnapping}
                  type="checkbox"
                />
                Snap to grid
              </label>
              <label>
                <input
                  checked={showGrid}
                  onChange={changeGrid}
                  type="checkbox"
                />
                Show grid
              </label>
            </div>
          </div>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.zoom}>
          <button
            aria-label="Zoom out"
            disabled={zoom <= 50}
            onClick={zoomOut}
            type="button"
          >
            <Minus size={16} />
          </button>
          <span>{zoom}%</span>
          <button
            aria-label="Zoom in"
            disabled={zoom >= 200}
            onClick={zoomIn}
            type="button"
          >
            <Plus size={16} />
          </button>
        </div>
        <SketchColors
          color={selected?.stroke ?? style.stroke}
          onStyle={changeStyle}
        />
        <span className={styles.accessibleDescription}>
          Draft kept in this chat until you switch chats or reload.
        </span>
        <button
          aria-label={exporting ? "Attaching sketch" : "Attach sketch"}
          className={styles.attach}
          disabled={exporting || history.items.length === 0}
          onClick={attach}
          title="Attach sketch"
          type="button"
        >
          {exporting ? (
            <LoaderCircle className={styles.spinning} size={21} />
          ) : (
            <Check size={23} />
          )}
        </button>
      </DialogContent>
    </Dialog>
  );
}
