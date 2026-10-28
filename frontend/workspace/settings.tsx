import type { ReactNode } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Check, Feedback, Field, ModalFooter, ModalHeader, NativeSelect, Option } from "./shared"

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
    <Card className="settings-card gap-0 p-6 shadow-none" aria-labelledby="sessionTitleHeading"><form id="sessionTitleForm">
      <Heading id="sessionTitleHeading" title="对话标题">发送首条消息后，根据首次输入在后台生成一次主题标题。手动名称优先保留。</Heading>
      <fieldset id="sessionTitleFields" disabled>
        <Field id="sessionTitleModel" label="标题模型"><NativeSelect id="sessionTitleModel"><Option value="">跟随正文模型</Option></NativeSelect></Field>
        <Help>仅影响当前执行环境中新对话的标题，正文模型保持原来的选择。沿用 Codex 登录，额外消耗一次模型请求；生成失败时保留初始短标题。</Help>
        <div className="settings-actions"><Button type="submit">保存标题设置</Button></div>
      </fieldset>
      <Feedback id="sessionTitleError" variant="destructive" className="mt-4" hidden />
      <Button type="button" id="sessionTitleReload" variant="outline" size="sm" className="mt-3">刷新可用模型</Button>
    </form></Card>
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
