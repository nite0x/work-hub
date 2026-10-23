import {useEffect, useMemo, useState, useSyncExternalStore} from "react";
import {AssistantRuntimeProvider, MessageNotSentError, useExternalStoreRuntime, type ThreadMessageLike} from "@assistant-ui/react";
import {RefreshCwIcon} from "lucide-react";
import {Thread} from "@/components/assistant-ui/elements/thread.aui";
import {TooltipIconButton} from "@/components/assistant-ui/elements/tooltip-icon-button";
import {Alert, AlertDescription} from "@/components/ui/alert";
import {Button} from "@/components/ui/button";
import {Card, CardContent, CardFooter, CardHeader, CardTitle} from "@/components/ui/card";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {NativeSelect, NativeSelectOption} from "@/components/ui/native-select";
import {ChatController} from "./controller";
import {useChatReading} from "./use-chat-reading";
import {cleanText, convertEntries, mergeEntries, type Approval} from "./model";
import {readElicitation} from "./approval";
import {ApprovalActions, ElicitationFields} from "./approval-fields";
import {ChatImageAttachmentAdapter} from "./attachments";

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
  const reading = useChatReading(controller);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const attachments = useMemo(() => new ChatImageAttachmentAdapter(), []);
  const messages = useMemo(() => convertEntries(mergeEntries(state.entries, state.chat.entries)), [state.entries, state.chat.entries]);
  const runtime = useExternalStoreRuntime({
    adapters: {attachments},
    messages, convertMessage: toThreadMessage,
    isRunning: state.chat.busy || state.submitting,
    isLoading: state.loading && messages.length === 0,
    hasEarlier: !!state.cursor,
    onLoadEarlier: () => controller.history(true),
    isSendDisabled: !!state.chat.blocked || state.submitting || controller.options.task.state !== "ready",
    onNew: async message => {
      reading.latest();
      const text = message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
      const images = [...message.content, ...(message.attachments || []).flatMap(a => a.content)].filter(p => p.type === "image").map(p => p.image);
      controller.draftAttachments = message.attachments || [];
      try { await controller.send(text, images); } catch (error) { throw new MessageNotSentError((error as Error).message); }
    },
    onCancel: controller.stop,
  });
  useEffect(() => { controller.connect(); return () => controller.disconnect(); }, [controller]);
  useEffect(() => { runtime.thread.composer.setText(state.draft); }, [runtime, state.draft]);
  useEffect(() => {
    const composer = runtime.thread.composer;
    for (const attachment of controller.draftAttachments) {
      if (composer.getState().attachments.some(a => a.id === attachment.id)) continue;
      const restored = attachment.content ? {id: attachment.id, type: attachment.type, name: attachment.name, contentType: attachment.contentType, content: attachment.content} : attachment.file;
      if (restored) void composer.addAttachment(restored).catch(error => controller.setError((error as Error).message));
    }
    const unsubscribe = composer.subscribe(() => {
      const draft = composer.getState();
      if (!draft.submission && !controller.getSnapshot().submitting) controller.draftAttachments = draft.attachments;
    });
    const unsubscribeErrors = composer.unstable_on("attachmentAddError", event => controller.setError(event.message));
    return () => { unsubscribe(); unsubscribeErrors(); };
  }, [controller, runtime, state.draftRestore]);
  const task = controller.options.task;
  const path = state.session?.cwd || task.members.find(m => m.project_id === state.project)?.path;
  const project = task.members.find(m => m.path === path);
  const status = state.chat.blocked || (state.chat.busy || ["failed", "interrupted", "conflict"].includes(state.chat.status) ? labels[state.chat.status] || state.chat.status : "");
  const footer = status || state.chat.notice || state.chat.can_handoff || state.error || state.chat.error;
  return <AssistantRuntimeProvider runtime={runtime}>
    <section className="shadcn-scope assistant-chat-scope flex h-full min-h-0 w-full flex-col bg-background text-foreground" aria-labelledby="assistantChatTitle">
      <header className="chat-panel-header shrink-0 space-y-2 border-b px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <h2 id="assistantChatTitle" tabIndex={-1} className="chat-panel-title m-0 min-w-0 truncate text-base font-semibold">{state.session?.name || "新建会话"}</h2>
        </div>
        {state.session && <details className="chat-context text-xs text-muted-foreground"><summary>{project?.project_name || "工作目录"}</summary><div className="space-y-2 pt-2"><p className="break-all font-mono">{path}</p><TooltipIconButton tooltip="刷新历史" aria-label="刷新历史" disabled={state.loading} onClick={() => void controller.history()}><RefreshCwIcon /></TooltipIconButton></div></details>}
        {!state.session && <div className="space-y-2"><Label htmlFor="assistantChatProject">工作项目</Label><NativeSelect id="assistantChatProject" value={state.project} disabled={state.submitting} onChange={e => controller.setProject(e.target.value)}>{task.members.map(m => <NativeSelectOption key={m.project_id} value={m.project_id}>{m.project_name}{m.project_id === task.primary_project_id ? "（主项目）" : ""}</NativeSelectOption>)}</NativeSelect></div>}
      </header>
      {state.historyError && <Alert variant="destructive" className="shrink-0 rounded-none"><AlertDescription>{state.historyError}</AlertDescription></Alert>}
      <div ref={reading.container} className="relative min-h-0 flex-1" onChange={event => {
        if (event.target instanceof HTMLTextAreaElement && event.target.closest(".aui-composer-root")) controller.setDraft(event.target.value);
      }}><Thread managedScroll autoFocus={false} />{reading.hasNew && <Button type="button" size="sm" className="absolute bottom-24 left-1/2 z-10 -translate-x-1/2" onClick={reading.latest}>有新消息 · 查看最新</Button>}</div>
      {state.chat.approvals.length > 0 && <div className="max-h-[40%] shrink-0 space-y-2 overflow-y-auto border-t p-4" aria-live="polite">{state.chat.approvals.map(a => <ApprovalCard key={a.id} approval={a} controller={controller} />)}</div>}
      {footer && <footer className="shrink-0 space-y-2 border-t px-5 py-3 text-xs text-muted-foreground">
        {status && <div role="status">{status}</div>}
        {state.chat.notice && <p className="m-0">{state.chat.notice}</p>}
        {state.chat.can_handoff && !state.chat.busy && <Button type="button" size="sm" variant="outline" disabled={state.submitting} onClick={() => void controller.handoff()}>在这里继续（等终端本轮结束）</Button>}
        {(state.error || state.chat.error) && <Alert variant="destructive"><AlertDescription>{state.error || state.chat.error}</AlertDescription></Alert>}
      </footer>}
    </section>
  </AssistantRuntimeProvider>;
}
