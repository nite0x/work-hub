import { createRef, type RefObject } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { GitView, type GitTab, type GitViewHandle } from "./git"
import type { GitOverview } from "./types"

interface GitMount { root: Root; handle: RefObject<GitViewHandle | null> }
const mounts = new WeakMap<HTMLElement, GitMount>()

function getMount(container: HTMLElement): GitMount {
  const existing = mounts.get(container)
  if (existing) return existing
  const mounted = { root: createRoot(container), handle: createRef<GitViewHandle>() }
  mounts.set(container, mounted)
  return mounted
}

/** The legacy controller can read its native fields immediately after mounting. */
export function mountGitView(container: HTMLElement, overview: GitOverview) {
  const mounted = getMount(container)
  flushSync(() => mounted.root.render(<GitView ref={mounted.handle} overview={overview} />))
}

/** Loading and error states keep the same React owner; never write innerHTML. */
export function resetGitView(container: HTMLElement, message = "正在读取分支与远端…") {
  const mounted = getMount(container)
  flushSync(() => mounted.root.render(message ? <div className="git-loading" role="status">{message}</div> : null))
}

export function selectGitTab(container: HTMLElement, tab: GitTab) {
  const mounted = mounts.get(container)
  if (mounted) flushSync(() => mounted.handle.current?.selectTab(tab))
}
