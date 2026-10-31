import {useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore} from "react";
import {AssistantRuntimeProvider, ExportedMessageRepository, MessageNotSentError, useExternalStoreRuntime, type ThreadMessage} from "@assistant-ui/react";
import {PlusIcon, RefreshCwIcon, SearchIcon, GitBranchIcon, FolderIcon, TerminalIcon, LoaderCircleIcon, HandIcon} from "lucide-react";
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
import {cleanText, convertEntries, mergeEntries, questionDraftKey, type Approval} from "./model";
import {readElicitation} from "./approval";
import {ApprovalActions, ElicitationFields} from "./approval-fields";
import {ChatControls, ChatPermissions, ChatSearch, ChatSessionMenu, ChatStatus} from "./controls";
import {ChatMediaProvider, ChatMessageText, ChatUserImage} from "./media";
import {ChatAttachmentAdapter} from "./attachments";
import {conversationContext} from "../workspace/conversation-context";
import {ChatToolFallback, ChatChangeSummary, ChatChangePathsProvider} from "./file-changes";
import {QuestionComposer} from "./questions";

const chatComponents = {Text: ChatMessageText, UserImage: ChatUserImage, ToolFallback: ChatToolFallback, AssistantMessageEnd: ChatChangeSummary};

// The workspace owns this stable button and its file-panel controller. Move it
// into the active chat toolbar, returning it before the React slot unmounts.
function ChatFileToggle() {
  const slot = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const button = document.getElementById("toggleConversationFiles");
    const original = button?.parentElement;
    if (!button || !original || !slot.current) return;
    slot.current.append(button);
    return () => {original.append(button);};
  }, []);
  return <span ref={slot} className="chat-file-toggle-slot" />;
}

