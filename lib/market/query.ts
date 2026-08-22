import type { ExchangeId, MarketViewQuery, PairScope, SortDir, SortKey } from "@/lib/types";
import { EXCHANGE_IDS } from "@/lib/utils";

/**
 * Parses a market view query from URL search params.
 *
 * Every field is optional and every invalid value falls back rather than erroring:
 * this drives a dashboard, and a mistyped sort key should show the default board, not
 * a 400. The one thing that is enforced is the page-size ceiling, which the store
 * clamps again — it is a render budget, and a client asking for the whole market in
 * one frame is exactly what the paging exists to prevent.
 */

const SCOPES: PairScope[] = ["cross", "cex-cex", "dex-dex"];
const SORT_KEYS: SortKey[] = ["coin", "spread", "diffFr", "priceSpread", ...EXCHANGE_IDS];

export function parseViewQuery(url: URL): MarketViewQuery {
  const params = url.searchParams;

  const scopeParam = params.get("scope");
  const scope = SCOPES.includes(scopeParam as PairScope) ? (scopeParam as PairScope) : "cross";

  const sortParam = params.get("sort");
  const sort = SORT_KEYS.includes(sortParam as SortKey) ? (sortParam as SortKey) : "diffFr";

  const dir: SortDir = params.get("dir") === "asc" ? "asc" : "desc";

  const venuesParam = params.get("venues");
  const venues = venuesParam
    ? venuesParam
        .split(",")
        .map((v) => v.trim())
        .filter((v): v is ExchangeId => (EXCHANGE_IDS as string[]).includes(v))
    : undefined;

  const pinParam = params.get("pin");
  const pin = pinParam
    ? pinParam
        .split(",")
        .map((v) => v.trim().toUpperCase())
        .filter((v) => /^[A-Z0-9]{1,20}$/.test(v))
        .slice(0, 20)
    : undefined;

  const search = params.get("q")?.trim().slice(0, 20) || undefined;

  return {
    scope,
    venues: venues && venues.length > 0 ? venues : undefined,
    search,
    sort,
    dir,
    page: positiveInt(params.get("page"), 1),
    pageSize: positiveInt(params.get("pageSize"), 100),
    pin: pin && pin.length > 0 ? pin : undefined,
  };
}

function positiveInt(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

/**
 * A stable per-connection id used to key a Book Focus lease.
 *
 * Client-supplied and unauthenticated, like the rest of this market API, which is
 * acceptable because the only thing it can influence is which order books this server
 * subscribes to. It is length-capped so it cannot be used to grow the lease map with
 * arbitrarily long keys, and a missing value gets a random one rather than a shared
 * default — two anonymous tabs must not overwrite each other's lease.
 */
export function parseViewerId(url: URL): string {
  const raw = url.searchParams.get("viewer");
  if (raw && /^[A-Za-z0-9_-]{6,64}$/.test(raw)) return raw;
  return `anon-${Math.random().toString(36).slice(2, 12)}`;
}
