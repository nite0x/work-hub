import { useEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react"
import { FileTypeIcon } from "@/components/file-type-icon"
import { FileSplit } from "./file-split"
import { Button } from "@/components/ui/button"
import { NativeSelect, Option, Action } from "./shared"
import type { ChangedFile } from "./task-review"
import type { FileDisplay, FilePreview } from "./file-display"

export type BrowserRequest = <T>(path: string, options?: RequestInit & {environment?: string}) => Promise<T>
export interface BrowserProps { project?: string; session?: string; path: string; environment: string; request: BrowserRequest; idPrefix?: string; initialMode?: string; reference?: {path: string; line: number; version: number} }
interface Entry { name: string; path: string; directory: boolean; symlink?: boolean }
interface Directory { entries: Entry[]; truncated: boolean }
let displayPromise: Promise<FileDisplay> | undefined
function loadDisplay() {
  const host = window as Window & { WorkHubFileDisplay?: FileDisplay }
  if (host.WorkHubFileDisplay) return Promise.resolve(host.WorkHubFileDisplay)
  if (!displayPromise) displayPromise = new Promise<FileDisplay>((resolve, reject) => {
    const script = document.createElement("script")
    script.type = "module"
    script.src = "/ui/files/file-display.js"
    script.onload = () => host.WorkHubFileDisplay ? resolve(host.WorkHubFileDisplay) : reject(new Error("文件查看器未就绪"))
    script.onerror = () => { script.remove(); reject(new Error("文件查看器加载失败，请重试")) }
    document.head.append(script)
  }).catch(error => { displayPromise = undefined; throw error })
  return displayPromise
}

function Preview({ preview, split, id }: { preview: FilePreview; split: boolean; id: string }) {
  const target = useRef<HTMLDivElement>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    const container = target.current!
    let active = true
    let dispose: (() => void) | undefined
    setError("")
    // Partial patches may be invalid; show their bounded output as plain text.
    if (preview.truncated || !preview.format || preview.format === "text") {
      container.textContent = preview.text
      return () => { container.replaceChildren() }
    }
    container.textContent = "正在加载文件查看器…"
    void loadDisplay().then(display => {
      if (!active) return
      container.replaceChildren()
      dispose = display.render(container, preview, split)
    }).catch(error => {
      if (!active) return
      container.textContent = preview.text
      setError(error instanceof Error ? error.message : String(error))
    })
    return () => { active = false; dispose?.(); container.replaceChildren() }
  }, [preview, split])
  return <>{error && <p role="status" className="quiet">{error}，已显示纯文本内容。</p>}<div ref={target} id={id} className="changes-text" tabIndex={0} aria-label="只读文件内容与差异" /></>
}

function DirectoryTree({ directory = "", selected, choose, request, endpoint, environment, depth = 0 }: {
  directory?: string; selected: string; choose: (file: string) => void; request: BrowserRequest; endpoint: string; environment: string; depth?: number
}) {
  const [data, setData] = useState<Directory>()
  const [error, setError] = useState("")
  const [expanded, setExpanded] = useState<string[]>([])
  useEffect(() => {
    const segments = selected.split("/").slice(0, -1)
    const parents = segments.map((_, index) => segments.slice(0, index + 1).join("/"))
    setExpanded(values => [...new Set([...values, ...parents])])
  }, [selected])
  useEffect(() => {
    const abort = new AbortController()
    let active = true
    void request<Directory>(`${endpoint}&${new URLSearchParams({dir: directory})}`, { environment, signal: abort.signal })
      .then(value => { if (active) setData(value) })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)) })
    return () => { active = false; abort.abort() }
  }, [directory, endpoint, environment, request])
  if (error) return <p role="alert">{error}</p>
  if (!data) return <p role="status" className="quiet">正在读取目录…</p>
  return <ul className="browser-tree">{data.entries.map(entry => <li key={entry.path}>
    <Button type="button" variant={selected === entry.path ? "secondary" : "ghost"} className="browser-tree-entry justify-start text-left font-normal [&&]:pl-[var(--tree-indent)]" style={{ "--tree-indent": `${8 + depth * 16}px` } as React.CSSProperties}
      disabled={entry.symlink} title={entry.symlink ? `${entry.path} · 符号链接请在 IDE 中打开` : entry.path}
      aria-expanded={entry.directory ? expanded.includes(entry.path) : undefined} aria-pressed={entry.directory ? undefined : selected === entry.path}
      data-change-file={entry.directory ? undefined : entry.path}
      onClick={() => entry.directory ? setExpanded(values => values.includes(entry.path) ? values.filter(value => value !== entry.path) : [...values, entry.path]) : choose(entry.path)}>
      {entry.directory ? <>{expanded.includes(entry.path) ? <ChevronDown /> : <ChevronRight />}{expanded.includes(entry.path) ? <FolderOpen className="browser-folder is-open" /> : <Folder className="browser-folder" />}</> : <FileTypeIcon path={entry.path} />}<span>{entry.name}</span>{entry.symlink && <span>↗</span>}
    </Button>
    {entry.directory && expanded.includes(entry.path) && <DirectoryTree directory={entry.path} selected={selected} choose={choose} request={request} endpoint={endpoint} environment={environment} depth={depth + 1} />}
  </li>)}{!data.entries.length && <li className="quiet">空目录</li>}{data.truncated && <li role="status">目录超过 5000 项，请在 IDE 中查看完整列表。</li>}</ul>
}

