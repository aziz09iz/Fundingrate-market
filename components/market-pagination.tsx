"use client";

import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface MarketPaginationProps {
  page: number;
  pageSize: number;
  /** Rows matching the filter across the whole market. */
  total: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
  disabled?: boolean;
}

const PAGE_SIZES = [50, 100, 250] as const;

/**
 * Page controls for a server-paged table.
 *
 * The range label is the important part rather than the buttons: with thousands of
 * pairs behind one page, "1–100 of 2,431" is what tells a reader that the board is a
 * window onto the market and not the whole of it.
 */
export function MarketPagination({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
  disabled = false,
}: MarketPaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pageCount);
  const first = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const last = Math.min(current * pageSize, total);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <span className="font-mono text-[11px] text-muted-foreground">
        {total === 0 ? "no rows" : `${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`}
      </span>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Rows</span>
          {PAGE_SIZES.map((size) => (
            <Button
              key={size}
              type="button"
              variant={size === pageSize ? "secondary" : "outline"}
              size="sm"
              aria-pressed={size === pageSize}
              disabled={disabled}
              onClick={() => onPageSize(size)}
              className="h-7 px-2 font-mono text-[11px]"
            >
              {size}
            </Button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            disabled={disabled || current <= 1}
            onClick={() => onPage(current - 1)}
          >
            <ChevronLeft aria-hidden className="size-3" />
            Prev
          </Button>
          <span className={cn("font-mono text-[11px] tabular-nums", disabled && "opacity-50")}>
            {current} / {pageCount}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            disabled={disabled || current >= pageCount}
            onClick={() => onPage(current + 1)}
          >
            Next
            <ChevronRight aria-hidden className="size-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}
