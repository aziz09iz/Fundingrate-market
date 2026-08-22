"use client";

import { useState, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface HoverTooltipProps {
  /** The always-rendered trigger content. */
  children: ReactNode;
  /** Built only once the pointer or keyboard actually arrives. */
  content: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  contentClassName?: string;
}

/**
 * A tooltip whose machinery is not created until someone reaches for it.
 *
 * The funding board puts a tooltip on every rate cell, which was free at sixty rows
 * and is not at two hundred and fifty: eight venue columns plus the spread column is
 * roughly two thousand tooltip instances, each with its own positioner and portal,
 * rebuilt whenever the page changes. Beyond the cost, they all register with the shared
 * provider during render, and that turned a 1 Hz frame into a render-phase update
 * cascade — React reported both "Maximum update depth exceeded" and "Cannot update a
 * component while rendering a different component" from inside the trigger.
 *
 * So the trigger is a plain element until the first `pointerenter` or `focus`, and only
 * then becomes a real tooltip. The hover that reveals a tooltip is also the hover that
 * builds it, so nothing is lost except the work nobody asked for.
 */
export function HoverTooltip({
  children,
  content,
  side = "top",
  className,
  contentClassName,
}: HoverTooltipProps) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <span
        className={className}
        onPointerEnter={() => setArmed(true)}
        onFocus={() => setArmed(true)}
        tabIndex={0}
      >
        {children}
      </span>
    );
  }

  return (
    <Tooltip defaultOpen>
      <TooltipTrigger render={<span className={className} />}>{children}</TooltipTrigger>
      <TooltipContent side={side} className={contentClassName}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
}
