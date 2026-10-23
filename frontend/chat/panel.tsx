import {useEffect, useMemo, useSyncExternalStore} from "react";
import {AssistantRuntimeProvider, ComposerPrimitive, MessageNotSentError, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime, type ToolCallMessagePartProps} from "@assistant-ui/react";
import {MarkdownTextPrimitive} from "@assistant-ui/react-markdown";
import {ChatController} from "./controller";
import {cleanText, convertEntry, mergeEntries, type Approval, type Entry} from "./model";

const labels: Record<string, string> = {handoff: "等待终端本轮工作结束后交接…", idle: "可以在这里继续对话", starting: "正在连接 Codex…", running: "Codex 正在工作…", waiting: "等待你的审批或回答", stopping: "正在请求停止…", completed: "本轮已完成", interrupted: "本轮已停止", failed: "本轮未完成，请检查进展", conflict: "会话暂不可发送"};
const statusLabel: Record<string, string> = {inProgress: "执行中", completed: "已完成", failed: "失败", declined: "已拒绝", interrupted: "已停止"};
function Markdown() { return <MarkdownTextPrimitive smooth={false} components={{a: ({children, ...props}) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>}} />; }
function ToolCard({args}: ToolCallMessagePartProps) {
  const entry = args.entry as Entry;
  return <details className="aui-tool"><summary><code>{entry.kind === "change" ? "文件修改" : cleanText(entry.command) || "命令执行"}</code><span>{statusLabel[entry.status || ""] || "状态未记录"}</span></summary>
    {entry.cwd && <p className="aui-path">{cleanText(entry.cwd)}</p>}
    {entry.kind === "change" ? <pre>{cleanText(entry.text)}</pre> : <><pre className="aui-command">{cleanText(entry.command)}</pre><details className="aui-output"><summary>命令输出{entry.exit_code != null ? ` · 退出码 ${entry.exit_code}` : ""}</summary><pre>{cleanText(entry.output) || "暂无输出"}</pre></details></>}
  </details>;
}
function Message() {
  const role = useAuiState(s => s.message.role);
  return <MessagePrimitive.Root className={`aui-message aui-${role}`}><div className="aui-speaker">{role === "user" ? "你" : "Codex"}</div><MessagePrimitive.Parts components={{Text: Markdown, tools: {Fallback: ToolCard}}} /></MessagePrimitive.Root>;
}
function ApprovalCard({approval, controller}: {approval: Approval; controller: ChatController}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return <form className="aui-approval" onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const answers: Record<string, string[]> = {};
    for (const q of approval.questions || []) answers[q.id] = [String(data.get(`text:${q.id}`) || "").trim() || String(data.get(`choice:${q.id}`) || "")];
    void controller.answer(approval, "accept", answers);
  }}><strong>{approval.title}</strong>{approval.details && <pre>{cleanText(approval.details)}</pre>}
    {(approval.questions || []).map(q => <fieldset key={q.id}><legend>{q.header} · {q.question}</legend>{q.options?.length ? <select name={`choice:${q.id}`} aria-label={q.question}><option value="">选择一个回答，或在下方补充</option>{q.options.map(o => <option key={o.label} value={o.label}>{o.label} · {o.description}</option>)}</select> : null}<input name={`text:${q.id}`} type={q.isSecret ? "password" : "text"} autoComplete="off" aria-label={q.question + "（补充回答）"} placeholder="输入回答或补充说明" /></fieldset>)}
    <div className="aui-actions"><button type="button" className="button small secondary" disabled={!!state.answering || state.stopping} onClick={() => void controller.answer(approval, "decline", {})}>拒绝</button>{approval.can_accept && <button type="submit" className="button small primary" disabled={!!state.answering || state.stopping}>{state.answering === approval.id ? "正在提交…" : approval.kind === "questions" ? "提交回答" : "允许一次"}</button>}</div>
  </form>;
}
export function ChatPanel({controller}: {controller: ChatController}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const entries = useMemo(() => mergeEntries(state.entries, state.chat.entries), [state.entries, state.chat.entries]);
  const runtime = useExternalStoreRuntime({
    messages: entries, convertMessage: convertEntry,
    isRunning: state.chat.busy || state.submitting,
    isSendDisabled: !!state.chat.blocked || state.submitting || controller.options.task.state !== "ready",
    onNew: async message => {
      const text = message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
      try { await controller.send(text); } catch (error) { throw new MessageNotSentError((error as Error).message); }
    },
    onCancel: controller.stop,
  });
  useEffect(() => { controller.connect(); return () => controller.disconnect(); }, [controller]);
  useEffect(() => { runtime.thread.composer.setText(state.draft); }, [runtime, state.draft]);
  const task = controller.options.task;
  const path = state.session?.cwd || task.members.find(m => m.project_id === state.project)?.path;
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="aui-thread">
    <header className="session-history-header"><div className="dialog-header"><div><div className="eyebrow">任务对话</div><h2 id="assistantChatTitle" tabIndex={-1}>{state.session?.name || "新建会话"}</h2></div><button type="button" className="icon-button" aria-label="关闭会话详情" onClick={controller.options.close}>×</button></div>
      <p className="aui-task">{task.name} · {controller.options.environment === "local" ? "本机" : "WSL"}</p><div className="aui-path">{path}</div>
      {!state.session && <label className="aui-project">工作项目<select aria-label="工作项目" value={state.project} disabled={state.submitting} onChange={e => controller.setProject(e.target.value)}>{task.members.map(m => <option key={m.project_id} value={m.project_id}>{m.project_name}{m.project_id === task.primary_project_id ? "（主项目）" : ""}</option>)}</select></label>}
      {state.session && <button type="button" className="button small secondary" disabled={state.loading} onClick={() => void controller.history()}>刷新历史</button>}
    </header>
    <ThreadPrimitive.Viewport className="aui-viewport" autoScroll><div className="aui-content">
      {state.historyError && <p className="form-error" role="alert">{state.historyError}</p>}
      {state.cursor && <button type="button" className="button small secondary history-more" disabled={state.loading} onClick={() => void controller.history(true)}>加载更早记录</button>}
      <ThreadPrimitive.Empty><div className="aui-empty"><strong>{state.loading ? "正在读取历史…" : state.session ? "继续这个任务" : "从这里开始对话"}</strong><p>描述你想完成的工作，Codex 将在当前任务的项目中继续。</p></div></ThreadPrimitive.Empty>
      <ThreadPrimitive.Messages components={{Message}} />
    </div></ThreadPrimitive.Viewport>
    <div className="aui-confirmations" aria-live="polite">{state.chat.approvals.map(a => <ApprovalCard key={a.id} approval={a} controller={controller} />)}</div>
    <footer className="aui-footer"><div className="aui-status" role="status">{state.chat.blocked || labels[state.chat.status] || state.chat.status}</div>
      {state.chat.notice && <p className="aui-status">{state.chat.notice}</p>}
      {state.chat.can_handoff && !state.chat.busy && <button type="button" className="button small secondary" disabled={state.submitting} onClick={() => void controller.handoff()}>切换到侧栏（等本轮结束）</button>}
      {(state.error || state.chat.error) && <p className="form-error" role="alert">{state.error || state.chat.error}</p>}
      <ComposerPrimitive.Root className="aui-composer"><ComposerPrimitive.Input aria-label="会话消息" placeholder="补充说明、询问进展，或交代下一步…" submitMode="ctrlEnter" rows={2} maxRows={7} maxLength={32000} autoFocus addAttachmentOnPaste={false} onChange={e => controller.setDraft(e.target.value)} />
        <div className="aui-actions"><small>Ctrl+Enter 发送 · 关闭面板后仍会继续运行</small>{state.chat.busy ? <ComposerPrimitive.Cancel className="button small secondary" disabled={state.stopping || state.chat.status === "stopping"}>{state.stopping ? "正在停止…" : state.chat.status === "handoff" ? "取消交接" : "停止"}</ComposerPrimitive.Cancel> : <ComposerPrimitive.Send className="button small primary">{state.submitting ? "发送中…" : "发送"}</ComposerPrimitive.Send>}</div>
      </ComposerPrimitive.Root>
    </footer>
  </ThreadPrimitive.Root></AssistantRuntimeProvider>;
}
