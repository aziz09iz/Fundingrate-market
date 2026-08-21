"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Toast host. The app is rendered with a hardcoded `dark` class on <html>, so
 * the theme is fixed rather than read from a provider, and the surfaces are
 * mapped onto the app's own tokens so toasts match cards instead of shipping
 * sonner's default palette.
 */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      closeButton
      // Financial confirmations are worth reading; the default 4s is short for a
      // fill notice that names a venue, a size and a price.
      duration={6000}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--popover)",
          "--success-text": "var(--positive)",
          "--success-border": "color-mix(in oklab, var(--positive) 35%, var(--border))",
          "--error-bg": "var(--popover)",
          "--error-text": "var(--negative)",
          "--error-border": "color-mix(in oklab, var(--negative) 35%, var(--border))",
          "--warning-bg": "var(--popover)",
          "--warning-text": "var(--warning)",
          "--warning-border": "color-mix(in oklab, var(--warning) 35%, var(--border))",
          "--info-bg": "var(--popover)",
          "--info-text": "var(--info)",
          "--info-border": "color-mix(in oklab, var(--info) 35%, var(--border))",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "font-sans text-xs",
          description: "text-muted-foreground",
          actionButton: "font-medium",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
