import {
  ArrowLeftRight,
  BookOpen,
  Bot,
  Boxes,
  Building2,
  CandlestickChart,
  FlaskConical,
  KeyRound,
  Layers,
  LayoutDashboard,
  Settings,
  Shuffle,
  Terminal,
  TrendingUp,
  Wallet,
} from "lucide-react";

/**
 * The app's navigation tree, in one place.
 *
 * The sidebar, the breadcrumb trail and the command palette all need to know the
 * same routes and labels. Keeping three copies in sync by hand is how a renamed
 * page ends up with two different names depending on where you look.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Nested entries, shown indented under the parent. */
  children?: NavItem[];
  /**
   * True when the href only exists to redirect to its first child. The
   * breadcrumb renders it as plain text and the palette leaves it out, because
   * "go to Venue Credentials" resolves to a page the user did not choose.
   */
  redirectOnly?: boolean;
  /** Extra words the palette should match on, beyond the label. */
  keywords?: string[];
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    title: "Main",
    items: [
      {
        href: "/dashboard",
        label: "Funding Rate Dashboard",
        icon: LayoutDashboard,
        redirectOnly: true,
        children: [
          {
            href: "/dashboard/cross",
            label: "Cross CEX–DEX",
            icon: Shuffle,
            keywords: ["funding", "cross", "hedge", "board"],
          },
          {
            href: "/dashboard/cex",
            label: "Centralized Exchange",
            icon: Building2,
            keywords: ["funding", "cex", "binance", "bybit", "okx"],
          },
          {
            href: "/dashboard/dex",
            label: "Decentralized Exchange",
            icon: Boxes,
            keywords: ["funding", "dex", "hyperliquid", "aster", "lighter", "edgex"],
          },
        ],
      },
      {
        href: "/trade",
        label: "Trade",
        icon: CandlestickChart,
        keywords: ["order", "buy", "sell", "hedge", "manual"],
      },
    ],
  },
  {
    title: "Account",
    items: [
      { href: "/account", label: "Overview", icon: Wallet, keywords: ["capital", "exposure"] },
      {
        href: "/account/live",
        label: "Live Account",
        icon: TrendingUp,
        keywords: ["positions", "balances", "real"],
      },
      {
        href: "/account/paper",
        label: "Paper Account",
        icon: FlaskConical,
        keywords: ["simulated", "reset"],
      },
      {
        href: "/account/rebalance",
        label: "Treasury Rebalancing",
        icon: ArrowLeftRight,
        keywords: ["transfer", "withdraw", "destinations"],
      },
    ],
  },
  {
    title: "Automation",
    items: [
      { href: "/auto/live", label: "Auto Live", icon: Bot, keywords: ["strategy", "deployments"] },
      { href: "/auto/paper", label: "Auto Paper", icon: Layers, keywords: ["strategy", "simulated"] },
      {
        href: "/auto/library",
        label: "Strategy Library",
        icon: BookOpen,
        keywords: [
          "docs",
          "documentation",
          "explain",
          "how it works",
          "fundingsync",
          "perpbridge",
          "fundingbridge",
          "fundingyield",
          "compare",
        ],
      },
      { href: "/auto/logs", label: "Logs", icon: Terminal, keywords: ["decisions", "console"] },
    ],
  },
  {
    title: "System",
    items: [
      {
        href: "/settings/api-keys",
        label: "Venue Credentials",
        icon: KeyRound,
        redirectOnly: true,
        children: [
          {
            href: "/settings/api-keys/cex",
            label: "API Key Venues",
            icon: Building2,
            keywords: ["credentials", "secret", "api", "cex", "edgex"],
          },
          {
            href: "/settings/api-keys/dex",
            label: "Wallet-Signed Venues",
            icon: Boxes,
            keywords: ["credentials", "wallet", "private key", "dex", "hyperliquid", "aster"],
          },
        ],
      },
      {
        href: "/settings/general",
        label: "General Setting",
        icon: Settings,
        keywords: ["fees", "cadence", "notifications", "telegram", "safety"],
      },
    ],
  },
];

/** Every entry in the tree, flattened, parents included. */
export function flatNav(sections: NavSection[] = NAV): NavItem[] {
  const walk = (items: NavItem[]): NavItem[] =>
    items.flatMap((item) => [item, ...(item.children ? walk(item.children) : [])]);
  return walk(sections.flatMap((s) => s.items));
}

/** Every href in the tree, parents and children alike. */
export function allHrefs(sections: NavSection[] = NAV): string[] {
  return flatNav(sections).map((item) => item.href);
}

/**
 * Deepest entry matching the path, so /account/rebalance does not also light up
 * the /account overview link.
 */
export function activeNavHref(pathname: string, sections: NavSection[] = NAV): string | undefined {
  return allHrefs(sections)
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];
}

export interface Crumb {
  label: string;
  /** Absent for a section that only redirects, or for the current page. */
  href?: string;
}

/**
 * Breadcrumb trail for a path: the section title, then each matching ancestor,
 * ending at the current page. Three-level routes such as
 * /settings/api-keys/cex previously had the sidebar highlight as their only
 * location cue.
 */
export function breadcrumbsFor(pathname: string, sections: NavSection[] = NAV): Crumb[] {
  for (const section of sections) {
    for (const item of section.items) {
      const onItem = pathname === item.href || pathname.startsWith(`${item.href}/`);
      if (!onItem) continue;

      const child = item.children?.find(
        (c) => pathname === c.href || pathname.startsWith(`${c.href}/`),
      );

      const trail: Crumb[] = [{ label: section.title }];
      trail.push({
        label: item.label,
        // A parent that only redirects is not a place, so it is not linked.
        href: child && !item.redirectOnly ? item.href : undefined,
      });
      if (child) trail.push({ label: child.label });
      return trail;
    }
  }
  return [];
}
