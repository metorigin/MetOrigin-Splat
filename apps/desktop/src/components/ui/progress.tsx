/* Jan progress.tsx, b8d58255baf6d9e870025d3f0c60a5b80a63143b.
 * Copyright 2025 Menlo Research. Apache-2.0, see licenses/jan-LICENSE.
 * Merged with prior shadcn/ui MIT source (LICENSE); local changes: ui-sources.json. */
"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Progress as ProgressPrimitive } from "radix-ui"

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      value={value ?? null}
      data-slot="progress"
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-secondary",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn("h-full w-full flex-1 bg-primary transition-transform", value == null && "w-1/3 motion-safe:animate-pulse")}
        style={{ transform: `translateX(-${100 - (value == null ? 100 : Math.max(0, Math.min(100, value)))}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
