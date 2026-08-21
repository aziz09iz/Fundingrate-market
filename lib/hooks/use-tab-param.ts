"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Tab state kept in the URL instead of component state.
 *
 * Tabs held in `useState` broke the back button and could not be linked or
 * bookmarked: reloading a page always dropped you on its first tab, and "look at
 * the rebalance history" had no shareable address.
 *
 * `replace` rather than `push` so switching tabs does not fill the history with
 * entries the back button has to walk through. Requires a `<Suspense>` boundary
 * above it, which is how `useSearchParams` works in the App Router.
 */
export function useTabParam<T extends string>(
  key: string,
  values: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const router = useRouter();
  const searchParams = useSearchParams();
  const raw = searchParams.get(key);
  const active = values.includes(raw as T) ? (raw as T) : fallback;

  const setActive = useCallback(
    (next: T) => {
      const params = new URLSearchParams(searchParams.toString());
      // The default tab is the bare URL, so a shared link is only as long as it
      // needs to be.
      if (next === fallback) params.delete(key);
      else params.set(key, next);
      const query = params.toString();
      router.replace(query ? `?${query}` : window.location.pathname, { scroll: false });
    },
    [router, searchParams, key, fallback],
  );

  return [active, setActive];
}
