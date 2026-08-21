"use client";

import { Suspense } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/page-skeleton";
import {
  SHARED_MECHANICS,
  STRATEGY_COMPARISON,
  STRATEGY_DOCS,
  STRATEGY_DOC_ORDER,
  type StrategyDoc,
} from "@/lib/strategy-docs";
import { useTabParam } from "@/lib/hooks/use-tab-param";
import type { StrategyId } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  Ban,
  Coins,
  DoorOpen,
  PiggyBank,
  ShieldAlert,
  Sparkles,
  Target,
  Timer,
  TrendingUp,
} from "lucide-react";

const ICON: Record<StrategyId, typeof Coins> = {
  fundingsync: Coins,
  perpbridge: TrendingUp,
  fundingbridge: Timer,
  fundingyield: PiggyBank,
};

/** Which strategy the page is showing, plus the two cross-cutting views. */
type View = StrategyId | "compare" | "shared";

const VIEWS: readonly View[] = [...STRATEGY_DOC_ORDER, "compare", "shared"] as const;

function StrategyLibrary() {
  const [view, setView] = useTabParam<View>("s", VIEWS, "fundingyield");

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-6">
      <PageHeader
        title="Strategy Library"
        description="What each automated strategy earns from, how it decides, and how it can lose money."
      />

      {/* Picker. Buttons rather than Tabs: six entries of uneven length wrap badly in a
          segmented control, and two of them are not strategies. */}
      <div className="flex flex-wrap gap-1.5">
        {STRATEGY_DOC_ORDER.map((id) => {
          const doc = STRATEGY_DOCS[id];
          const Icon = ICON[id];
          const active = view === id;
          return (
            <Button
              key={id}
              variant={active ? "secondary" : "outline"}
              size="sm"
              aria-pressed={active}
              className="h-8 gap-1.5 text-xs"
              onClick={() => setView(id)}
            >
              <Icon aria-hidden className="size-3.5" />
              {doc.name}
            </Button>
          );
        })}
        <span aria-hidden className="mx-1 h-8 w-px bg-border" />
        <Button
          variant={view === "compare" ? "secondary" : "outline"}
          size="sm"
          aria-pressed={view === "compare"}
          className="h-8 gap-1.5 text-xs"
          onClick={() => setView("compare")}
        >
          <Sparkles aria-hidden className="size-3.5" />
          Compare
        </Button>
        <Button
          variant={view === "shared" ? "secondary" : "outline"}
          size="sm"
          aria-pressed={view === "shared"}
          className="h-8 gap-1.5 text-xs"
          onClick={() => setView("shared")}
        >
          Shared mechanics
        </Button>
      </div>

      {view === "compare" ? (
        <ComparisonView />
      ) : view === "shared" ? (
        <SharedView />
      ) : (
        <StrategyView doc={STRATEGY_DOCS[view]} />
      )}
    </div>
  );
}

