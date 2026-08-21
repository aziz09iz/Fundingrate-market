import { Skeleton } from "@/components/ui/skeleton";

interface PageSkeletonProps {
  /** Metric cards above the main content, if the page has any. */
  cards?: number;
  /** Body rows to stand in for a table, if the page's main content is one. */
  rows?: number;
  /** Suppresses the filter bar placeholder for pages without one. */
  filters?: boolean;
}

/**
 * Route-level loading UI.
 *
 * Shaped like the page it replaces — header, metric cards, filter bar, table
 * rows — so the layout does not jump when the real content lands. The previous
 * placeholders were two grey blocks that matched nothing.
 */
export function PageSkeleton({ cards = 3, rows = 8, filters = true }: PageSkeletonProps) {
  return (
    <div
      className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-6"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading page…</span>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-28 rounded-lg" />
          <Skeleton className="h-8 w-24 rounded-lg" />
        </div>
      </div>

      {cards > 0 && (
        <div
          className={`grid grid-cols-1 gap-3 ${cards >= 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
        >
          {Array.from({ length: cards }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-xl border border-border p-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-8 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>
      )}

      {filters && (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <Skeleton className="h-8 w-full max-w-sm rounded-lg" />
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-20 rounded-lg" />
            ))}
          </div>
        </div>
      )}

      {rows > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-2">
          <Skeleton className="h-8 w-full" />
          {Array.from({ length: rows }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      )}
    </div>
  );
}
