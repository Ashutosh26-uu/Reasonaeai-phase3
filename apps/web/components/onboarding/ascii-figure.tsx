"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  ASCII_FRAME_HEIGHT,
  ASCII_FRAME_WIDTH,
  ASCII_FRAMES,
} from "./ascii-frames";

/** Twelve frames a second: one full revolution of the globe every four. */
const FRAME_DURATION_MS = 1000 / 12;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    // The server has no preference to read, and no motion to stop.
    () => false
  );
}

/**
 * The onboarding illustration: the wireframe globe the generator rendered,
 * stepped one frame at a time.
 *
 * It is decoration, so the grid is hidden from assistive technology and the
 * figure carries the description instead. Stepping only advances a frame
 * index, and a viewer who asked for reduced motion holds on the first frame
 * rather than watching it turn.
 */
export function AsciiFigure() {
  const reducedMotion = usePrefersReducedMotion();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (reducedMotion) {
      return;
    }
    const timer = window.setInterval(() => {
      setFrame((current) => (current + 1) % ASCII_FRAMES.length);
    }, FRAME_DURATION_MS);
    return () => window.clearInterval(timer);
  }, [reducedMotion]);

  return (
    <figure className="onb-figure">
      <pre
        aria-hidden="true"
        className="onb-ascii"
        style={{
          height: `${ASCII_FRAME_HEIGHT}lh`,
          width: `${ASCII_FRAME_WIDTH}ch`,
        }}
      >
        {ASCII_FRAMES[reducedMotion ? 0 : frame]}
      </pre>
      <figcaption className="sr-only">
        A wireframe globe turning about a tilted axis, drawn in characters where
        the denser marks are the parts nearest the viewer.
      </figcaption>
    </figure>
  );
}
