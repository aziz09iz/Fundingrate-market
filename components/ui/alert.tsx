import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { CheckCircle2, Info, TriangleAlert, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Inline status banner for messages that must stay attached to the thing they
 * describe — a form that failed validation, a scope that cannot quote a hedge.
 * Transient results of an action belong in a toast instead.
 *
 * `error` and `warning` render as live regions: before this existed the app had
 * fifteen copies of a red paragraph, none of which were announced, so a failed
 * submit was silent to anyone not looking at that part of the screen.
 */
const alertVariants = cva(
  "relative flex w-full items-start gap-2 rounded-md border px-3 py-2 text-xs",
  {
    variants: {
      variant: {
        error: "border-negative/30 bg-negative/5 text-negative",
        warning: "border-warning/30 bg-warning/5 text-warning",
        success: "border-positive/30 bg-positive/5 text-positive",
        info: "border-info/30 bg-info/5 text-info",
        neutral: "border-border bg-muted/30 text-muted-foreground",
      },
    },
    defaultVariants: { variant: "error" },
  },
);

const VARIANT_ICON = {
  error: XCircle,
  warning: TriangleAlert,
  success: CheckCircle2,
  info: Info,
  neutral: Info,
} as const;

interface AlertProps
  extends React.ComponentProps<"div">,
    VariantProps<typeof alertVariants> {
  /** Hides the leading icon for dense rows where the colour is enough. */
  hideIcon?: boolean;
}

function Alert({ className, variant = "error", hideIcon, children, ...props }: AlertProps) {
  const resolved = variant ?? "error";
  const Icon = VARIANT_ICON[resolved];
  const assertive = resolved === "error" || resolved === "warning";
  return (
    <div
      data-slot="alert"
      role={assertive ? "alert" : "status"}
      aria-live={assertive ? "assertive" : "polite"}
      className={cn(alertVariants({ variant: resolved }), className)}
      {...props}
    >
      {!hideIcon && <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="alert-title" className={cn("font-medium", className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, alertVariants };
