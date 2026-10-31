import { forwardRef, useImperativeHandle, useState, type ReactNode } from "react"
import { Tabs } from "radix-ui"
import { ArrowDownToLine, ArrowUpFromLine, GitBranch, GitMerge, Search } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { TableCell, TableRow } from "@/components/ui/table"
import { Action, Branch, Check, DataTable, Feedback, Field, NativeSelect, Option, SourceOptions, StatusBadge } from "./shared"
import type { GitOverview } from "./types"

export type GitTab = "sync" | "branches" | "merge"
export interface GitViewHandle { selectTab: (tab: GitTab) => void }

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <Card className="git-section gap-4 rounded-lg p-4 shadow-none"><div className="git-section-title mb-0"><h3 className="m-0 text-sm font-semibold">{title}</h3><span className="text-xs text-muted-foreground">{description}</span></div>{children}</Card>
}

// Keep every panel mounted: the Git controller owns native field values and
// operation guards, while React owns tab selection and branch-list filtering.
export const GitView = forwardRef<GitViewHandle, { overview: GitOverview }>(function GitView({ overview: v }, ref) {
  const [tab, setTab] = useState<GitTab>("sync")
  const [query, setQuery] = useState("")
  useImperativeHandle(ref, () => ({ selectTab: setTab }), [])
  const local = v.branches.filter(b => b.kind === "local")
  const remote = v.branches.filter(b => b.kind === "remote")
  const matching = v.branches.filter(b => `${b.name} ${b.upstream || ""} ${b.worktrees.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()))

  return <div className="git-workspace">
    <div className="git-workspace-context">
      <div className="git-workspace-directory">
        <Field id="gitWorktree" label="工作目录"><NativeSelect id="gitWorktree" data-searchable-select>{v.project.worktrees.filter(t => !t.bare && !t.missing && !t.prunable && !t.error).map(t => <Option key={t.path} value={t.path}>{t.path} · {t.branch || "detached HEAD"}</Option>)}</NativeSelect></Field>
        <Action action="git-terminal" variant="outline">打开终端 ↗</Action>
      </div>
      <Feedback id="gitContext" className="git-context-summary" role="status" />
    </div>

    <Tabs.Root value={tab} onValueChange={value => setTab(value as GitTab)} className="git-tabs">
      <Tabs.List className="git-tab-list" aria-label="Git 操作分类">
        <Tabs.Trigger value="sync" className="git-tab"><ArrowDownToLine aria-hidden="true" />同步</Tabs.Trigger>
        <Tabs.Trigger value="branches" className="git-tab"><GitBranch aria-hidden="true" />分支</Tabs.Trigger>
        <Tabs.Trigger value="merge" className="git-tab"><GitMerge aria-hidden="true" />合并</Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="sync" forceMount hidden={tab !== "sync"} className="git-tab-panel">
        <Section title="获取与拉取" description="获取更新远端记录；拉取只允许快进">
          <div className="git-inline">
            <Field id="gitRemote" label="远端" className="grow"><NativeSelect id="gitRemote" disabled={!v.remotes.length}>{v.remotes.length ? v.remotes.map(r => <Option key={r.name} value={r.name}>{r.name} · {r.url}</Option>) : <Option value="">未配置远端</Option>}</NativeSelect></Field>
            <Action action="git-fetch" variant="default" disabled={!v.remotes.length}><ArrowDownToLine aria-hidden="true" />获取远端</Action>
            <Action action="git-pull">快进拉取</Action>
            <Action action="git-reload">刷新状态</Action>
          </div>
          <p className="git-help">获取不会切换当前分支。存在未提交修改或未结束的 Git 操作时，先在终端或编辑器处理再拉取。</p>
          <details className="git-credential-details"><summary>凭证与终端帮助</summary><p>{v.credentials?.message || "沿用当前环境的 Git 凭证助手。需要登录时可在终端获取。"}</p><Action action="git-fetch-terminal" disabled={!v.remotes.length}>在终端登录并获取 ↗</Action></details>
        </Section>
        <Section title="推送当前分支" description="只推送已提交内容，保留未提交修改">
          <div className="form-grid"><Field id="gitPushRemote" label="目标远端"><NativeSelect id="gitPushRemote">{v.remotes.map(r => <Option key={r.name} value={r.name}>{r.name} · {r.url}</Option>)}</NativeSelect></Field><Field id="gitPushName" label="远端分支名称"><Input id="gitPushName" maxLength={160} /></Field></div>
          <div className="git-push-footer"><Check id="gitPushTrack" label="设置为当前分支的上游" /><Action action="git-push" variant="default"><ArrowUpFromLine aria-hidden="true" />推送</Action></div>
          <p id="gitPushDirection" className="git-push-direction" />
        </Section>
      </Tabs.Content>

      <Tabs.Content value="branches" forceMount hidden={tab !== "branches"} className="git-tab-panel">
        <Section title="切换当前目录分支" description="只影响上方选中的工作目录">
          <div className="git-inline"><Field id="gitSwitch" label="切换到分支" className="grow"><NativeSelect id="gitSwitch" data-searchable-select /></Field><Field id="gitSwitchName" label="远端分支对应的新本地分支" className="grow"><Input id="gitSwitchName" maxLength={160} /></Field><Action action="git-switch" variant="default">切换分支</Action></div>
          <p id="gitSwitchNote" className="git-help" />
          <small className="git-help">有未提交修改、进行中的 Git 操作或分支被其他 Worktree 占用时，不能直接切换。</small>
        </Section>
        <Section title="创建本地分支" description="创建后保留当前目录的分支">
          <form id="gitCreateForm"><div className="form-grid"><Field id="gitBranchName" label="新分支名称"><Input id="gitBranchName" required maxLength={160} placeholder="feature/example" /></Field><Field id="gitBranchSource" label="来源分支"><NativeSelect id="gitBranchSource" data-searchable-select required><SourceOptions overview={v} /></NativeSelect></Field></div><div className="git-inline"><div className="mr-auto"><Check id="gitTrack" label="设置远端跟踪关系" /></div><Button type="submit">创建本地分支</Button></div><Feedback id="gitSourceExplanation" className="mt-3 bg-muted text-muted-foreground">请选择来源分支。</Feedback></form>
        </Section>
        {local.some(b => b.worktrees.length === 0) && remote.length ? <Section title="更新未检出的本地分支" description="无需切换工作目录，只允许快进">
          <div className="form-grid"><Field id="gitFFLocal" label="本地分支"><NativeSelect id="gitFFLocal" data-searchable-select>{local.filter(b => b.worktrees.length === 0).map(b => <Option key={b.name} value={b.name}>{b.name}</Option>)}</NativeSelect></Field><Field id="gitFFSource" label="快进到远端分支"><NativeSelect id="gitFFSource" data-searchable-select>{remote.map(b => <Option key={b.ref} value={b.ref}>{b.name}</Option>)}</NativeSelect></Field></div><div><Action action="git-fast-forward">快进更新本地分支</Action></div><small className="git-help">分支有分歧或已被 Worktree 检出时会拒绝更新。</small>
        </Section> : null}
        <Section title="全部分支" description={`${local.length} 个本地 · ${remote.length} 个远端`}>
          <div className="git-branch-search"><Search aria-hidden="true" /><Input id="gitBranchSearch" value={query} onChange={event => setQuery(event.target.value)} type="search" aria-label="搜索分支、上游或工作目录" placeholder="搜索分支、上游或工作目录" /></div>
          <DataTable label="Git 分支" headers={["分支 / 提交 / 跟踪", "占用的 Worktree", "操作"]}>{matching.length ? matching.map(b => <TableRow key={b.ref}><TableCell className="align-top whitespace-normal"><div className="flex flex-wrap items-center gap-2"><Branch>{b.name}</Branch><StatusBadge kind={b.kind === "remote" ? "neutral" : "primary-tag"}>{b.kind === "remote" ? "远端" : "本地"}</StatusBadge></div><div className="comparison">{b.commit.slice(0, 8)}{b.upstream ? ` · 跟踪 ${b.upstream}` : ""}</div></TableCell><TableCell className="align-top whitespace-normal">{b.worktrees.length ? b.worktrees.map(path => <div key={path} className="path">{path}</div>) : <span className="quiet">未检出</span>}</TableCell><TableCell className="align-top"><Action action="git-use-source" data-ref={b.ref}>以此创建分支</Action></TableCell></TableRow>) : <TableRow><TableCell colSpan={3} className="whitespace-normal">{query ? "没有匹配的分支，试试其他名称。" : "尚无分支记录，请先获取远端或在终端创建初始提交。"}</TableCell></TableRow>}</DataTable>
        </Section>
      </Tabs.Content>

      <Tabs.Content value="merge" forceMount hidden={tab !== "merge"} className="git-tab-panel">
        <Section title="将当前分支合并到…" description="选择目标分支，当前目录保留在原分支">
          <Field id="gitMergeTarget" label="目标本地分支"><NativeSelect id="gitMergeTarget" data-searchable-select /></Field>
          <p id="gitMergeIntoDirection" className="git-help whitespace-pre-wrap break-words" role="status" />
          <div className="git-inline"><Action action="git-merge-into-preview" variant="default">预览合并</Action><Action action="git-merge-into" disabled>合并到目标分支</Action></div>
          <Feedback id="gitMergeIntoPreview" className="mt-3 bg-muted" hidden />
          <small className="git-help">仅合并已提交内容。目标目录需要干净；出现冲突时停止，目标分支保留原状态。需要发布时，再切到目标分支推送。</small>
        </Section>
        <Section title="合并到当前分支" description="先预览待合入提交，再执行合并">
          <div id="gitMergeActive" hidden><Feedback id="gitMergeStatus" className="bg-muted" role="status" /><div className="git-inline"><Action action="git-merge-ai" variant="default">让 AI 完成合并</Action><Action action="git-merge-abort">中止合并</Action></div></div>
          <div id="gitMergeForm"><Field id="gitMergeSource" label="待合入的分支"><NativeSelect id="gitMergeSource" data-searchable-select><SourceOptions overview={v} includeHead={false} /></NativeSelect></Field><div className="git-inline"><Action action="git-merge-preview" variant="default">预览合并</Action><Action action="git-merge" disabled>执行合并</Action></div><Feedback id="gitMergePreview" className="mt-3 bg-muted" hidden /></div>
        </Section>
      </Tabs.Content>
    </Tabs.Root>
  </div>
})
