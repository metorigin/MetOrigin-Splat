/* Jan separator.tsx, b8d58255baf6d9e870025d3f0c60a5b80a63143b.
 * Copyright 2025 Menlo Research. Apache-2.0, see licenses/jan-LICENSE.
 * Merged with prior shadcn/ui MIT source (LICENSE); local changes: ui-sources.json. */
"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Separator as SeparatorPrimitive } from "radix-ui"

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
