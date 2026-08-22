"use client";

import { useState } from "react";

export type FlashDirection = "up" | "down" | null;

/**
 * Reports whether a streamed number just moved up or down, so a cell can tint
 * briefly on change. The board updates every second and a bare number gives no
 * clue which way it went without watching two consecutive frames.
 *
 * Deliberately effect-free and timer-free. The first version compared values in an
 * effect and cleared the tint with a `setTimeout`, which is the obvious shape and does
 * not survive scale: at a hundred rows with two flashing cells each, one frame queued
 * two hundred effect-driven state updates plus two hundred timers every second, and
 * React reported `Maximum update depth exceeded` because those updates chain through
 * successive passive-effect flushes rather than batching.
 *
 * Instead the comparison happens during render against state — the pattern React
 * sanctions for deriving state from props — so a changed value costs one immediate
 * re-render and nothing else. Clearing is handed to the CSS animation via
 * `onAnimationEnd`, which is the event that actually marks the tint as finished.
 */
export function useValueFlash(value: number | null): {
  direction: FlashDirection;
  onAnimationEnd: () => void;
} {
  const [state, setState] = useState<{ previous: number | null; direction: FlashDirection }>({
    previous: value,
    direction: null,
  });

  if (state.previous !== value) {
    const moved =
      value !== null && state.previous !== null
        ? value > state.previous
          ? "up"
          : "down"
        : null;
    setState({ previous: value, direction: moved });
  }

  return {
    direction: state.direction,
    onAnimationEnd: () => {
      // Guarded so an unrelated animation on the same element cannot clear a tint that
      // has not run yet, and so this is a no-op once the tint is already gone.
      if (state.direction !== null) setState((prev) => ({ ...prev, direction: null }));
    },
  };
}