function StrategyView({ doc }: { doc: StrategyDoc }) {
  const Icon = ICON[doc.id];
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="py-3">
          <div className="flex items-center gap-2">
            <Icon aria-hidden className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">{doc.name}</CardTitle>
            <Badge variant="secondary" className="text-[10px]">
              {doc.tagline}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed">{doc.overview}</p>
          <Separator />
          <div className="flex flex-col gap-1.5">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Where the money comes from
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{doc.edge}</p>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Flow, numbered because the order is the strategy */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-2 py-3">
            <ArrowRight aria-hidden className="size-3.5 text-info" />
            <CardTitle className="text-sm">How it works, step by step</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col gap-2.5">
              {doc.flow.map((step, i) => (
                <li key={step} className="flex gap-2.5 text-xs leading-relaxed">
                  <span className="mt-px shrink-0 font-mono num text-muted-foreground">
                    {i + 1}.
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        {/* Exits */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-2 py-3">
            <DoorOpen aria-hidden className="size-3.5 text-positive" />
            <CardTitle className="text-sm">How a position ends</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="flex flex-col gap-3">
              {doc.exits.map((exit) => (
                <div key={exit.title} className="flex flex-col gap-0.5">
                  <dt className="text-xs font-medium">{exit.title}</dt>
                  <dd className="text-xs leading-relaxed text-muted-foreground">{exit.detail}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        {/* What it ignores */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-2 py-3">
            <Ban aria-hidden className="size-3.5 text-muted-foreground" />
            <CardTitle className="text-sm">What it deliberately ignores</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2">
              {doc.ignores.map((entry) => (
                <li key={entry} className="text-xs leading-relaxed text-muted-foreground">
                  {entry}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {/* Risks — the honest section */}
        <Card className="border-negative/20">
          <CardHeader className="flex flex-row items-center gap-2 py-3">
            <ShieldAlert aria-hidden className="size-3.5 text-negative" />
            <CardTitle className="text-sm">How it loses money</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2">
              {doc.risks.map((entry) => (
                <li key={entry} className="text-xs leading-relaxed text-muted-foreground">
                  {entry}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      {/* Long-form sections, when a strategy has arithmetic worth showing */}
      {doc.sections?.map((section) => (
        <Card key={section.heading}>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">{section.heading}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            {section.body.map((paragraph) => (
              <p key={paragraph} className="text-xs leading-relaxed text-muted-foreground">
                {paragraph}
              </p>
            ))}
          </CardContent>
        </Card>
      ))}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center gap-2 py-3">
            <Target aria-hidden className="size-3.5 text-info" />
            <CardTitle className="text-sm">When to use it</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2">
              {doc.suitedTo.map((entry) => (
                <li key={entry} className="text-xs leading-relaxed text-muted-foreground">
                  {entry}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Settings that decide its behaviour</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="flex flex-col gap-2.5">
              {doc.keySettings.map((setting) => (
                <div key={setting.name} className="flex flex-col gap-0.5">
                  <dt className="font-mono text-[11px]">{setting.name}</dt>
                  <dd className="text-xs leading-relaxed text-muted-foreground">
                    {setting.detail}
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ComparisonView() {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Side by side</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table stickyHeader stickyFirstColumn>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 min-w-[9rem]">Aspect</TableHead>
                {STRATEGY_DOC_ORDER.map((id) => (
                  <TableHead key={id} className="h-8">
                    {STRATEGY_DOCS[id].name}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {STRATEGY_COMPARISON.map((row) => (
                <TableRow key={row.aspect}>
                  <TableCell className="text-xs font-medium">{row.aspect}</TableCell>
                  {STRATEGY_DOC_ORDER.map((id) => {
                    const value = row.values[id];
                    // "Yes" on a guard row is the notable answer, "No" the notable absence.
                    // Colouring both makes the guard rows readable at a glance without a
                    // legend, and the text carries the meaning on its own regardless.
                    const tone =
                      value === "Yes"
                        ? "text-positive"
                        : value === "No" || value === "None"
                          ? "text-negative"
                          : "text-muted-foreground";
                    return (
                      <TableCell key={id} className={cn("text-xs", tone)}>
                        {value}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Reading this table</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2.5">
          <p className="text-xs leading-relaxed text-muted-foreground">
            The three funding strategies are not variations of one another. FundingSync and
            FundingBridge collect the same edge and differ only in when they look at price;
            FundingYield collects that edge from positions the other two structurally refuse,
            because it treats the entry spread as a cost to be measured rather than a threshold to
            be cleared.
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            PerpBridge is the outlier: it never reads a funding rate. When funding is flat
            everywhere it is the only one of the four with anything to do.
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The stop-loss row is the one worth pausing on. Three strategies have none, and can
            afford not to because a settlement or a hold limit eventually forces them out —
            PerpBridge being the exception, where a widening gap genuinely has no exit.
            FundingYield holds for days by design, so it carries the only real loss limit here.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function SharedView() {
  return (
    <div className="flex flex-col gap-4">
      {SHARED_MECHANICS.map((section) => (
        <Card key={section.heading}>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">{section.heading}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            {section.body.map((paragraph) => (
              <p key={paragraph} className="text-xs leading-relaxed text-muted-foreground">
                {paragraph}
              </p>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function StrategyLibraryPage() {
  // The view is kept in the URL, so a specific strategy's page can be linked. That needs
  // a Suspense boundary above useSearchParams.
  return (
    <Suspense fallback={<PageSkeleton cards={0} rows={6} filters={false} />}>
      <StrategyLibrary />
    </Suspense>
  );
}
