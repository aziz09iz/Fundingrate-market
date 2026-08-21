"use client";

import { Fragment, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CloseHedgeDialog, type CloseHedgeInput } from "@/components/account/close-hedge-dialog";
import { CloseCell } from "@/components/account-detail";
import type { LiveAccountSnapshot, Order, Position, TradeSource } from "@/lib/types";
import { groupPositions, sourceShort, type HedgeRow } from "@/lib/hedge-view";
import { cn, exchangeName, formatPrice, formatSignedUsd, signClass } from "@/lib/utils";
import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronDown, ChevronRight, X } from "lucide-react";

interface LivePositionsProps {
  snapshot: LiveAccountSnapshot;
  onClose: (input: { position: Position; size: number }) => Promise<void>;
  /**
   * Unwinds every leg of a hedge in one step. Separate from `onClose` because a
   * hedge and a single leg are different decisions: closing one leg of a hedge
   * leaves naked directional exposure.
   */
  onCloseHedge: (input: CloseHedgeInput) => Promise<void>;
  onCancel: (order: Order) => Promise<void>;
}

/** How the position table is grouped. Legs is what the venue reports. */
type PositionView = "hedges" | "legs";

/**
 * Marks a row as manual or names the strategy that opened it. For live positions
 * the tag is derived from the hedges the strategy is managing, since the venue
 * reports a position without any notion of who opened it.
 */
function SourceTag({ source, hedgeId }: { source?: TradeSource; hedgeId?: string | null }) {
  const auto = source === "auto";
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[10px]",
        auto ? "bg-info/15 text-info" : "bg-muted text-muted-foreground",
      )}
    >
      {sourceShort(source, hedgeId)}
    </span>
  );
}

/** Both venues of a hedge on one line, in the direction actually traded. */
function Route({ long, short }: { long?: string | null; short?: string | null }) {
  if (!long && !short) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
      <span className="text-positive">{long ? exchangeName(long as never) : "—"}</span>
      <ArrowRight aria-hidden className="size-3 text-muted-foreground" />
      <span className="text-negative">{short ? exchangeName(short as never) : "—"}</span>
    </span>
  );
}

/**
 * Live positions and orders with close/cancel actions.
 *
 * Both actions go through a confirmation showing the exact venue, side and size,
 * because these send real orders that cannot be undone once filled.
 *
 * Positions default to a hedge view rather than the venue's leg view. A venue
 * reports legs because that is what it holds, but a cross-venue hedge is one
 * decision, and closing it a leg at a time is how a delta-neutral position turns
 * into a directional bet by accident. The leg view stays one click away for the
 * cases where a single side really is the intent.
 */
