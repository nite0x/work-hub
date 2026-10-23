import {useEffect, useMemo, useState, useSyncExternalStore} from "react";
import {AssistantRuntimeProvider, MessageNotSentError, useExternalStoreRuntime, type ThreadMessageLike} from "@assistant-ui/react";
import {RefreshCwIcon, XIcon} from "lucide-react";
import {Thread} from "@/components/assistant-ui/elements/thread.aui";
import {TooltipIconButton} from "@/components/assistant-ui/elements/tooltip-icon-button";
import {Alert, AlertDescription} from "@/components/ui/alert";
import {Button} from "@/components/ui/button";
import {Card, CardContent, CardFooter, CardHeader, CardTitle} from "@/components/ui/card";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {NativeSelect, NativeSelectOption} from "@/components/ui/native-select";
import {ChatController} from "./controller";
import {cleanText, convertEntries, mergeEntries, type Approval} from "./model";
import {readElicitation} from "./approval";
import {ApprovalActions, ElicitationFields} from "./approval-fields";

const labels: Record<string, string> = {handoff: "等待终端本轮工作结束后交接…", idle: "可以在这里继续对话", starting: "正在连接 Codex…", running: "Codex 正在工作…", waiting: "等待你的审批或回答", stopping: "正在请求停止…", completed: "本轮已完成", interrupted: "本轮已停止", failed: "本轮未完成，请检查进展", conflict: "会话暂不可发送"};
const toThreadMessage = (message: ThreadMessageLike) => message;

function ApprovalCard({approval, controller}: {approval: Approval; controller: ChatController}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [error, setError] = useState("");
  const disabled = !!state.answering || state.stopping || !state.chat.busy || state.chat.status === "stopping";
  return <Card className="gap-3 py-4"><form onSubmit={event => {
    event.preventDefault();
    if (disabled) return;
    setError("");
    const data = new FormData(event.currentTarget);
    const answers: Record<string, string[]> = {};
    for (const q of approval.questions || []) answers[q.id] = [String(data.get(`text:${q.id}`) || "").trim() || String(data.get(`choice:${q.id}`) || "")];
    const decision = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") || "accept";
    try { void controller.answer(approval, decision, answers, readElicitation(event.currentTarget, approval.elicitation)); }
    catch (error) { setError((error as Error).message); }
  }} onClick={event => {
    if ((event.target as Element).closest("[data-elicitation-open]")) {
      event.preventDefault();
      if (!disabled) void controller.openApprovalURL(approval);
      return;
    }
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-chat-decision]");
    if (button && !disabled) { setError(""); void controller.answer(approval, button.dataset.chatDecision!, {}); }
  }}>
    <CardHeader className="px-4"><CardTitle>{cleanText(approval.title)}</CardTitle></CardHeader>
    <CardContent className="space-y-3 px-4 py-3">
      {approval.details && <pre className="m-0 max-h-36 overflow-auto whitespace-pre-wrap wrap-anywhere text-xs">{cleanText(approval.details)}</pre>}
      <ElicitationFields elicitation={approval.elicitation} disabled={disabled} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {(approval.questions || []).map(q => <fieldset key={q.id} className="m-0 min-w-0 space-y-2 border-0 p-0" disabled={disabled}>
        <legend className="mb-2 text-sm">{q.header} · {q.question}</legend>
        {q.options?.length ? <NativeSelect name={`choice:${q.id}`} aria-label={q.question}><NativeSelectOption value="">选择一个回答，或在下方补充</NativeSelectOption>{q.options.map(o => <NativeSelectOption key={o.label} value={o.label}>{o.label} · {o.description}</NativeSelectOption>)}</NativeSelect> : null}
        <Input name={`text:${q.id}`} type={q.isSecret ? "password" : "text"} autoComplete="off" aria-label={q.question + "（补充回答）"} placeholder="输入回答或补充说明" />
      </fieldset>)}
    </CardContent>
    <CardFooter className="justify-end gap-2 px-4">
      <ApprovalActions approval={approval} disabled={disabled} sending={state.answering === approval.id} />
    </CardFooter>
  </form></Card>;
}

export function ChatPanel({controller}: {controller: ChatController}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const messages = useMemo(() => convertEntries(mergeEntries(state.entries, state.chat.entries)), [state.entries, state.chat.entries]);
  const runtime = useExternalStoreRuntime({
    messages, convertMessage: toThreadMessage,
    isRunning: state.chat.busy || state.submitting,
    isLoading: state.loading && messages.length === 0,
    hasEarlier: !!state.cursor,
    onLoadEarlier: () => controller.history(true),
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
  return <AssistantRuntimeProvider runtime={runtime}>
    <section className="shadcn-scope assistant-chat-scope flex h-full min-h-0 w-full flex-col bg-background text-foreground" aria-labelledby="assistantChatTitle">
      <header className="shrink-0 space-y-3 border-b px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1"><h2 id="assistantChatTitle" tabIndex={-1} className="m-0 truncate text-base font-semibold">{state.session?.name || "新建会话"}</h2><p className="m-0 text-xs text-muted-foreground">{task.name} · {controller.options.environment === "local" ? "本机" : "WSL"}</p></div>
          <div className="flex shrink-0 gap-1">
            {state.session && <TooltipIconButton tooltip="刷新历史" aria-label="刷新历史" disabled={state.loading} onClick={() => void controller.history()}><RefreshCwIcon /></TooltipIconButton>}
            <TooltipIconButton tooltip="关闭会话详情" aria-label="关闭会话详情" onClick={controller.options.close}><XIcon /></TooltipIconButton>
          </div>
        </div>
        <p className="m-0 truncate font-mono text-xs text-muted-foreground" title={path}>{path}</p>
        {!state.session && <div className="space-y-2"><Label htmlFor="assistantChatProject">工作项目</Label><NativeSelect id="assistantChatProject" value={state.project} disabled={state.submitting} onChange={e => controller.setProject(e.target.value)}>{task.members.map(m => <NativeSelectOption key={m.project_id} value={m.project_id}>{m.project_name}{m.project_id === task.primary_project_id ? "（主项目）" : ""}</NativeSelectOption>)}</NativeSelect></div>}
      </header>
      {state.historyError && <Alert variant="destructive" className="shrink-0 rounded-none"><AlertDescription>{state.historyError}</AlertDescription></Alert>}
      <div className="min-h-0 flex-1" onChange={event => {
        if (event.target instanceof HTMLTextAreaElement && event.target.closest(".aui-composer-root")) controller.setDraft(event.target.value);
      }}><Thread /></div>
      {state.chat.approvals.length > 0 && <div className="max-h-[40%] shrink-0 space-y-2 overflow-y-auto border-t p-4" aria-live="polite">{state.chat.approvals.map(a => <ApprovalCard key={a.id} approval={a} controller={controller} />)}</div>}
      <footer className="shrink-0 space-y-2 border-t px-5 py-3 text-xs text-muted-foreground">
        <div role="status">{state.chat.blocked || labels[state.chat.status] || state.chat.status}</div>
        {state.chat.notice && <p className="m-0">{state.chat.notice}</p>}
        {state.chat.can_handoff && !state.chat.busy && <Button type="button" size="sm" variant="outline" disabled={state.submitting} onClick={() => void controller.handoff()}>切换到侧栏（等本轮结束）</Button>}
        {(state.error || state.chat.error) && <Alert variant="destructive"><AlertDescription>{state.error || state.chat.error}</AlertDescription></Alert>}
        <p className="m-0">Ctrl+Enter 发送 · 关闭面板后仍会继续运行</p>
      </footer>
    </section>
  </AssistantRuntimeProvider>;
}
