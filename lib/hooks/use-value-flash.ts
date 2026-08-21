"use client";

import { useEffect, useRef, useState } from "react";

export type FlashDirection = "up" | "down" | null;

/**
 * Reports whether a streamed number just moved up or down, so a cell can tint
 * briefly on change. The board updates every second and a bare number gives no
 * clue which way it went without watching two consecutive frames.
 *
 * The flag clears itself after `holdMs`, which must outlast the CSS animation in
 * globals.css or a value that ticks the same direction twice will not re-fire.
 */
export function useValueFlash(value: number | null, holdMs = 620): FlashDirection {
  const [direction, setDirection] = useState<FlashDirection>(null);
  const previous = useRef<number | null>(value);
  // Incremented on every change so repeated moves in the same direction each get
  // their own timer rather than sharing a stale one.
  const tick = useRef(0);

  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (value === null || before === null || value === before) return;
    tick.current += 1;
    const mine = tick.current;
    setDirection(value > before ? "up" : "down");
    const timer = setTimeout(() => {
      // Only the newest change may clear the flag.
      if (tick.current === mine) setDirection(null);
    }, holdMs);
    return () => clearTimeout(timer);
  }, [value, holdMs]);

  return direction;
}
