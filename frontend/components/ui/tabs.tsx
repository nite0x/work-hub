import type { ComponentProps } from "react"
import { Tabs as TabsPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-2", className)} {...props} />
}

function TabsList({ className, variant = "default", ...props }: ComponentProps<typeof TabsPrimitive.List> & { variant?: "default" | "line" }) {
  return <TabsPrimitive.List data-slot="tabs-list" data-variant={variant}
    className={cn("inline-flex w-fit items-center text-muted-foreground", variant === "line" ? "bg-transparent" : "h-9 rounded-lg bg-muted p-1", className)} {...props} />
}

function TabsTrigger({ className, variant = "default", ...props }: ComponentProps<typeof TabsPrimitive.Trigger> & { variant?: "default" | "plain" }) {
  return <TabsPrimitive.Trigger data-slot="tabs-trigger"
    className={cn("outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50", variant === "default" && "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-colors data-[state=active]:bg-background data-[state=active]:text-foreground", className)} {...props} />
}

function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("min-w-0 flex-1 outline-none", className)} {...props} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