export function LivePositions({
  snapshot,
  onClose,
  onCloseHedge,
  onCancel,
}: LivePositionsProps) {
  const [view, setView] = useState<PositionView>("hedges");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [closing, setClosing] = useState<Position | null>(null);
  const [closeSize, setCloseSize] = useState("");
  const [closingHedge, setClosingHedge] = useState<HedgeRow | null>(null);
  const [cancelling, setCancelling] = useState<Order | null>(null);

  const notional = closing ? Number(closeSize || 0) * closing.markPrice : 0;

  // Live positions carry no hedge id — the venue does not know about one — so the
  // grouping falls back to (coin, source), which is what pairs a cross-venue hedge
  // the strategy or the trade page opened.
  const hedges = useMemo(() => groupPositions(snapshot.positions), [snapshot.positions]);

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Open Positions</CardTitle>
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="text-[10px]">
              {view === "hedges"
                ? `${hedges.length} hedge${hedges.length === 1 ? "" : "s"}`
                : `${snapshot.positions.length} open`}
            </Badge>
            <Tabs value={view} onValueChange={(v) => setView(v as PositionView)}>
              <TabsList>
                <TabsTrigger value="hedges" className="text-xs">
                  Hedges
                </TabsTrigger>
                <TabsTrigger value="legs" className="text-xs">
                  Legs
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {view === "hedges" ? (
            <Table stickyHeader>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-8 w-8" />
                  <TableHead className="h-8">Pair</TableHead>
                  <TableHead className="h-8">Route (long → short)</TableHead>
                  <TableHead className="h-8">Source</TableHead>
                  <TableHead className="h-8 text-right">Size</TableHead>
                  <TableHead className="h-8 text-right">Notional</TableHead>
                  <TableHead className="h-8 text-right">Lev</TableHead>
                  <TableHead className="h-8 text-right">uPnL</TableHead>
                  <TableHead className="h-8 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {hedges.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="py-6 text-center text-muted-foreground">
                      No open positions reported by any venue.
                    </TableCell>
                  </TableRow>
                )}
                {hedges.map((h) => {
                  const open = expanded === h.key;
                  const unpaired = !h.longLeg || !h.shortLeg;
                  return (
                    <Fragment key={h.key}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => setExpanded(open ? null : h.key)}
                      >
                        <TableCell className="py-1.5">
                          {open ? (
                            <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
                          ) : (
                            <ChevronRight aria-hidden className="size-3.5 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {h.coin}
                          {unpaired && (
                            <span className="ml-1.5 rounded bg-warning/15 px-1 py-0.5 text-[9px] text-warning">
                              one leg
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Route long={h.longLeg?.exchange} short={h.shortLeg?.exchange} />
                        </TableCell>
                        <TableCell>
                          <SourceTag source={h.source} hedgeId={h.hedgeId} />
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs num">{h.size}</TableCell>
                        <TableCell className="text-right font-mono text-xs num text-muted-foreground">
                          ${h.notional.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs num">
                          {h.leverage}×
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right font-mono text-xs num",
                            signClass(h.unrealizedPnl),
                          )}
                        >
                          {formatSignedUsd(h.unrealizedPnl, 2)}
                        </TableCell>
                        <TableCell className="text-right">
                          <CloseCell hedge={h} onClick={() => setClosingHedge(h)} />
                        </TableCell>
                      </TableRow>

                      {open && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={9} className="bg-muted/20 p-0">
                            <div className="flex flex-col gap-1 px-4 py-2">
                              <p className="pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                Legs — close one on its own from the Legs view
                              </p>
                              {[h.longLeg, h.shortLeg, ...h.extraLegs]
                                .filter((l): l is Position => l !== null)
                                .map((leg) => (
                                  <div
                                    key={`${leg.exchange}-${leg.side}`}
                                    className="flex flex-wrap items-center gap-x-4 gap-y-0.5 font-mono text-[11px]"
                                  >
                                    <span
                                      className={cn(
                                        "w-12 shrink-0",
                                        leg.side === "long" ? "text-positive" : "text-negative",
                                      )}
                                    >
                                      {leg.side}
                                    </span>
                                    <span className="w-20 shrink-0 text-xs">
                                      {exchangeName(leg.exchange)}
                                    </span>
                                    <span className="num text-muted-foreground">
                                      entry {formatPrice(leg.entryPrice)}
                                    </span>
                                    <span className="num text-muted-foreground">
                                      mark {formatPrice(leg.markPrice)}
                                    </span>
                                    <span className="num text-warning-muted">
                                      liq {formatPrice(leg.liquidationPrice ?? null)}
                                    </span>
                                    <span className="num text-muted-foreground">
                                      size {leg.size}
                                    </span>
                                    <span className={cn("num", signClass(leg.unrealizedPnl))}>
                                      {formatSignedUsd(leg.unrealizedPnl, 2)}
                                    </span>
                                  </div>
                                ))}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <Table stickyHeader stickyFirstColumn>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8">Pair</TableHead>
                <TableHead className="h-8">Venue</TableHead>
                <TableHead className="h-8">Side</TableHead>
                <TableHead className="h-8">Source</TableHead>
                <TableHead className="h-8 text-right">Size</TableHead>
                <TableHead className="h-8 text-right">Entry</TableHead>
                <TableHead className="h-8 text-right">Mark</TableHead>
                <TableHead className="h-8 text-right">Liq</TableHead>
                <TableHead className="h-8 text-right">Lev</TableHead>
                <TableHead className="h-8 text-right">uPnL</TableHead>
                <TableHead className="h-8 text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshot.positions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="py-6 text-center text-muted-foreground">
                    No open positions reported by any venue.
                  </TableCell>
                </TableRow>
              )}
              {snapshot.positions.map((p) => {
                const long = p.side === "long";
                return (
                  <TableRow key={`${p.exchange}-${p.coin}-${p.side}`}>
                    <TableCell className="font-mono text-xs">{p.coin}</TableCell>
                    <TableCell className="text-xs">{exchangeName(p.exchange)}</TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 font-mono text-xs",
                          long ? "text-positive" : "text-negative",
                        )}
                      >
                        {long ? (
                          <ArrowUpRight aria-hidden className="size-3" />
                        ) : (
                          <ArrowDownRight aria-hidden className="size-3" />
                        )}
                        {p.side}
                      </span>
                    </TableCell>
                    <TableCell>
                      <SourceTag source={p.source} hedgeId={p.hedgeId} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">{p.size}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatPrice(p.entryPrice)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatPrice(p.markPrice)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-warning-muted">
                      {formatPrice(p.liquidationPrice ?? null)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">{p.leverage}×</TableCell>
                    <TableCell className={cn("text-right font-mono text-xs", signClass(p.unrealizedPnl))}>
                      {formatSignedUsd(p.unrealizedPnl, 2)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-negative hover:text-negative/85"
                        onClick={() => {
                          setCloseSize(String(p.size));
                          setClosing(p);
                        }}
                      >
                        Close
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Open Orders</CardTitle>
          <Badge variant="secondary" className="text-[10px]">
            {snapshot.openOrders.length} resting
          </Badge>
        </CardHeader>
        <CardContent className="p-0">
          <Table stickyHeader>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8">Pair</TableHead>
                <TableHead className="h-8">Venue</TableHead>
                <TableHead className="h-8">Side</TableHead>
                <TableHead className="h-8">Type</TableHead>
                <TableHead className="h-8">Source</TableHead>
                <TableHead className="h-8 text-right">Price</TableHead>
                <TableHead className="h-8 text-right">Size</TableHead>
                <TableHead className="h-8 text-right">Filled</TableHead>
                <TableHead className="h-8">Status</TableHead>
                <TableHead className="h-8 text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshot.openOrders.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="py-6 text-center text-muted-foreground">
                    No resting orders.
                  </TableCell>
                </TableRow>
              )}
              {snapshot.openOrders.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="font-mono text-xs">{o.pair}</TableCell>
                  <TableCell className="text-xs">{exchangeName(o.exchange)}</TableCell>
                  <TableCell
                    className={cn(
                      "font-mono text-xs",
                      o.side === "buy" ? "text-positive" : "text-negative",
                    )}
                  >
                    {o.side}
                  </TableCell>
                  <TableCell className="text-xs uppercase">{o.orderType}</TableCell>
                  <TableCell>
                    <SourceTag source={o.source} hedgeId={o.hedgeId} />
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatPrice(o.price)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">{o.size}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{o.filled}</TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-[10px] uppercase">
                      {o.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 text-xs text-negative hover:text-negative/85"
                      onClick={() => setCancelling(o)}
                    >
                      <X aria-hidden className="size-3" />
                      Cancel
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <CloseHedgeDialog
        hedge={closingHedge}
        onOpenChange={(open) => !open && setClosingHedge(null)}
        accountType="live"
        onConfirm={async (input) => {
          await onCloseHedge(input);
          setClosingHedge(null);
        }}
      />

      <ConfirmDialog
        open={closing !== null}
        onOpenChange={(open) => !open && setClosing(null)}
        title="Close position"
        description="Sends a reduce-only market order to the venue immediately."
        confirmLabel="Send close order"
        destructive
        warning="This is a real order on a real venue. Once it fills it cannot be undone. Closing one leg of a hedge leaves the other side unhedged."
        details={
          closing
            ? [
                { label: "Venue", value: exchangeName(closing.exchange), emphasis: true },
                { label: "Pair", value: closing.coin, emphasis: true },
                {
                  label: "Closing",
                  value: `${closing.side} → ${closing.side === "long" ? "sell" : "buy"}`,
                  emphasis: true,
                },
                { label: "Open size", value: String(closing.size) },
                { label: "Closing size", value: closeSize || "0", emphasis: true },
                { label: "Approx. notional", value: `$${notional.toFixed(2)}` },
                { label: "Mark price", value: formatPrice(closing.markPrice) },
              ]
            : []
        }
        onConfirm={async () => {
          if (!closing) return;
          const size = Number(closeSize);
          if (!Number.isFinite(size) || size <= 0) throw new Error("Size must be positive");
          if (size > closing.size) throw new Error("Size exceeds the open position");
          await onClose({ position: closing, size });
          setClosing(null);
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="close-size" className="text-xs text-muted-foreground">
            Size to close
          </Label>
          <Input
            id="close-size"
            type="number"
            min={0}
            step="any"
            value={closeSize}
            onChange={(e) => setCloseSize(e.target.value)}
            className="font-mono text-xs num"
          />
          <div className="flex gap-1">
            {[25, 50, 75, 100].map((pct) => (
              <Button
                key={pct}
                variant="ghost"
                size="sm"
                className="h-6 flex-1 text-[10px]"
                onClick={() =>
                  closing && setCloseSize(String(Number(((closing.size * pct) / 100).toFixed(8))))
                }
              >
                {pct === 100 ? "All" : `${pct}%`}
              </Button>
            ))}
          </div>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => !open && setCancelling(null)}
        title="Cancel order"
        description="Asks the venue to cancel this resting order."
        confirmLabel="Cancel order"
        destructive
        details={
          cancelling
            ? [
                { label: "Venue", value: exchangeName(cancelling.exchange), emphasis: true },
                { label: "Pair", value: cancelling.pair, emphasis: true },
                { label: "Side", value: cancelling.side },
                { label: "Price", value: formatPrice(cancelling.price) },
                { label: "Size", value: String(cancelling.size) },
                { label: "Already filled", value: String(cancelling.filled) },
              ]
            : []
        }
        onConfirm={async () => {
          if (!cancelling) return;
          await onCancel(cancelling);
          setCancelling(null);
        }}
      />
    </>
  );
}
