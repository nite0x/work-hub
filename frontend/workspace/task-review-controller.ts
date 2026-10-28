import type { ChangedFile, CleanupCandidate } from "./task-review"

interface Ports {
  document: Document
  environment: () => string
  request: <T>(path: string, options?: RequestInit & {environment?: string}) => Promise<T>
  mutation: (title: string, run: () => Promise<void>, error: HTMLElement, options?: {key?: string; project?: string; isCurrent?: () => boolean}) => Promise<void>
  toast: (message: string, error?: boolean) => void
  reviewMarkup: (items: CleanupCandidate[]) => string
  changesMarkup: (files: ChangedFile[], selected: string) => string
}

export function createTaskReviewController(ports: Ports) {
  const document = ports.document
  const window = document.defaultView!
  const node = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector(`#${id}`) as T
  const reviewDialog = node<HTMLDialogElement>("taskReviewDialog")
  const changesDialog = node<HTMLDialogElement>("changesDialog")
  let review: {id: string; environment: string; revision: number; items: CleanupCandidate[]} | undefined
  let changes: {project: string; path: string; environment: string; revision: number; files: ChangedFile[]; selected: string} | undefined
  let diffAbort: AbortController | undefined
  let reviewRevision = 0
  const showError = (id: string, error: unknown) => { node(id).textContent = error instanceof Error ? error.message : String(error); node(id).hidden = false }
  const reviewCurrent = (context: NonNullable<typeof review>) => review === context && reviewDialog.open
  const changesCurrent = (context: NonNullable<typeof changes>, revision = context.revision) => changes === context && changesDialog.open && context.revision === revision

  function syncSelection() {
    node<HTMLButtonElement>("taskReviewClean").disabled = !reviewDialog.querySelector('input[data-cleanup-index]:checked')
  }
  async function loadReview() {
    const context = review
    if (!context) return
    const revision = ++context.revision
    node("taskReviewError").hidden = true
    node("taskReviewItems").textContent = "正在检查当前项目和保留目录…"
    node<HTMLButtonElement>("taskReviewClean").disabled = true
    try {
      const result = await ports.request<{task: {name: string; state: string}; items: CleanupCandidate[]}>(`/api/requirements/${encodeURIComponent(context.id)}/review`, {environment: context.environment})
      if (!reviewCurrent(context) || context.revision !== revision) return
      context.items = result.items
      node("taskReviewTitle").textContent = "收尾检查 · " + result.task.name
      node("taskReviewItems").innerHTML = ports.reviewMarkup(result.items)
      node<HTMLButtonElement>("taskReviewArchive").hidden = result.task.state === "archived"
      syncSelection()
    } catch (error) {
      if (reviewCurrent(context) && context.revision === revision) {node("taskReviewItems").textContent = "检查未完成。"; showError("taskReviewError", error)}
    }
  }
  async function cleanSelected() {
    const context = review
    if (!context) return
    const selected = [...reviewDialog.querySelectorAll<HTMLInputElement>('input[data-cleanup-index]:checked')].map(input => context.items[Number(input.dataset.cleanupIndex)]).filter(item => item?.cleanable)
    if (!selected.length || !window.confirm(`清理以下 ${selected.length} 个 Worktree 目录？\n\n${selected.map(item => item.path + "\n分支：" + item.branch).join("\n\n")}\n\n目录会被移除，分支和会话记录保留。`)) return
    const failures: string[] = []
    const warnings: string[] = []
    let cleaned = 0
    await ports.mutation("正在清理所选 Worktree", async () => {
      for (const item of selected) {
        try {
          const result = await ports.request<{context_warning?: string}>(`/api/requirements/${encodeURIComponent(context.id)}/cleanup/${encodeURIComponent(item.project_id)}`, {environment: context.environment, method: "POST", body: JSON.stringify({path: item.path, fingerprint: item.fingerprint})})
          if (result.context_warning) warnings.push(item.path + "：" + result.context_warning)
          cleaned++
        } catch (error) { failures.push(item.path + "：" + (error instanceof Error ? error.message : String(error))) }
      }
      if (reviewCurrent(context)) await loadReview()
      ports.toast(`已清理 ${cleaned} 个目录${failures.length ? `，${failures.length} 个未完成` : "，分支和会话记录保留"}`, !!failures.length || !!warnings.length)
      if (failures.length || warnings.length) throw new Error([...failures,...warnings].join("\n"))
    }, node("taskReviewError"), {key: `task:${context.id}`, isCurrent: () => reviewCurrent(context)})
    syncSelection()
  }
  async function archiveReview() {
    const context = review
    if (!context) return
    await ports.mutation("正在归档任务", async () => {
      await ports.request(`/api/requirements/${encodeURIComponent(context.id)}/archive`, {environment: context.environment, method: "POST", body: JSON.stringify({archived: true})})
      if (reviewCurrent(context)) await loadReview()
    }, node("taskReviewError"), {key: `task:${context.id}`, isCurrent: () => reviewCurrent(context)})
    syncSelection()
  }
  function visibleFiles(context: NonNullable<typeof changes>) {
    return context.files.filter(file => node<HTMLSelectElement>("changesMode").value === "index" ? !file.untracked && file.index !== " " && file.index !== "?" : file.untracked || file.working !== " ")
  }
  async function selectFile(file: string) {
    const context = changes
    if (!context) return
    context.selected = file
    const revision = ++context.revision
    node("changesFiles").innerHTML = ports.changesMarkup(visibleFiles(context), file)
    node("changesText").textContent = file ? "正在读取差异…" : "此区域没有改动。"
    node("changesTruncated").hidden = true
    if (!file) return
    diffAbort?.abort(); diffAbort = new AbortController()
    const params = new URLSearchParams({path: context.path, file, mode: node<HTMLSelectElement>("changesMode").value})
    try {
      const result = await ports.request<{text: string; truncated: boolean}>(`/api/projects/${encodeURIComponent(context.project)}/changes?${params}`, {environment: context.environment, signal: diffAbort.signal})
      if (!changesCurrent(context, revision)) return
      node("changesError").hidden = true
      node("changesText").textContent = result.text
      node("changesTruncated").hidden = !result.truncated
    } catch (error) {if (changesCurrent(context, revision) && !(error instanceof DOMException && error.name === "AbortError")) {node("changesText").textContent = "无法读取此文件。"; showError("changesError", error)}}
  }
  async function loadChanges() {
    const context = changes
    if (!context) return
    const revision = ++context.revision
    diffAbort?.abort(); diffAbort = new AbortController()
    node("changesError").hidden = true
    node("changesFiles").textContent = "正在读取改动文件…"
    try {
      const result = await ports.request<{files: ChangedFile[]; branch: string}>(`/api/projects/${encodeURIComponent(context.project)}/changes?${new URLSearchParams({path: context.path})}`, {environment: context.environment, signal: diffAbort.signal})
      if (!changesCurrent(context, revision)) return
      context.files = result.files
      node("changesContext").textContent = `${context.path}\n${result.branch || "detached HEAD"} · 只读预览`
      const files = visibleFiles(context)
      await selectFile(files.find(file => file.path === context.selected)?.path || files[0]?.path || "")
    } catch (error) {if (changesCurrent(context, revision)) showError("changesError", error)}
  }
  node("taskReviewRefresh").addEventListener("click", () => void loadReview())
  node("taskReviewItems").addEventListener("change", syncSelection)
  node("taskReviewClean").addEventListener("click", () => void cleanSelected())
  node("taskReviewArchive").addEventListener("click", () => void archiveReview())
  reviewDialog.addEventListener("close", () => {review = undefined})
  node("changesRefresh").addEventListener("click", () => void loadChanges())
  node("changesMode").addEventListener("change", () => {if (changes) void selectFile(visibleFiles(changes)[0]?.path || "")})
  node("changesFiles").addEventListener("click", event => {const target = (event.target as HTMLElement).closest<HTMLElement>("[data-change-file]"); if (target) void selectFile(target.dataset.changeFile || "")})
  changesDialog.addEventListener("close", () => {diffAbort?.abort(); changes = undefined})
  return {
    openReview(id: string) {review = {id, environment: ports.environment(), revision: ++reviewRevision, items: []}; if (!reviewDialog.open) reviewDialog.showModal(); void loadReview()},
    openChanges(project: string,path: string) {changes = {project, path, environment: ports.environment(), revision: 0, files: [], selected: ""}; node<HTMLSelectElement>("changesMode").value = "working"; if (!changesDialog.open) changesDialog.showModal(); void loadChanges()},
  }
}
