"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { signOut } from "@/lib/api/client";
import { NAV, activeNavHref, type NavItem } from "@/lib/nav";
import { CircleDollarSign, LogOut } from "lucide-react";

export function AppSidebarContent() {
  const pathname = usePathname();
  const activeHref = activeNavHref(pathname);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <CircleDollarSign aria-hidden className="size-4" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold">Funding Rate Market</span>
          <Badge variant="secondary" className="mt-0.5 w-fit text-[9px] uppercase">
            Live market data
          </Badge>
        </div>
      </div>
      <Separator />
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 py-3">
        {NAV.map((section) => (
          <div key={section.title} className="mb-4">
            <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {section.title}
            </p>
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <NavEntry key={item.href} item={item} activeHref={activeHref} />
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <Separator />
      <div className="flex flex-col gap-2 px-3 py-3">
        <button
          type="button"
          onClick={() => void signOut()}
          className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
        >
          <LogOut aria-hidden className="size-4 shrink-0" />
          Sign out
        </button>
        <p className="px-2 text-[10px] text-muted-foreground">
          Personal use · market data live · paper &amp; live accounts wired
        </p>
      </div>
    </div>
  );
}

/**
 * One nav row, plus its children when it has them.
 *
 * Children are always visible rather than collapsible: with two entries a
 * disclosure toggle costs a click and hides nothing worth hiding.
 */
function NavEntry({ item, activeHref }: { item: NavItem; activeHref: string | undefined }) {
  const Icon = item.icon;
  const active = item.href === activeHref;
  // A parent whose child is active is a heading, not a destination, so it gets a
  // muted "section is open" treatment rather than the full active style.
  const childActive = item.children?.some((c) => c.href === activeHref) ?? false;

  return (
    <li>
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
          active
            ? "bg-secondary font-medium text-secondary-foreground"
            : childActive
              ? "text-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
        )}
      >
        <Icon aria-hidden className="size-4 shrink-0" />
        {item.label}
      </Link>

      {item.children && (
        <ul className="mt-0.5 flex flex-col gap-0.5 border-l border-border pl-2 ml-4">
          {item.children.map((child) => {
            const ChildIcon = child.icon;
            const childIsActive = child.href === activeHref;
            return (
              <li key={child.href}>
                <Link
                  href={child.href}
                  aria-current={childIsActive ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
                    childIsActive
                      ? "bg-secondary font-medium text-secondary-foreground"
                      : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                  )}
                >
                  <ChildIcon aria-hidden className="size-3.5 shrink-0" />
                  {child.label}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/** Persistent desktop sidebar (lg+). */
export function AppSidebar() {
  return (
    <aside className="hidden w-60 shrink-0 border-r border-border bg-sidebar text-sidebar-foreground lg:flex lg:flex-col">
      <AppSidebarContent />
    </aside>
  );
}
