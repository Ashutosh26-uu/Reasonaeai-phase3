import { BOARD_HEIGHT, BOARD_WIDTH, type SketchItem } from "./sketch-model";

function labelLines(label: string, width: number, fontSize: number): string[] {
  const capacity = Math.max(1, Math.floor((width - 24) / (fontSize * 0.6)));
  return label.split("\n").flatMap((line) => {
    const lines: string[] = [];
    let current = "";
    for (const word of line.split(" ")) {
      if (current && current.length + word.length + 1 > capacity) {
        lines.push(current);
        current = word;
      } else {
        current += `${current ? " " : ""}${word}`;
      }
    }
    lines.push(current);
    return lines;
  });
}
function ItemLabel({
  item,
  centered = false,
}: {
  item: SketchItem;
  centered?: boolean;
}) {
  return (
    <text
      fill={item.stroke}
      fontFamily="Arial, sans-serif"
      fontSize={item.fontSize}
      stroke="none"
      textAnchor={centered ? "middle" : "start"}
    >
      {labelLines(item.label, item.width, item.fontSize).map((line, index) => (
        <tspan
          key={`${index}:${line}`}
          x={centered ? item.width / 2 : 12}
          y={
            centered
              ? item.height / 2 +
                item.fontSize / 3 +
                index * item.fontSize * 1.4
              : 12 + item.fontSize + index * item.fontSize * 1.4
          }
        >
          {line}
        </tspan>
      ))}
    </text>
  );
}
function ItemLine({
  item,
}: {
  item: Extract<SketchItem, { kind: "line" | "arrow" }>;
}) {
  return (
    <>
      {item.kind === "arrow" && (
        <defs>
          <marker
            id={`arrow-${item.id}`}
            markerHeight={8}
            markerWidth={8}
            orient="auto"
            refX={7}
            refY={4}
          >
            <path d="M 0 0 L 8 4 L 0 8 Z" fill={item.stroke} stroke="none" />
          </marker>
        </defs>
      )}
      <line
        markerEnd={item.kind === "arrow" ? `url(#arrow-${item.id})` : undefined}
        x1={item.backwards ? item.width : 0}
        x2={item.backwards ? 0 : item.width}
        y1={item.rising === item.backwards ? 0 : item.height}
        y2={item.rising === item.backwards ? item.height : 0}
      />
    </>
  );
}
function ItemBody({ item }: { item: SketchItem }) {
  switch (item.kind) {
    case "pen": {
      if (item.points.length === 1) {
        return (
          <circle
            cx={item.points[0]?.x ?? 0}
            cy={item.points[0]?.y ?? 0}
            fill={item.stroke}
            r={item.strokeWidth / 2}
          />
        );
      }
      const width = Math.max(8, ...item.points.map((point) => point.x));
      const height = Math.max(8, ...item.points.map((point) => point.y));
      return (
        <path
          d={item.points
            .map(
              (point, index) =>
                `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`
            )
            .join(" ")}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          transform={`scale(${item.width / width} ${item.height / height})`}
          vectorEffect="non-scaling-stroke"
        />
      );
    }
    case "line":
    case "arrow":
      return <ItemLine item={item} />;
    case "ellipse":
      return (
        <>
          <ellipse
            cx={item.width / 2}
            cy={item.height / 2}
            rx={item.width / 2}
            ry={item.height / 2}
          />
          <ItemLabel centered item={item} />
        </>
      );
    case "text":
      return <ItemLabel item={item} />;
    case "image":
      return (
        <>
          <rect height={item.height} rx={4} width={item.width} />
          <path
            d={`M 0 0 L ${item.width} ${item.height} M ${item.width} 0 L 0 ${item.height}`}
            opacity={0.2}
          />
          <rect
            fill={item.fill}
            height={30}
            stroke="none"
            width={item.width - 12}
            x={6}
            y={item.height / 2 - 15}
          />
          <ItemLabel centered item={item} />
        </>
      );
    case "card":
      return (
        <>
          <rect height={item.height} rx={10} width={item.width} />
          <ItemLabel item={item} />
          {item.height > 90 && (
            <g opacity={0.25}>
              <line x1={12} x2={item.width - 12} y1={65} y2={65} />
              <line x1={12} x2={item.width * 0.65} y1={85} y2={85} />
            </g>
          )}
        </>
      );
    case "button":
      return (
        <>
          <rect
            fill={item.fill === "#ffffff" ? "#e7efff" : item.fill}
            height={item.height}
            rx={8}
            width={item.width}
          />
          <ItemLabel centered item={item} />
        </>
      );
    default:
      return (
        <>
          <rect
            height={item.height}
            rx={item.kind === "rectangle" ? 0 : 6}
            width={item.width}
          />
          <ItemLabel item={item} />
        </>
      );
  }
}
export function SketchArt({ item }: { item: SketchItem }) {
  return (
    <g
      data-item-id={item.id}
      fill={item.fill}
      stroke={item.stroke}
      strokeWidth={item.strokeWidth}
      transform={`translate(${item.x} ${item.y})`}
    >
      <defs>
        <clipPath id={`clip-${item.id}`}>
          <rect height={item.height + 4} width={item.width + 4} x={-2} y={-2} />
        </clipPath>
      </defs>
      <g clipPath={`url(#clip-${item.id})`}>
        <ItemBody item={item} />
      </g>
      <rect
        fill="transparent"
        height={item.height}
        stroke="none"
        width={item.width}
      />
    </g>
  );
}

/** Only local vector shapes/text are rasterized; grid and editing handles stay out. */
export async function sketchPng(svg: SVGSVGElement): Promise<File> {
  const clone = svg.cloneNode(true);
  if (!(clone instanceof SVGSVGElement)) {
    throw new Error("The canvas is unavailable. Reopen Sketch and try again.");
  }
  for (const element of clone.querySelectorAll("[data-editor-only]")) {
    element.remove();
  }
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(BOARD_WIDTH));
  clone.setAttribute("height", String(BOARD_HEIGHT));
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(clone)], {
      type: "image/svg+xml",
    })
  );
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Export took too long. Try again.")),
        10_000
      );
      image.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      image.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Could not render this sketch. Try again."));
      };
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = BOARD_WIDTH;
    canvas.height = BOARD_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("This browser cannot export a sketch.");
    }
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) =>
          result
            ? resolve(result)
            : reject(new Error("Could not export the sketch.")),
        "image/png"
      )
    );
    return new File([blob], `sketch-${Date.now()}.png`, {
      type: "image/png",
    });
  } finally {
    image.onload = null;
    image.onerror = null;
    URL.revokeObjectURL(url);
  }
}
