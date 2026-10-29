import { test } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { MessageChannel } from "node:worker_threads"
import vm from "node:vm"
import { buildSync } from "esbuild"
import { JSDOM } from "jsdom"

const repository = fileURLToPath(new URL("../", import.meta.url))
const bundle = buildSync({
  entryPoints: [fileURLToPath(new URL("../frontend/workspace/git-interactive.tsx", import.meta.url))],
  absWorkingDir: repository, bundle: true, write: false, format: "iife", globalName: "GitUITest",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
}).outputFiles[0].text
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }

test("Git tabs keep controller-owned fields, context and draft values mounted across navigation and refresh", async t => {
  const dom = new JSDOM('<dialog open><div id="mount"></div></dialog>', { url: "http://localhost", runScripts: "outside-only", pretendToBeVisual: true })
  const channels: MessageChannel[] = []
  const { window } = dom
  Object.assign(window, { TextEncoder, TextDecoder, CSS: { escape: (value: string) => value }, MessageChannel: class extends MessageChannel { constructor() { super(); channels.push(this) } } })
  window.HTMLElement.prototype.scrollIntoView = () => {}
  t.after(() => { dom.window.close(); channels.forEach(channel => { channel.port1.close(); channel.port2.close() }) })
  vm.runInContext(bundle, dom.getInternalVMContext())
  const api = (window as any).GitUITest
  const mount = window.document.getElementById("mount")!
  const overview = {
    project: { id: "app", name: "App", path: "/repo/app", worktrees: [{ path: "/repo/app", branch: "main" }, { path: "/work/task/app", branch: "feature/task" }] },
    remotes: [{ name: "origin", url: "example.invalid/repo" }],
    branches: [{ name: "main", ref: "refs/heads/main", kind: "local", commit: "12345678", worktrees: ["/repo/app"] }, { name: "feature/task", ref: "refs/heads/feature/task", kind: "local", commit: "87654321", worktrees: ["/work/task/app"] }],
  }
  api.mountGitView(mount, overview)
  const branch = window.document.getElementById("gitBranchName") as HTMLInputElement
  const context = window.document.getElementById("gitContext")!
  const worktree = window.document.getElementById("gitWorktree") as HTMLSelectElement
  branch.value = "feature/draft"
  context.textContent = "当前分支 feature/task"
  worktree.value = "/work/task/app"
  const tabs = () => [...mount.querySelectorAll('[role="tab"]')]
  assert.equal(tabs().find(tab => tab.getAttribute("aria-selected") === "true")?.textContent, "同步")
  assert.equal(mount.querySelectorAll('[role="tabpanel"]').length, 3)
  api.selectGitTab(mount, "branches")
  assert.equal(tabs().find(tab => tab.getAttribute("aria-selected") === "true")?.textContent, "分支")
  assert.equal(window.document.getElementById("gitBranchName"), branch)
  assert.equal(branch.value, "feature/draft")
  assert.equal(worktree.value, "/work/task/app")
  assert.equal(context.textContent, "当前分支 feature/task")
  api.selectGitTab(mount, "merge")
  assert.equal(mount.querySelector('[data-state="active"][role="tabpanel"]')?.contains(window.document.getElementById("gitMergeSource")), true)
  assert.equal(window.document.getElementById("gitBranchName"), branch)
  api.mountGitView(mount, { ...overview, current: "feature/task" })
  assert.equal(tabs().find(tab => tab.getAttribute("aria-selected") === "true")?.textContent, "合并")
  assert.equal(branch.value, "feature/draft")
  assert.equal(context.textContent, "当前分支 feature/task")
  api.selectGitTab(mount, "sync")
  const firstTab = tabs()[0] as HTMLElement
  firstTab.focus()
  firstTab.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
  await settle()
  assert.equal(tabs().find(tab => tab.getAttribute("aria-selected") === "true")?.textContent, "分支")
  const ids = [...mount.querySelectorAll("[id]")].map(node => node.id)
  assert.equal(new Set(ids).size, ids.length)
  api.resetGitView(mount)
  assert.equal(window.document.getElementById("gitBranchName"), null)
  assert.match(mount.textContent || "", /正在读取/)
  api.mountGitView(mount, overview)
  assert.equal(tabs().find(tab => tab.getAttribute("aria-selected") === "true")?.textContent, "同步")
  assert.equal((window.document.getElementById("gitBranchName") as HTMLInputElement).value, "")
  api.resetGitView(mount, "")
  assert.equal(mount.childElementCount, 0)
})
