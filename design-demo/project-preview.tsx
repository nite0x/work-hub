import { useEffect, useRef, useState, type ComponentProps, type CSSProperties } from "react"
import { Projects } from "@/workspace/projects"

// Keep React in control of the preview DOM; the production resizer moves native
// controller-owned nodes and cannot safely be mounted around this React tree.
export function ProjectPreview(props: ComponentProps<typeof Projects>) {
  const [width, setWidth] = useState(248)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const clamp = (value: number) => Math.max(200, Math.min(640, value))
  useEffect(() => {
    const separator = host.current?.querySelector("[data-project-resize]")
    separator?.setAttribute("aria-valuenow", String(width))
    separator?.setAttribute("aria-valuemin", "200")
    separator?.setAttribute("aria-valuemax", "640")
  }, [width])
  return <div ref={host} className="demo-project-preview" style={{ "--project-list-width": `${width}px` } as CSSProperties}
    onPointerDown={e => {
      const separator = (e.target as HTMLElement).closest<HTMLElement>("[data-project-resize]")
      if (!separator) return
      e.preventDefault(); separator.focus(); separator.setPointerCapture(e.pointerId)
      drag.current = { x: e.clientX, width }
    }}
    onPointerMove={e => { if (drag.current) setWidth(clamp(drag.current.width + e.clientX - drag.current.x)) }}
    onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
    onKeyDown={e => {
      if (!(e.target as HTMLElement).matches("[data-project-resize]") || !["ArrowLeft", "ArrowRight"].includes(e.key)) return
      e.preventDefault(); setWidth(v => clamp(v + (e.key === "ArrowLeft" ? -20 : 20)))
    }}><Projects {...props} /></div>
}
