import { test } from "node:test"
import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { JSDOM } from "jsdom"
import { ProjectPicker, projectChoiceReady, projectChoiceSummary } from "../frontend/workspace/project-picker"
import type { PickerRow } from "../frontend/workspace/types"

function row(): PickerRow {
  const project = { id: "web", name: "Web <app>", path: "/repo/web", worktrees: [{ path: "/workspace/existing/web", branch: "feature/existing" }] }
  return {
    project, checked: true, prefix: "projectPicker-web", trees: project.worktrees,
    choice: { mode: "new", branch: "codex/task", path: "", source: "refs/heads/main" },
    overview: { project, remotes: [], branches: [
      { name: "main", ref: "refs/heads/main", kind: "local", commit: "12345678", worktrees: [project.path] },
      { name: "available", ref: "refs/heads/available", kind: "local", commit: "12345678", worktrees: [] },
    ] },
  }
}

test("a ready project stays compact while preserving native form controls and independent mode radios", () => {
  const data = row()
  const dom = new JSDOM(renderToStaticMarkup(createElement(ProjectPicker, { rows: [data] })))
  const document = dom.window.document
  assert.equal(document.querySelector("details")?.open, false)
  assert.equal(document.querySelector<HTMLInputElement>('input[name="project_ids"]')?.value, "web")
  assert.equal(document.querySelectorAll('input[type="radio"]').length, 4)
  assert.equal(document.querySelectorAll('input[name="project_ids"]:checked').length, 1)
  assert.equal(document.querySelector<HTMLSelectElement>("#projectPicker-web-mode")?.value, "new")
  assert.equal(document.querySelector<HTMLSelectElement>("#projectPicker-web-source")?.value, "refs/heads/main")
  assert.equal(document.querySelector("#projectPicker-web-source")?.hasAttribute("data-searchable-select"), true)
  assert.equal(document.querySelector("strong")?.textContent, "Web <app>")
  assert.match(document.querySelector("[data-choice-summary]")?.textContent || "", /codex\/task.*main/)
  dom.window.close()
})

test("unresolved configuration opens and cannot become ready from an unavailable path or occupied branch", () => {
  const data = row()
  data.choice.mode = "worktree"
  data.choice.path = "/workspace/removed/web"
  assert.equal(projectChoiceReady(data), false)
  let dom = new JSDOM(renderToStaticMarkup(createElement(ProjectPicker, { rows: [data] })))
  assert.equal(dom.window.document.querySelector("details")?.open, true)
  dom.window.close()
  data.choice.path = data.trees[0].path
  assert.equal(projectChoiceReady(data), true)
  data.choice.mode = "existing"
  data.choice.existingBranch = "main"
  assert.equal(projectChoiceReady(data), false)
  dom = new JSDOM(renderToStaticMarkup(createElement(ProjectPicker, { rows: [data] })))
  assert.equal(dom.window.document.querySelector<HTMLOptionElement>('option[value="main"]')?.disabled, true)
  dom.window.close()
  data.choice.existingBranch = "available"
  assert.equal(projectChoiceReady(data), true)
})

test("project reuse is ready without a branch lookup but preserves readable configuration and errors", () => {
  const data = row()
  data.choice.mode = "project"
  delete data.overview
  assert.equal(projectChoiceReady(data), true)
  assert.match(projectChoiceSummary(data), /项目原目录.*保留/)
  data.choice.error = "连接失败"
  assert.equal(projectChoiceReady(data), false)
  assert.match(projectChoiceSummary(data), /失败/)
})
