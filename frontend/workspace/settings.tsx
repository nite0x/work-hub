import type { ReactNode } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { TableCell, TableRow } from "@/components/ui/table"
import { Check, DataTable, Feedback, Field, ModalFooter, ModalHeader, NativeSelect, Option, StatusBadge } from "./shared"

function Heading({ id, title, children, actions }: { id: string; title: string; children: ReactNode; actions?: ReactNode }) {
  return <div className="settings-card-heading"><div><h2 id={id} className="m-0 text-lg font-semibold">{title}</h2><p className="text-sm leading-relaxed text-muted-foreground">{children}</p></div>{actions}</div>
}
function Help({ children }: { children: ReactNode }) {
  return <p className="settings-help text-sm leading-relaxed text-muted-foreground">{children}</p>
}
export function SettingsPage() {
  return <>
    <Card className="settings-card gap-0 p-6 shadow-none" aria-labelledby="environmentSettingsTitle">
      <Heading id="environmentSettingsTitle" title="执行环境与工作区" actions={<div className="detail-actions"><Button type="button" variant="outline" size="sm" id="reconnectEnvironment" hidden>重新连接</Button><Button type="button" size="sm" id="addEnvironment">连接 WSL</Button></div>}>任务绑定一个执行环境，项目、终端与 AI 会话均在该环境中操作。任务列表统一展示全部环境。</Heading>
      <Field id="environmentSelect" label="配置环境"><NativeSelect id="environmentSelect" aria-label="配置环境"><Option value="local">本机</Option></NativeSelect><small id="environmentStatus" role="status" className="text-muted-foreground" /></Field>
      <dl className="settings-facts"><div><dt>当前执行环境</dt><dd id="settingsEnvironment">正在读取…</dd></div><div><dt>新任务工作区根目录</dt><dd><code id="settingsRoot">正在读取…</code></dd></div></dl>
      <Help>本机默认使用当前用户的 ~/workspaces，可通过启动参数 --root 指定；连接 WSL 时可指定该环境的根目录。已有任务沿用保存的路径。</Help>
    </Card>
    <Card className="settings-card gap-0 p-6 shadow-none" aria-labelledby="terminalTitle"><form id="terminalForm">
      <Heading id="terminalTitle" title="终端工具">Codex、Git 终端和在终端获取分支共用此设置，保存后立即生效。</Heading>
      <fieldset id="terminalSettingsFields" disabled>
        <Field id="terminalKind" label="终端工具"><NativeSelect id="terminalKind" name="kind"><Option value="auto">系统终端</Option></NativeSelect></Field>
        <div id="terminalCustomFields" hidden><Field id="terminalPath" label="终端程序路径" required help="填写终端可执行文件的完整路径，无需引号或参数。"><Input id="terminalPath" name="path" autoComplete="off" spellCheck={false} /></Field><Field id="terminalStyle" label="启动方式"><NativeSelect id="terminalStyle" name="style"><Option value="otty">Otty</Option><Option value="windows-terminal">Windows Terminal</Option><Option value="command">其他终端（支持 -e 程序 参数）</Option></NativeSelect></Field></div>
        <p id="terminalHint" className="settings-help text-muted-foreground" />
        <Feedback id="terminalStatus" role="status" className="mt-4 bg-muted text-muted-foreground" />
        <Feedback id="terminalError" variant="destructive" className="mt-4" hidden />
        <div className="settings-actions"><Button type="submit">保存终端设置</Button></div>
      </fieldset>
    </form></Card>
    <Card className="settings-card gap-0 p-6 shadow-none" aria-labelledby="masterSyncTitle"><form id="masterSyncForm">
      <Heading id="masterSyncTitle" title="每日拉取 master">更新当前执行环境中已登记项目的本地 master，为新任务准备基线。</Heading>
      <fieldset id="masterSyncSettingsFields" disabled>
        <Check id="masterSyncEnabled" label="启用每日自动拉取" />
        <Field id="masterSyncTime" label="执行时间（北京时间 · Asia/Shanghai）" className="settings-time"><Input type="time" id="masterSyncTime" required defaultValue="09:00" /></Field>
        <Help>服务需保持运行，关闭浏览器不影响执行；错过时间后启动会补跑当天一次。关闭定时拉取不取消已开始的执行。</Help>
        <details className="settings-details"><summary className="text-primary">更新规则与异常处理</summary><p>仅快进更新 master。未提交修改、分支分歧、缺少 master 或远端配置不明确时跳过；认证或网络失败会记录原因，其他项目继续处理。当天执行过后不重复运行，需重试时可使用项目的 Git 操作。</p></details>
        <Feedback id="masterSyncError" variant="destructive" className="mt-4" hidden />
        <div className="settings-actions"><Button type="submit">保存每日拉取设置</Button></div>
      </fieldset>
    </form><div className="settings-results"><h3>最近执行结果</h3><div id="masterSyncResults" aria-live="polite" /></div></Card>
  </>
}
export function EnvironmentForm() {
  return <form id="environmentForm"><ModalHeader id="environmentTitle" title="连接 WSL 环境" eyebrow="EXECUTION ENVIRONMENT" /><p className="dialog-description">应用自动部署并启动辅助程序。Git 和文件操作在所选 WSL 用户内执行，任务记录保存在本机。</p>
    <Field id="environmentDistro" label="发行版"><NativeSelect id="environmentDistro" required /></Field>
    <Field id="environmentUser" label="Linux 用户"><Input id="environmentUser" autoComplete="off" placeholder="留空使用发行版默认用户" /></Field>
    <Field id="environmentRoot" label="新任务的工作区根目录"><Input id="environmentRoot" autoComplete="off" placeholder="留空使用该用户的 ~/workspaces" /></Field>
    <Check id="environmentImport" label="导入该用户原有的 Work Hub 项目与任务记录" />
    <p className="dialog-description">导入会复制一份当前记录到 Windows；项目和 worktree 保留原路径。之后请通过桌面端维护这些任务。</p><Feedback id="environmentError" variant="destructive" hidden />
    <ModalFooter><Button type="submit" id="connectEnvironment">连接并准备环境</Button></ModalFooter>
  </form>
}
export interface SyncRun {
  date: string; status: string; results: { project_name: string; status: string; message: string }[];
}
export function SyncResults({ run }: { run?: SyncRun | null }) {
  if (!run) return <p className="text-sm text-muted-foreground">尚未执行每日拉取。</p>
  const labels: Record<string, string> = { pending: "等待执行", updated: "已更新", current: "已是最新", skipped: "已跳过", failed: "失败" }
  const status = { running: "执行中", completed: "执行完成", interrupted: "执行被中断，未完成项目请手动检查" }[run.status] || run.status
  return <><p>{run.date} · {status}</p><DataTable label="每日拉取执行结果" headers={["项目", "结果", "说明"]}>{run.results.map((result, index) => <TableRow key={index}><TableCell className="align-top whitespace-normal">{result.project_name}</TableCell><TableCell className="align-top"><StatusBadge kind={result.status === "failed" ? "failed" : result.status === "updated" || result.status === "current" ? "ready" : "neutral"}>{labels[result.status] || result.status}</StatusBadge></TableCell><TableCell className="align-top whitespace-normal">{result.message}</TableCell></TableRow>)}</DataTable></>
}
