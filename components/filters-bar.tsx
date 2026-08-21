"use client";

import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Check, Loader2, Search } from "lucide-react";
import type { ExchangeId } from "@/lib/types";
import { EXCHANGES, cn } from "@/lib/utils";

interface FiltersBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  enabled: Record<ExchangeId, boolean>;
  /** Venues this bar offers. Defaults to all of them. */
  exchanges?: ExchangeId[];
  onToggleExchange: (id: ExchangeId) => void;
  onRefresh: () => void;
  /** True while a reconnect is in flight, so the button cannot be spammed. */
  refreshing?: boolean;
}

export function FiltersBar({
  query,
  onQueryChange,
  enabled,
  exchanges,
  onToggleExchange,
  onRefresh,
  refreshing = false,
}: FiltersBarProps) {
  const shown = exchanges ? EXCHANGES.filter((ex) => exchanges.includes(ex.id)) : EXCHANGES;
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses the coin search, the convention on every screen that is mostly a
  // table. Ignored while typing so it stays a literal slash in any other field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="relative w-full max-w-sm">
        <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onQueryChange("");
              e.currentTarget.blur();
            }
          }}
          aria-label="Search coin"
          placeholder="Search coin (BTC, SOL…)"
          className="pl-9 pr-9 font-mono"
        />
        <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">
          /
        </kbd>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {shown.map((ex) => {
          const on = enabled[ex.id];
          return (
            <Button
              key={ex.id}
              type="button"
              // These are toggles, not navigation, and previously said so only
              // through opacity. aria-pressed makes the state readable.
              aria-pressed={on}
              variant={on ? "outline" : "secondary"}
              size="sm"
              onClick={() => onToggleExchange(ex.id)}
              className={cn(
                "h-7 gap-1.5 px-2.5 text-xs",
                on ? ex.accent : "text-muted-foreground opacity-50",
                on && "border-border",
              )}
            >
              {on ? (
                <Check aria-hidden className="size-3" />
              ) : (
                <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground" />
              )}
              {ex.name}
            </Button>
          );
        })}
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
          className="h-7 gap-1.5 px-3 text-xs"
        >
          {refreshing && <Loader2 aria-hidden className="size-3 animate-spin" />}
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
    </div>
  );
}
