"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Order, OrderStatus } from "@/lib/types";
import { sourceShort } from "@/lib/hedge-view";
import { cn, exchangeName, formatPrice, formatSignedUsd, signClass } from "@/lib/utils";
import { X, Link2 } from "lucide-react";

interface OpenOrdersProps {
  orders: Order[];
  history: Order[];
  onCancel: (id: string) => void;
}

type Tab = "open" | "history";

export function OpenOrders({ orders, history, onCancel }: OpenOrdersProps) {
  const [tab, setTab] = useState<Tab>("open");

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between py-3">
        <CardTitle className="text-sm">Orders</CardTitle>
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList>
            <TabsTrigger value="open" className="text-xs">
              Open ({orders.length})
            </TabsTrigger>
            <TabsTrigger value="history" className="text-xs">
              History
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent className="p-0">
        <Table stickyHeader>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-8">Time</TableHead>
              <TableHead className="h-8">Pair</TableHead>
              <TableHead className="h-8">Exchange</TableHead>
              <TableHead className="h-8">Side</TableHead>
              <TableHead className="h-8">Type</TableHead>
              <TableHead className="h-8">Source</TableHead>
              <TableHead className="h-8">Leverage</TableHead>
              <TableHead className="h-8 text-right">Price</TableHead>
              <TableHead className="h-8 text-right">Size</TableHead>
              {tab === "open" && <TableHead className="h-8 text-right">Filled</TableHead>}
              {tab === "history" && <TableHead className="h-8 text-right">PnL</TableHead>}
              <TableHead className="h-8">Status</TableHead>
              {tab === "open" && <TableHead className="h-8 text-right">Action</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {tab === "open" && orders.length === 0 && (
              <EmptyRow colSpan={11} label="No open orders." />
            )}
            {tab === "history" && history.length === 0 && (
              <EmptyRow colSpan={11} label="No trade history." />
            )}
            {tab === "open" &&
              orders.map((o) => (
                <TableRow key={o.id} className="hover:bg-muted/30">
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {fmtTime(o.time)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {o.hedgeId && <Link2 className="mr-1 inline size-3 text-info" />}
                    {o.pair}
                  </TableCell>
                  <TableCell className="text-xs">{exchangeName(o.exchange)}</TableCell>
                  <SideCell side={o.side} />
                  <TableCell className="text-xs uppercase">{o.orderType}</TableCell>
                  <SourceCell source={o.source} hedgeId={o.hedgeId} />
                  <TableCell className="text-xs uppercase">
                    {`Perp ${o.leverage}×`}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatPrice(o.price)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">{o.size}</TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {pct(o.filled, o.size)}%
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={o.status} />
                    {o.status === "pending" && o.waitLongExchange && o.waitShortExchange && (
                      <span className="mt-0.5 block whitespace-nowrap font-mono text-[9px] text-muted-foreground">
                        waiting {exchangeName(o.waitLongExchange)}/{exchangeName(o.waitShortExchange)} spread → 0
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 text-xs text-negative hover:text-negative/85"
                      onClick={() => onCancel(o.id)}
                    >
                      <X aria-hidden className="size-3" />
                      Cancel
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            {tab === "history" &&
              history.map((o) => (
                <TableRow key={o.id} className="hover:bg-muted/30">
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {fmtTime(o.time)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {o.hedgeId && <Link2 className="mr-1 inline size-3 text-info" />}
                    {o.pair}
                  </TableCell>
                  <TableCell className="text-xs">{exchangeName(o.exchange)}</TableCell>
                  <SideCell side={o.side} />
                  <TableCell className="text-xs uppercase">{o.orderType}</TableCell>
                  <SourceCell source={o.source} hedgeId={o.hedgeId} />
                  <TableCell className="text-xs uppercase">
                    {`Perp ${o.leverage}×`}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatPrice(o.price)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">{o.size}</TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-mono text-xs",
                      o.realizedPnl === undefined || o.realizedPnl === null
                        ? "text-muted-foreground"
                        : signClass(o.realizedPnl),
                    )}
                  >
                    {o.realizedPnl === undefined || o.realizedPnl === null
                      ? "—"
                      : formatSignedUsd(o.realizedPnl, 2)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={o.status} />
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** Names what placed the order: the strategy, or Manual. */
function SourceCell({
  source,
  hedgeId,
}: {
  source?: Order["source"];
  hedgeId?: string | null;
}) {
  const auto = source === "auto";
  return (
    <TableCell>
      <span
        className={cn(
          "inline-flex whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[10px]",
          auto ? "bg-info/15 text-info" : "bg-muted text-muted-foreground",
        )}
      >
        {sourceShort(source, hedgeId)}
      </span>
    </TableCell>
  );
}

function SideCell({ side }: { side: Order["side"] }) {  const isBuy = side === "buy";
  return (
    <TableCell>
      <span
        className={cn(
          "inline-flex items-center gap-1 font-mono text-xs",
          isBuy ? "text-positive" : "text-negative",
        )}
      >
        {isBuy ? "Buy" : "Sell"}
      </span>
    </TableCell>
  );
}

function StatusBadge({ status }: { status: OrderStatus }) {
  const map: Record<OrderStatus, string> = {
    pending: "text-warning-muted",
    open: "text-warning",
    partial: "text-info",
    filled: "text-positive",
    cancelled: "text-muted-foreground",
  };
  return (
    <Badge variant="secondary" className={cn("text-[10px] uppercase", map[status])}>
      {status}
    </Badge>
  );
}

function EmptyRow({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-8 text-center text-muted-foreground">
        {label}
      </TableCell>
    </TableRow>
  );
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function pct(filled: number, size: number): string {
  if (!size) return "0";
  return ((filled / size) * 100).toFixed(1);
}
