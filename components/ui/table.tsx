"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Scroll container for a table.
 *
 * `stickyHeader` and `stickyFirstColumn` exist because these tables are wide —
 * the funding board reaches fourteen columns of nowrap numbers — and without
 * them scrolling down loses the venue names while scrolling right loses the coin,
 * so the numbers on screen have no label in either direction.
 */
function Table({
  className,
  containerClassName,
  stickyHeader = false,
  stickyFirstColumn = false,
  ...props
}: React.ComponentProps<"table"> & {
  containerClassName?: string
  stickyHeader?: boolean
  stickyFirstColumn?: boolean
}) {
  return (
    <div
      data-slot="table-container"
      // A sticky header needs a scrolling viewport with a height; otherwise the
      // page scrolls instead and the header has nothing to stick inside.
      className={cn(
        "relative w-full overflow-x-auto",
        stickyHeader && "max-h-[70vh] overflow-y-auto",
        containerClassName,
      )}
    >
      <table
        data-slot="table"
        data-sticky-header={stickyHeader || undefined}
        data-sticky-first-column={stickyFirstColumn || undefined}
        className={cn(
          "w-full caption-bottom text-sm",
          // Header cells sit above body cells, and the pinned column above both,
          // so the two do not paint over each other where they cross.
          stickyHeader &&
            "[&>thead]:sticky [&>thead]:top-0 [&>thead]:z-20 [&>thead_th]:bg-card [&>thead]:shadow-[0_1px_0_0_var(--border)]",
          stickyFirstColumn &&
            "[&>tbody_td:first-child]:sticky [&>tbody_td:first-child]:left-0 [&>tbody_td:first-child]:z-10 [&>tbody_td:first-child]:bg-card [&>tbody_td:first-child]:shadow-[1px_0_0_0_var(--border)] [&>thead_th:first-child]:sticky [&>thead_th:first-child]:left-0 [&>thead_th:first-child]:z-30",
          className,
        )}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      // scope=col so a screen reader can associate each cell with its header;
      // these tables are the entire point of the app and were unlabelled.
      scope="col"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
