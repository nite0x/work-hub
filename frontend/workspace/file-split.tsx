import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { setupSplitResize } from "./split-resize"

const storageKey = "workhub:file-tree-size:v1"
export function FileSplit({ tree, children }: {tree: ReactNode; children: ReactNode}) {
  const host = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const handle = useRef<HTMLDivElement>(null)
  const [stacked,setStacked] = useState(false)
  const [size,setSize] = useState(() => {
    try { const value = JSON.parse(localStorage.getItem(storageKey) || "{}"); return {width:Number(value.width) || 220,height:Number(value.height) || 150} }
    catch { return {width:220,height:150} }
  })
  const latest = useRef(size); latest.current = size
  useLayoutEffect(() => {
    const element=host.current!
    const measure=()=>{ if(element.clientWidth) setStacked(element.clientWidth<=650) }
    const observer=typeof ResizeObserver==="undefined"?undefined:new ResizeObserver(measure)
    observer?.observe(element);measure()
    return ()=>observer?.disconnect()
  },[])
  useLayoutEffect(() => setupSplitResize({
    handle:handle.current!, container:host.current!, panel:list.current!, axis:stacked?"y":"x",
    bounds:()=>{const total=host.current!.getBoundingClientRect()[stacked?"height":"width"];return total>0?{min:stacked?70:130,max:Math.max(stacked?70:130,total*(stacked?.5:.55))}:null},
    resize:value=>{const next={...latest.current,[stacked?"height":"width"]:value};latest.current=next;setSize(next)},
    commit:()=>{try{localStorage.setItem(storageKey,JSON.stringify(latest.current))}catch{/* Optional storage. */}},
  }),[stacked])
  return <div ref={host} className="changes-layout file-split-layout" data-stacked={stacked} style={{"--file-tree-width":`${size.width}px`,"--file-tree-height":`${size.height}px`} as React.CSSProperties}>
    <div ref={list} className="file-tree-pane">{tree}</div>
    <div ref={handle} className="reading-splitter" role="separator" tabIndex={0} aria-label="调整文件树与内容区域大小" aria-orientation={stacked?"horizontal":"vertical"} />
    {children}
  </div>
}
