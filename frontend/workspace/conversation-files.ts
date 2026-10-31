import { mountFileBrowser, type BrowserProps, type BrowserRequest } from "./file-browser"
import { setupSplitResize } from "./split-resize"
import { conversationPathKey } from "./conversation-runtime"

interface Context { session: string; path: string; environment: string; project?: string; additionalDirectories?: string[] }
interface FileReference { session: string; environment: string; path: string; line: number }

export function createConversationFiles(document: Document, request: BrowserRequest) {
  const window = document.defaultView!
  const node = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
  const host = node("sessionBrowser")
  const toggle = node<HTMLButtonElement>("toggleConversationFiles")
  const dock = node("conversationFilesDock")
  const pane = node("conversationFilesPane")
  const mount = node("conversationFilesMount")
  const fullscreen = node<HTMLDialogElement>("conversationFilesDialog")
  const resizeHandle = node("conversationFilesResize")
  const reading = node("sessionReadingLayout")
  const expand = node<HTMLButtonElement>("expandConversationFiles")
  let current: Context | undefined
  let identity = ""
  let wanted = false
  let expanded = false
  let readingRevision = 0
  let referenceVersion = 0
  let props: BrowserProps | undefined
  const layout = (before: boolean) => window.dispatchEvent(new window.CustomEvent("workhub:chat-layout", {detail: before ? {phase: "before"} : {visible: true}}))

  function readingPosition() {
    const revision = ++readingRevision
    const key = identity
    const positions = [...mount.querySelectorAll<HTMLElement>(".changes-text,.browser-files")].map(element => ({element,top:element.scrollTop,left:element.scrollLeft}))
    return () => {
      const apply = () => {
        if (revision !== readingRevision || key !== identity) return
        for (const {element,top,left} of positions) if (element.isConnected) {element.scrollTop=top;element.scrollLeft=left}
      }
      apply()
      window.requestAnimationFrame(() => {apply();window.requestAnimationFrame(apply)})
    }
  }
  function restore(focus = false) {
    if (!expanded) return
    layout(true)
    const restoreReading = readingPosition()
    expanded = false
    if (fullscreen.open) fullscreen.close()
    dock.append(pane)
    pane.classList.remove("is-fullscreen")
    expand.textContent = "全屏"
    expand.setAttribute("aria-label", "全屏查看文件")
    expand.setAttribute("aria-pressed", "false")
    resizeHandle.hidden = !wanted || !current
    dock.hidden = !wanted || !current
    host.toggleAttribute("data-files-open", wanted && !!current)
    restoreReading()
    layout(false)
    if (focus) expand.focus({preventScroll: true})
  }
  function sync() {
    toggle.disabled = !current
    toggle.setAttribute("aria-expanded", String(wanted && !!current))
    resizeHandle.hidden = expanded || !wanted || !current
    dock.hidden = expanded || !wanted || !current
    host.toggleAttribute("data-files-open", wanted && !!current && !expanded)
  }
  function open() {
    if (!current || !props) return
    layout(true)
    wanted = true
    mountFileBrowser(mount, props)
    sync()
    layout(false)
  }
  function close() {
    layout(true)
    wanted = false
    restore()
    sync()
    layout(false)
    toggle.focus({preventScroll:true})
  }
  const widthKey = "workhub:conversation-files-width:v1"
  try { const saved = Number(window.localStorage.getItem(widthKey)); if (saved >= 320) reading.style.setProperty("--conversation-files-width", `${saved}px`) } catch { /* Optional storage. */ }
  const disposeResize = setupSplitResize({handle:resizeHandle,container:reading,panel:dock,axis:"x",direction:-1,
    bounds:()=>{const width=reading.getBoundingClientRect().width;return width>700?{min:320,max:width-328}:null},
    resize:width=>reading.style.setProperty("--conversation-files-width",`${width}px`),
    commit:()=>{try{window.localStorage.setItem(widthKey,reading.style.getPropertyValue("--conversation-files-width").replace("px",""))}catch{/* Optional storage. */}},
    before:()=>layout(true),after:()=>layout(false),
  })
  window.addEventListener("pagehide",disposeResize,{once:true})
  toggle.addEventListener("click", () => wanted ? close() : open())
  node("closeConversationFiles").addEventListener("click", close)
  expand.addEventListener("click", () => {
    if (expanded) { restore(true); return }
    if (!current || !wanted) return
    layout(true)
    const restoreReading = readingPosition()
    expanded = true
    fullscreen.append(pane)
    pane.classList.add("is-fullscreen")
    expand.textContent = "还原"
    expand.setAttribute("aria-label", "还原到对话旁")
    expand.setAttribute("aria-pressed", "true")
    sync()
    fullscreen.showModal()
    restoreReading()
    layout(false)
  })
  fullscreen.addEventListener("cancel", event => { event.preventDefault(); restore(true) })
  fullscreen.addEventListener("close", () => { if (!fullscreen.open) restore() })
  window.addEventListener("workhub:open-file", event => {
    const detail = (event as CustomEvent<FileReference>).detail
    if (!current || detail.session !== current.session || detail.environment !== current.environment) return
    const normalized = detail.path.replace(/\\/g, "/")
    const absolute = /^(?:\/|[a-z]:\/)/i.test(normalized)
    const roots = [current.path, ...(current.additionalDirectories || [])]
    const path = absolute ? roots.sort((a, b) => b.length - a.length).find(root => {
      const key = conversationPathKey(root)
      return conversationPathKey(normalized).startsWith(key === "/" ? "/" : key + "/")
    }) : current.path
    if (!path) return
    const root = conversationPathKey(path)
    const relative = absolute ? normalized.slice(root === "/" ? 1 : root.length + 1) : normalized.replace(/^\.\//, "")
    if (!relative || relative.split("/").some(part => part === ".." || part.toLowerCase() === ".git")) return
    const changedRoot = props?.path !== path
    props = { ...props!, path, project: path === current.path ? current.project : undefined, reference: {path: relative, line: detail.line, version: ++referenceVersion} }
    restore()
    if (changedRoot) mountFileBrowser(mount)
    event.preventDefault()
    open()
  })
  return {
    setContext(context?: Context) {
      const key = context ? JSON.stringify([context.environment, context.session, context.path, context.additionalDirectories || []]) : ""
      if (key === identity) {
        if (context && current?.project !== context.project) {
          current = context
          props = {...props!,project:props?.path === context.path ? context.project : undefined}
          if (wanted) mountFileBrowser(mount,props)
        }
        return
      }
      restore()
      identity = key
      current = context
      mountFileBrowser(mount)
      props = context ? {...context, request, idPrefix: "conversationFiles", initialMode: "all"} : undefined
      if (wanted && current) open()
      sync()
    },
  }
}
