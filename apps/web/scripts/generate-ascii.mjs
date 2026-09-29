#!/usr/bin/env node
/**
 * Renders the onboarding figure: a wireframe globe turning one full
 * revolution over 48 frames, drawn as character density on a 46x22 grid.
 *
 * The whole render is deterministic. Every curve is sampled analytically and
 * the only pseudo-random input — the meridian spacing and the surface markers,
 * both of which make the turn legible — comes from one seeded generator, so
 * running this script again reproduces the committed frames byte for byte.
 * The application never runs it; it imports `ascii-frames.ts`.
 *
 *   node apps/web/scripts/generate-ascii.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WIDTH = 46;
const HEIGHT = 22;
const FRAMES = 48;
const MERIDIANS = 7;
const LATITUDES = 4;
const MARKERS = 5;
const SAMPLES = 900;
const SEED = 0x5e_ed_12_34;

/** The globe leans toward the viewer, so the turning rings are visible. */
const TILT = (24 * Math.PI) / 180;
/** Cell radii: a character is taller than it is wide, so x needs the extra. */
const RADIUS_X = 17.6;
const RADIUS_Y = 9.9;

/** Depth as weight, faintest first. */
const DEPTH_RAMP = [".", ":", "+", "*", "#"];
/** A marker on the surface is the densest mark the grid carries. */
const MARKER_RAMP = [" ", ".", ":", "+", "@"];
/** Markers win a shared cell against the wire they sit on. */
const MARKER_PRIORITY = 0.01;

const MODULUS = 2_147_483_647;
const MULTIPLIER = 48_271;

/**
 * A seeded generator (the Park-Miller minimal standard). It exists only so the
 * uneven meridian spacing and the surface markers are reproducible rather than
 * chosen by hand: the same seed always renders the same 48 frames.
 */
function seededRandom(seed) {
  let state = (seed % (MODULUS - 1)) + 1;
  return () => {
    state = (state * MULTIPLIER) % MODULUS;
    return state / MODULUS;
  };
}

/** The meridians of the graticule, in radians, spread unevenly. */
function meridianAngles() {
  const random = seededRandom(SEED);
  const step = Math.PI / MERIDIANS;
  const angles = new Array(MERIDIANS);
  for (let index = 0; index < MERIDIANS; index += 1) {
    angles[index] = step * (index + 0.5) + (random() - 0.5) * step * 0.75;
  }
  return angles;
}

/** The fixed points on the surface that make the rotation unmistakable. */
function markerAngles() {
  const random = seededRandom(SEED);
  const angles = new Array(MARKERS);
  for (let index = 0; index < MARKERS; index += 1) {
    angles[index] = [2 * Math.PI * random(), Math.asin(2 * random() - 1)];
  }
  return angles;
}

function renderFrame(theta, meridians, markers) {
  const cells = new Array(WIDTH * HEIGHT).fill(" ");
  const depths = new Float64Array(WIDTH * HEIGHT).fill(-2);
  const cosSpin = Math.cos(theta);
  const sinSpin = Math.sin(theta);
  const cosTilt = Math.cos(TILT);
  const sinTilt = Math.sin(TILT);
  const centreX = (WIDTH - 1) / 2;
  const centreY = (HEIGHT - 1) / 2;

  const plot = (x, y, z, ramp, priority) => {
    const spunX = x * cosSpin + z * sinSpin;
    const spunZ = -x * sinSpin + z * cosSpin;
    const tiltedY = y * cosTilt - spunZ * sinTilt;
    const tiltedZ = y * sinTilt + spunZ * cosTilt;
    const column = Math.round(centreX + RADIUS_X * spunX);
    const row = Math.round(centreY - RADIUS_Y * tiltedY);
    if (column < 0 || column >= WIDTH || row < 0 || row >= HEIGHT) {
      return;
    }
    const cell = row * WIDTH + column;
    if (tiltedZ + priority <= depths[cell]) {
      return;
    }
    depths[cell] = tiltedZ + priority;
    const level = Math.round(((tiltedZ + 1) / 2) * (ramp.length - 1));
    cells[cell] = ramp[Math.min(Math.max(level, 0), ramp.length - 1)];
  };

  for (const phi of meridians) {
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const angle = (2 * Math.PI * sample) / SAMPLES;
      const cosAngle = Math.cos(angle);
      plot(
        cosAngle * sinPhi,
        Math.sin(angle),
        cosAngle * cosPhi,
        DEPTH_RAMP,
        0
      );
    }
  }

  for (let index = 1; index <= LATITUDES; index += 1) {
    const beta = -Math.PI / 2 + (Math.PI * index) / (LATITUDES + 1);
    const radius = Math.cos(beta);
    const height = Math.sin(beta);
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const angle = (2 * Math.PI * sample) / SAMPLES;
      plot(
        radius * Math.sin(angle),
        height,
        radius * Math.cos(angle),
        DEPTH_RAMP,
        0
      );
    }
  }

  for (const [longitude, latitude] of markers) {
    const radius = Math.cos(latitude);
    plot(
      radius * Math.sin(longitude),
      Math.sin(latitude),
      radius * Math.cos(longitude),
      MARKER_RAMP,
      MARKER_PRIORITY
    );
  }

  const lines = new Array(HEIGHT);
  for (let row = 0; row < HEIGHT; row += 1) {
    lines[row] = cells
      .slice(row * WIDTH, (row + 1) * WIDTH)
      .join("")
      .trimEnd();
  }
  return lines.join("\n");
}

/**
 * A frame is emitted as a template literal. The figures never contain one, but
 * escaping keeps the generator correct if the ramp ever changes.
 */
function templateLiteral(frame) {
  const escaped = frame
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${");
  return `  \`${escaped}\`,`;
}

function renderSource() {
  const meridians = meridianAngles();
  const markers = markerAngles();
  const frames = new Array(FRAMES);
  for (let index = 0; index < FRAMES; index += 1) {
    frames[index] = renderFrame(
      (2 * Math.PI * index) / FRAMES,
      meridians,
      markers
    );
  }
  return [
    "/**",
    " * Generated by `node apps/web/scripts/generate-ascii.mjs`, which is",
    " * committed alongside this file. Do not edit by hand: a wireframe globe",
    " * turning one full revolution over 48 frames of 46x22 characters, with",
    " * the character encoding how near the wire is to the viewer.",
    " */",
    `export const ASCII_FRAME_WIDTH = ${WIDTH};`,
    `export const ASCII_FRAME_HEIGHT = ${HEIGHT};`,
    "",
    "export const ASCII_FRAMES: readonly string[] = [",
    frames.map(templateLiteral).join("\n"),
    "];",
    "",
  ].join("\n");
}

const target = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../components/onboarding/ascii-frames.ts"
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, renderSource(), "utf8");
process.stdout.write(`Wrote ${FRAMES} frames to ${target}\n`);
