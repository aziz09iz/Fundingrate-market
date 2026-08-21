"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { NAV, flatNav, type NavItem } from "@/lib/nav";
import { CornerDownLeft, Search } from "lucide-react";

/**
 * Ctrl/Cmd+K jump list over the nav tree.
 *
 * Sixteen destinations across four sections is more than a sidebar scan is good
 * for once you know where you are going, and on mobile the sidebar is behind a
 * drawer. Built on the existing Dialog rather than adding cmdk: the list is a
 * flat filter over a known set, which does not need a combobox library.
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  // Tracks the query the highlight belongs to, so a narrower result list resets
  // it during render rather than through an effect that would paint one frame
  // pointing past the end of the list.
  const [highlightedFor, setHighlightedFor] = useState("");
  const listRef = useRef<HTMLUListElement>(null);

  const destinations = useMemo(
    // Redirect-only parents are dropped: choosing one lands on a child the user
    // did not pick, which reads as the palette ignoring the selection.
    () => flatNav(NAV).filter((item) => !item.redirectOnly),
    [],
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return destinations;
    return destinations.filter((item) => {
      const haystack = [item.label, item.href, ...(item.keywords ?? [])].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [destinations, query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setOpen((prev) => !prev);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // A stale highlight would point past the end of a narrower result list.
  if (highlightedFor !== query) {
    setHighlightedFor(query);
    setHighlighted(0);
  }

  const go = useCallback(
    (item: NavItem) => {
      setOpen(false);
      setQuery("");
      router.push(item.href);
    },
    [router],
  );

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = results[highlighted];
      if (target) go(target);
    }
  };

  // Keep the highlighted row in view when arrowing past the visible window.
  useEffect(() => {
    const node = listRef.current?.children[highlighted] as HTMLElement | undefined;
    node?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <DialogContent className="top-[15%] max-w-lg translate-y-0 gap-0 p-0 sm:max-w-lg" showCloseButton={false}>
        <DialogTitle className="sr-only">Jump to a page</DialogTitle>
        <DialogDescription className="sr-only">
          Type to filter pages, then press Enter to open the highlighted result.
        </DialogDescription>

        <div className="relative border-b border-border">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            aria-label="Search pages"
            aria-controls="command-palette-results"
            placeholder="Jump to a page…"
            className="h-11 rounded-none border-0 pl-9 focus-visible:ring-0"
          />
        </div>

        <ul
          ref={listRef}
          id="command-palette-results"
          role="listbox"
          aria-label="Pages"
          className="max-h-72 overflow-y-auto p-1.5"
        >
          {results.length === 0 && (
            <li className="px-2.5 py-6 text-center text-xs text-muted-foreground">
              No page matches “{query}”.
            </li>
          )}
          {results.map((item, i) => {
            const Icon = item.icon;
            const active = i === highlighted;
            return (
              <li key={item.href} role="option" aria-selected={active}>
                <button
                  type="button"
                  onClick={() => go(item)}
                  onMouseEnter={() => setHighlighted(i)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                    active ? "bg-secondary text-secondary-foreground" : "text-muted-foreground",
                  )}
                >
                  <Icon aria-hidden className="size-4 shrink-0" />
                  <span className="flex-1 truncate">{item.label}</span>
                  <span className="font-mono text-[10px] opacity-60">{item.href}</span>
                  {active && <CornerDownLeft aria-hidden className="size-3 shrink-0 opacity-60" />}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center gap-3 border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Key>↑</Key>
            <Key>↓</Key>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <Key>enter</Key>
            open
          </span>
          <span className="flex items-center gap-1">
            <Key>esc</Key>
            close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}