function FileBrowser({ project, session, path, environment, request, idPrefix = "changes", initialMode = "working", reference }: BrowserProps) {
  const [mode, setMode] = useState(project ? initialMode : "all")
  const [files, setFiles] = useState<ChangedFile[]>([])
  const [selected, setSelected] = useState("")
  const [preview, setPreview] = useState<FilePreview>()
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [listing, setListing] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [split, setSplit] = useState(true)
  const [branch, setBranch] = useState("")
  const endpoint = `/api/projects/${encodeURIComponent(project || "")}`
  const filesEndpoint = session ? `/api/sessions/${encodeURIComponent(session)}/files` : `${endpoint}/files`
  useEffect(() => {
    if (reference) { setMode("all"); setSelected(reference.path) }
  }, [reference])
  const previewEndpoint = mode === "all" ? filesEndpoint : `${endpoint}/changes`
  const query = new URLSearchParams({ path })
  const visible = files.filter(file => mode === "index" ? !file.untracked && file.index !== " " && file.index !== "?" : file.untracked || file.working !== " ")
  useEffect(() => {
    if (mode === "all") return
    let active = true
    const abort = new AbortController()
    setListing(true); setError("")
    void request<{ files: ChangedFile[]; branch: string }>(`${endpoint}/changes?${query}`, { environment, signal: abort.signal }).then(data => {
      if (!active) return
      setFiles(data.files); setBranch(data.branch)
      const choices = data.files.filter(file => mode === "index" ? !file.untracked && file.index !== " " && file.index !== "?" : file.untracked || file.working !== " ")
      setSelected(value => choices.some(file => file.path === value) ? value : choices[0]?.path || "")
    }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (active) setListing(false) })
    return () => { active = false; abort.abort() }
  }, [endpoint, path, environment, mode, refresh, request])
  useEffect(() => {
    setPreview(undefined)
    if (!selected) { setLoading(false); return }
    let active = true
    const abort = new AbortController()
    setLoading(true); setError("")
    const params = new URLSearchParams({ path, file: selected, mode })
    void request<FilePreview>(`${previewEndpoint}?${params}`, { environment, signal: abort.signal }).then(data => {
      if (active) setPreview({ ...data, name: selected, format: mode === "all" ? "file" : data.format, line: reference?.path === selected ? reference.line : undefined })
    }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; abort.abort() }
  }, [previewEndpoint, path, environment, mode, selected, refresh, request, reference])
  return <div className="file-browser" data-mode={mode}>
    <p id={`${idPrefix}Context`} className="dialog-description break-all" title={path}>{path}{branch ? ` · ${branch}` : ""} · 只读</p>
    <div className="changes-controls"><label htmlFor={`${idPrefix}Mode`}>查看</label><NativeSelect id={`${idPrefix}Mode`} value={mode} onChange={event => { setMode(event.target.value); setSelected(""); setFiles([]); setPreview(undefined); setError("") }}>
      <Option value="all">全部文件</Option>{project && <><Option value="working">修改文件 · 工作区（含未跟踪）</Option><Option value="index">修改文件 · 暂存区</Option></>}
    </NativeSelect><Button type="button" variant="outline" id={`${idPrefix}Refresh`} onClick={() => setRefresh(value => value + 1)}>刷新</Button>
      <label htmlFor={`${idPrefix}Layout`}>差异布局</label><NativeSelect id={`${idPrefix}Layout`} value={split ? "split" : "unified"} onChange={event => setSplit(event.target.value === "split")} disabled={mode === "all"}><Option value="split">并排</Option><Option value="unified">统一</Option></NativeSelect>
      {project && <Action action="project-open-vscode" id={project} data-path={path}>在 VS Code 中打开 ↗</Action>}
    </div>
    <FileSplit tree={<nav className="browser-files" id={`${idPrefix}Files`} aria-label={mode === "all" ? "全部文件" : "改动文件"}>
      {mode === "all" ? <DirectoryTree key={refresh} selected={selected} choose={setSelected} request={request} endpoint={`${filesEndpoint}?${query}`} environment={environment} /> : listing ? <p role="status">正在读取改动文件…</p> : <div className="changes-file-list">{visible.length ? visible.map(file => <Button type="button" key={file.path} variant={file.path === selected ? "secondary" : "ghost"} className="h-auto w-full justify-start whitespace-normal text-left break-all" data-change-file={file.path} aria-pressed={file.path === selected} onClick={() => setSelected(file.path)}><FileTypeIcon path={file.path} /><code className="shrink-0 browser-change-status" data-status={file.untracked || file.index === "A" ? "added" : file.index === "D" || file.working === "D" ? "deleted" : "modified"}>{file.untracked ? "??" : `${file.index}${file.working}`}</code><span>{file.previous ? `${file.previous} → ` : ""}{file.path}</span></Button>) : <p className="quiet">此区域没有改动。</p>}</div>}
    </nav>}><div className="min-w-0 browser-content"><p id={`${idPrefix}Truncated`} role="status" hidden={!preview?.truncated}>差异超过 256 KiB，已显示部分纯文本；请在 IDE 中查看完整内容。</p>
      {preview ? <Preview preview={preview} split={split} id={`${idPrefix}Text`} /> : <div id={`${idPrefix}Text`} className="changes-text" role="status">{loading ? "正在读取文件…" : error ? "无法预览此文件，请在 IDE 中打开。" : mode === "all" ? "选择文件查看内容。" : "选择修改文件查看差异。"}</div>}
    </div></FileSplit><p id={`${idPrefix}Error`} role="alert" hidden={!error}>{error}</p>
  </div>
}

const mounts = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>()
export function mountFileBrowser(container: HTMLElement, props?: BrowserProps) {
  let root = mounts.get(container)
  if (!root) { root = createRoot(container); mounts.set(container, root) }
  flushSync(() => root.render(props ? <FileBrowser {...props} /> : null))
}
