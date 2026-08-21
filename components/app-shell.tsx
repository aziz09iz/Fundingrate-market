"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { AppSidebar, AppSidebarContent } from "@/components/app-sidebar";
import { CommandPalette } from "@/components/command-palette";
import { Menu, CircleDollarSign } from "lucide-react";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // The login page is the one route reachable without a session, so it renders
  // without navigation — a sidebar full of links that all bounce back to /login
  // is only noise.
  if (pathname === "/login") return <>{children}</>;

  return (
    <div className="flex h-full min-h-screen w-full">
      {/* Keyboard users land here first and can skip the sixteen nav links. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-secondary focus:px-3 focus:py-1.5 focus:text-sm focus:text-secondary-foreground"
      >
        Skip to content
      </a>
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex h-12 items-center gap-2 border-b border-border bg-background px-3 lg:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger
              render={
                <Button variant="ghost" size="icon" className="size-9 p-0" aria-label="Open menu" />
              }
            >
              <Menu aria-hidden className="size-5" />
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              <AppSidebarContent />
            </SheetContent>
          </Sheet>
          <div className="flex items-center gap-1.5">
            <CircleDollarSign aria-hidden className="size-4 text-primary" />
            <span className="text-sm font-semibold">Funding Rate Market</span>
          </div>
        </header>
        {/* Main scrollable area */}
        <main id="main-content" className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}