function ChatRunIndicator({controller}: {controller: ChatController}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  if (controller.options.readOnly || (!state.chat.busy && !state.submitting && !state.stopping)) return null;
  const status = state.stopping || state.chat.status === "stopping" ? "stopping"
    : state.chat.status === "waiting" ? "waiting"
    : state.chat.status === "starting" ? "starting"
    : state.chat.busy ? "running" : "sending";
  const labels = {stopping: "正在停止…", waiting: "等待你的确认", starting: "正在连接…", running: state.chat.external ? "Codex 正在运行…" : "进行中…", sending: "正在发送…"};
  return <div className="chat-run-indicator" role="status" aria-live="polite" data-state={status}>
    {status === "waiting" ? <HandIcon aria-hidden="true" /> : <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
    <span>{labels[status]}</span>
  </div>;
}

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
  const readOnly = !!controller.options.readOnly;
  const panel = useRef<HTMLElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const closeSearch = () => {setSearchOpen(false); controller.setSearch(""); searchTrigger.current?.focus();};
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const attachments = useMemo(() => new ChatAttachmentAdapter((name, data) => controller.options.request("/api/chat-attachments", {method: "POST", body: JSON.stringify({name, data})})), [controller]);
  const question = !readOnly ? controller.question() : undefined;
  const approvals = state.chat.approvals.filter(a => a !== question);
  const previousQuestion = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previousQuestion.current && !question) panel.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="会话消息"]')?.focus();
    previousQuestion.current = question?.id;
  }, [question?.id]);
  const entries = useMemo(() => mergeEntries(state.entries, state.chat.entries), [state.entries, state.chat.entries]);
  const messages = useMemo(() => convertEntries(entries), [entries]);
  // The server owns a linear history. Replacing a local echo must remove its
  // old repository entry rather than retain it as an alternate branch.
  const messageRepository = useMemo(() => ExportedMessageRepository.fromArray(messages), [messages]);
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    adapters: {attachments},
    messageRepository,
    isRunning: state.chat.busy || state.submitting,
    isLoading: state.loading && messages.length === 0,
    hasEarlier: !!state.cursor,
    onLoadEarlier: () => controller.history(true),
    isSendDisabled: !!state.chat.external && (state.chat.busy || state.chat.status === "unknown") || !controller.canSend() || !!state.chat.blocked || state.submitting || !!state.session?.archived || (state.chat.busy && (!state.chat.turn_id || !["running","waiting"].includes(state.chat.status))),
    onNew: async message => {
      reading.latest();
      const text = message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
      const images = [...message.content, ...(message.attachments || []).flatMap(a => a.content)].filter(p => p.type === "image").map(p => p.image);
      controller.draftAttachments = message.attachments || [];
      // The composer returns failed submissions to its draft. Let it own that
      // restoration, then mirror the result below so text is never appended twice.
      try { await controller.send(text, images, false); } catch (error) {
        if (!panel.current && !controller.getSnapshot().draft) controller.setDraft(text);
        throw new MessageNotSentError((error as Error).message);
      }
    },
    onCancel: state.chat.external && state.chat.busy ? undefined : controller.stop,
  });
  const reading = useChatReading(controller, runtime.thread);
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
      if (!draft.submission && !controller.getSnapshot().submitting) { controller.draftAttachments = draft.attachments; controller.setDraft(draft.text); controller.attachmentsChanged(); }
    });
    const unsubscribeErrors = composer.unstable_on("attachmentAddError", event => controller.setError(event.message));
    return () => { unsubscribe(); unsubscribeErrors(); };
  }, [controller, runtime, state.draftRestore]);
  const task = controller.options.task;
  const path = state.chat.context?.cwd || state.context?.cwd || state.session?.cwd || controller.options.target?.cwd || task?.members.find(m => m.project_id === state.project)?.path || "";
  const context = conversationContext(path, controller.options.workspace || (task ? {tasks: [task], projects: []} : undefined), task?.id || controller.options.target?.task_id);
  const additionalDirectories = state.chat.context?.additional_directories || state.context?.additional_directories || [];
  const changePaths = useMemo(() => ({cwd: path, additionalDirectories,
    projectRoots: [...(controller.options.workspace?.projects.flatMap(project => [project.path, ...project.worktrees.map(tree => tree.path)]) || []), ...(controller.options.workspace?.tasks.flatMap(task => task.members.map(member => member.path)) || []), ...(task?.members.map(member => member.path) || [])],
  }), [path, additionalDirectories, controller.options.workspace, task]);
  const status = state.chat.blocked;
  const footer = state.draftNotice || status || state.chat.notice || state.chat.can_handoff || state.error || state.chat.error;
  const terminal = state.terminal;
  return <AssistantRuntimeProvider runtime={runtime}><ChatMediaProvider controller={controller} entries={entries}><ChatChangePathsProvider value={changePaths}>
    <section ref={panel} className="shadcn-scope assistant-chat-scope flex h-full min-h-0 w-full flex-col bg-background text-foreground" aria-labelledby="assistantChatTitle" onKeyDownCapture={event=>{
      if (state.chat.busy && event.key==="Enter" && (event.ctrlKey||event.metaKey) && !event.shiftKey && !event.nativeEvent.isComposing && event.target instanceof HTMLTextAreaElement && event.target.closest(".aui-composer-root")) {event.preventDefault();event.stopPropagation();runtime.thread.composer.send();}
    }}>
      <header className="chat-panel-header shrink-0 border-b px-4 py-3">
        <div className="chat-panel-toolbar">
          <div className="chat-panel-heading">
            {controller.options.openWorkspace && context.tasks.length > 0 && <nav className="chat-workspace-tasks" aria-label="关联任务详情"><span>任务</span>{context.tasks.map(t => <button key={t.id} type="button" className="chat-workspace-link" aria-label={`打开任务详情：${t.name}`} title={`打开任务详情：${t.name}`} onClick={() => controller.options.openWorkspace?.("task", t.id)}>{t.name}</button>)}</nav>}
            <h2 id="assistantChatTitle" tabIndex={-1} className="chat-panel-title m-0 min-w-0 truncate text-sm font-semibold" title={state.session?.name}>{state.session ? state.session.name || "未命名对话" : "新建会话"}</h2>
          </div>
          <div className="chat-panel-actions">
            <ChatStatus controller={controller} />
            {state.session && <>
              <TooltipIconButton ref={searchTrigger} tooltip="查找消息" aria-label="查找消息" aria-expanded={searchOpen} onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}><SearchIcon /></TooltipIconButton>
              <TooltipIconButton tooltip="刷新历史" aria-label="刷新历史" disabled={state.loading} onClick={() => void controller.history()}><RefreshCwIcon className={state.loading ? "animate-spin motion-reduce:animate-none" : ""} /></TooltipIconButton>
            </>}
            {!readOnly && state.session && controller.options.newConversation && <TooltipIconButton tooltip="新建会话" aria-label="新建会话" disabled={!!task && task.state !== "ready"} onClick={controller.options.newConversation}><PlusIcon /></TooltipIconButton>}
            <ChatFileToggle />
            <ChatSessionMenu controller={controller} portal={panel} />
          </div>
        </div>
        <details className="chat-workspace-context">
          <summary>{context.projectID && controller.options.openWorkspace ? <button type="button" className="chat-workspace-project chat-workspace-link" aria-label={`打开项目详情：${context.project}`} title={`打开项目详情：${context.project}`} onClick={event => {event.preventDefault(); event.stopPropagation(); controller.options.openWorkspace?.("project", context.projectID!);}}><FolderIcon aria-hidden="true" /><span>{context.project}</span></button> : <span className="chat-workspace-project"><FolderIcon aria-hidden="true" />{context.project || "工作目录"}</span>}{context.branch && <span className="chat-workspace-branch" title={`分支 · ${context.branch}`}><GitBranchIcon aria-hidden="true" />{context.branch}</span>}</summary>
          <dl className="chat-context-facts grid gap-2 text-xs"><dt>执行环境</dt><dd>{controller.options.environmentName || (controller.options.environment === "local" ? "本机" : controller.options.environment)}</dd><dt>{state.chat.busy ? "运行目录" : "工作目录"}</dt><dd>{path || "请选择工作目录"}</dd><dt>目录类型</dt><dd>{context.kind}</dd><dt>关联任务</dt><dd>{context.tasks.length ? context.tasks.map(t => t.name).join("、") : "未关联任务"}</dd>{additionalDirectories.length > 0 && <><dt>额外工作目录</dt><dd>{additionalDirectories.join("、")}</dd></>}</dl>
          {!readOnly && state.session && <Button type="button" size="sm" variant="outline" className="chat-workspace-resume" disabled={!state.session.available} onClick={() => void controller.resume()}><TerminalIcon aria-hidden="true" />在终端继续</Button>}
        </details>
        {readOnly && <div className="flex items-center gap-2"><ChatControls controller={controller} portal={panel} />{state.session && <Button type="button" variant="ghost" size="sm" data-session-action="global-resume" data-session={state.session.id} onClick={() => void controller.resume()} disabled={!state.session.available}>在终端继续 ↗</Button>}</div>}
        {state.session && <ChatSearch controller={controller} container={reading.container} open={searchOpen} onClose={closeSearch} />}
        {!state.session && task && <div className="mt-2 space-y-2"><Label htmlFor="assistantChatProject">工作项目</Label><NativeSelect id="assistantChatProject" value={state.project} disabled={state.submitting} onChange={e => controller.setProject(e.target.value)}>{task.members.map(m => <NativeSelectOption key={m.project_id} value={m.project_id}>{m.project_name}{m.project_id === task.primary_project_id ? "（主项目）" : ""}</NativeSelectOption>)}</NativeSelect></div>}
      </header>
      {state.historyError && <Alert variant="destructive" className="shrink-0 rounded-none"><AlertDescription>{state.historyError}</AlertDescription></Alert>}
      <div ref={reading.container} className="relative min-h-0 flex-1" onChange={event => {
        if (event.target instanceof HTMLTextAreaElement && event.target.closest(".aui-composer-root")) controller.setDraft(event.target.value);
      }}><Thread composerStatus={<ChatRunIndicator controller={controller} />} components={chatComponents} managedScroll autoFocus={false} readOnly={readOnly} composer={question ? <QuestionComposer key={questionDraftKey(question, state.chat.id)} approval={question} controller={controller} /> : undefined} composerLeadingControls={<ChatPermissions controller={controller} portal={panel} />} composerControls={<ChatControls controller={controller} portal={panel} />} />{reading.hasNew && !question && <Button type="button" size="sm" className="absolute bottom-24 left-1/2 z-10 -translate-x-1/2" onClick={reading.latest}>有新消息 · 查看最新</Button>}</div>
      {readOnly && (terminal?.waiting || !!terminal?.confirmations?.length) && <Alert className="max-h-[40%] shrink-0 overflow-y-auto rounded-none" role="alert"><AlertDescription>
        <p>终端有待确认事项，请在原终端处理。{!terminal.connected && "连接已断开，以下提示尚未核实。"}</p>
        {terminal.confirmations?.map(item => <div key={item.id} className="space-y-2"><strong>{cleanText(item.title)}</strong>{item.details && <pre className="whitespace-pre-wrap wrap-anywhere">{cleanText(item.details)}</pre>}{item.questions?.map(q => <p key={q.id}>{cleanText(q.header)} · {cleanText(q.question)}{q.options?.map(o => <span key={o.label} className="block">{cleanText(o.label)} · {cleanText(o.description)}</span>)}</p>)}</div>)}
      </AlertDescription></Alert>}
      {approvals.length > 0 && <div className="max-h-[40%] shrink-0 space-y-2 overflow-y-auto border-t p-4" aria-live="polite">{approvals.map(a => <ApprovalCard key={a.id} approval={a} controller={controller} />)}</div>}
      {footer && <footer className="shrink-0 space-y-2 border-t px-5 py-3 text-xs text-muted-foreground">
        {status && <div role="status">{status}</div>}
        {state.draftNotice && <p role="status">{state.draftNotice}</p>}
        {state.chat.notice && <p className="m-0">{state.chat.notice}</p>}
        {state.chat.can_handoff && !state.chat.busy && <Button type="button" size="sm" variant="outline" disabled={state.submitting} onClick={() => void controller.handoff()}>在这里继续（等终端本轮结束）</Button>}
        {(state.error || state.chat.error) && <Alert variant="destructive"><AlertDescription>{state.error || state.chat.error}</AlertDescription></Alert>}
      </footer>}
    </section>
  </ChatChangePathsProvider></ChatMediaProvider></AssistantRuntimeProvider>;
}
