import {entryKey, idleChat, latestEntryFingerprint, mergeEntries, mergeHistoryEntries, newConversationSettings, pendingAsyncQuestion, questionDraftKey, readSnapshots, type Approval, type ChatState, type Entry, type HistoryPush, type Session, type Task, type QuestionDraft} from "./model";
import {cacheDraft, draftFiles, draftImages, readLocalDraft, restoreFiles, restoreImages, validDraft, type DraftRecord} from "./drafts";
import type {TurnSettings,ChatContext,ChatModel} from "./model";
import type {Attachment} from "@assistant-ui/react";
import {validateImages} from "./attachments";
import type {ConversationWorkspace} from "../workspace/conversation-context";

export interface ChatOptions {
  workspace?: ConversationWorkspace;
  task?: Task; target?: SessionTarget; session: Session | null; environment: string; environmentName?: string;
  readOnly?: boolean; persistDraft?: boolean;
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
  stream: (path: string, signal: AbortSignal) => Promise<Response>;
  created: (session: Session) => void;
  activity?: (session: string, chat: ChatState) => void;
  close: () => void;
  newConversation?: () => void;
  openWorkspace?: (kind: "task" | "project", id: string) => void;
 managed?: (session: Session, action: string) => void;
}
export interface SessionTarget { task_id?: string; project_id?: string; cwd?: string; additional_directories?: string[] }
// Existing conversations are shared across every entry point. Only unsent
// drafts are scoped to their creation target.
export const conversationKey = (options: ChatOptions, session: string | null = options.session?.id || null) => JSON.stringify(session
  ? [options.environment, "session", session]
  : [options.environment, "draft", options.task?.id || options.target?.task_id || "", options.target?.project_id || "", options.target?.cwd || ""]);
export interface Snapshot {
  session: Session | null; entries: Entry[]; chat: ChatState; project: string; draft: string;
  error: string; historyError: string; loading: boolean; submitting: boolean; stopping: boolean;
  answering: string | null; cursor: string | null;
  draftRestore: number; settings: TurnSettings; context?: ChatContext; models: ChatModel[]; modes: string[]; optionsLoading: boolean; draftNotice: string; search: string; searching: boolean; searchError: string; managing: boolean;
  terminal?: HistoryPush;
}
type History = {session: Session; entries: Entry[]; next_cursor?: string | null; has_user_message?: boolean};
export class ChatController {
  reading: DraftRecord['reading'] = {top: 0, bottom: true, anchor: "", offset: 0};
  opening = true;
  latestMessage = () => latestEntryFingerprint(mergeEntries(this.snapshot.entries, this.snapshot.chat.entries));
  draftAttachments: readonly Attachment[] = [];
  // Pending answers stay separate from the message draft, including on reopen.
  questionDrafts = new Map<string, Record<string, QuestionDraft>>();
  private resolvedQuestions = new Set<string>();
  question = () => this.snapshot.chat.approvals.find(a => a.kind === "questions" && a.questions?.length)
    || pendingAsyncQuestion(mergeEntries(this.snapshot.entries, this.snapshot.chat.entries), this.resolvedQuestions);
  setQuestionDraft = (key: string, draft: Record<string, QuestionDraft>) => {
    this.questionDrafts.set(key, draft); this.update({}); this.draftChanged();
  };
  private snapshot: Snapshot;
  private listeners = new Set<() => void>();
  private connected = false;
  private timer?: ReturnType<typeof setInterval>;
  private readAbort?: AbortController;
  private streamAbort?: AbortController;
  private streamRun?: string;
  private polling = false;
  private generation = 0;
  private handoffID?: string;
  private submitted?: {id?: string; text: string; attachments: readonly Attachment[]};
  private pending?: {text: string; images?: string[]; project_id: string; task_id?: string; cwd?: string; additional_directories?: string[]; request_id: string; settings?: TurnSettings; turn_id?: string};
  private openingApproval = false;
 private draftTimer?: ReturnType<typeof setTimeout>;
 private draftRevision = 0;
 private draftUpdated = 0;
 private draftWrites = Promise.resolve();
 private forkRequest?: {id:string;turn:string};
 private pageHide = () => this.persist();
  private historyRetryAt = 0;
  private historyNeedsSync = false;
  private historyRevision = 0;
  private savedKeys = new Set<string>();
  private sessionRevision = 0;
  private echoes = new Map<string, {entry: Entry; known: Set<string>; turn?: string; steering: boolean}>();
  private visibilityChanged = () => {
    if (!this.options.readOnly || !this.connected) return;
    this.streamAbort?.abort(); this.streamAbort = undefined; this.historyRetryAt = 0;
    if (this.snapshot.terminal) this.update({terminal: {...this.snapshot.terminal, connected: false}});
    if (!document.hidden) void this.history().then(() => this.watchHistory());
  };
  constructor(public options: ChatOptions) {
    this.snapshot = {session: options.session, entries: [], chat: idleChat(), project: options.target?.project_id || options.task?.primary_project_id || "", draft: "", error: "", historyError: "", loading: false, submitting: false, stopping: false, answering: null, cursor: null, draftRestore: 0, settings: options.session ? {} : newConversationSettings(), models: [], modes: [], optionsLoading: false, draftNotice: "", search: "", searching:false, searchError:"", managing:false};
    if (options.persistDraft && !options.readOnly) { const saved = readLocalDraft(conversationKey(options)); if (saved) this.restoreDraft(saved); }
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<Snapshot>) {
    if (patch.session?.name && patch.session.name !== this.snapshot.session?.name) this.sessionRevision++;
    const next = {...this.snapshot, ...patch};
    if (this.echoes.size && (patch.entries || patch.chat)) {
      const actual = mergeEntries(next.entries, next.chat.entries).filter(e => !e.id.startsWith("local:"));
      const claimed = new Set<string>();
      for (const [request, echo] of this.echoes) {
        if (!echo.steering && next.chat.id === request && next.chat.turn_id) echo.turn = next.chat.turn_id;
        // Native steering items need not reuse clientUserMessageId. Match a
        // newly observed item in the same turn, reserving explicit request IDs
        // for their own echoes and consuming each item only once.
        const confirmed = actual.find(e => e.kind === "user" && !claimed.has(entryKey(e)) && (e.id === request || !this.echoes.has(e.id) && !!echo.turn && e.turn_id === echo.turn && !echo.known.has(entryKey(e)) && (e.text || "").trim() === (echo.entry.text || "") && (e.images?.length || 0) === (echo.entry.images?.length || 0)));
        if (confirmed) { claimed.add(entryKey(confirmed)); next.entries = next.entries.filter(e => e.id !== echo.entry.id); this.echoes.delete(request); }
      }
      // A later snapshot of the same item cannot acknowledge another send
      // whose text happens to be identical.
      for (const echo of this.echoes.values()) for (const key of claimed) echo.known.add(key);
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  private removeEcho(request: string) {
    const echo = this.echoes.get(request);
    this.echoes.delete(request);
    if (echo) this.update({entries: this.snapshot.entries.filter(e => e.id !== echo.entry.id)});
  }
  private base() { return `/api/sessions/${encodeURIComponent(this.snapshot.session!.id)}`; }
  canSend = () => !this.options.readOnly && !this.snapshot.session?.archived && (!!this.snapshot.session || (this.options.task
    ? this.options.task.state === "ready" : !!(this.options.target?.task_id || this.options.target?.project_id && this.options.target?.cwd)));
  resume = async () => {
    if (!this.snapshot.session) return;
    try { await this.options.request(this.base() + "/resume", {method: "POST"}); }
    catch (error) { this.update({error: (error as Error).message}); }
  };
  setDraft = (draft: string) => { if (draft !== this.snapshot.draft) { this.update({draft}); this.draftChanged(); } };
  setError = (error: string) => this.update({error});
  updateSession = (session: Session) => {
    if (this.snapshot.session?.id === session.id) this.update({session: {...this.snapshot.session, ...session}});
  };
  setProject = (project: string) => {this.update({project}); this.draftChanged();};
  setSettings = (settings: TurnSettings) => {this.update({settings});this.draftChanged();};
  attachmentsChanged = () => this.draftChanged();
  connect() {
    this.disconnect(); this.connected = true; this.readAbort = new AbortController();
    this.opening = true;
    const generation = this.generation;
    const draft = this.options.persistDraft && !this.options.readOnly ? this.loadDraft() : Promise.resolve();
    const opened = () => {
      if (!this.connected || generation !== this.generation) return;
      const latest = this.latestMessage();
      if (latest && this.reading.latest !== undefined && latest !== this.reading.latest) this.reading.bottom = true;
      // Older saved positions have no read marker. Establish their baseline
      // without losing the user's position on the first opening after upgrade.
      if (latest && (this.reading.bottom || this.reading.latest === undefined)) this.reading.latest = latest;
      this.opening = false;
      this.update({});
    };
    if (this.options.persistDraft && !this.options.readOnly && typeof window !== "undefined") window.addEventListener("pagehide", this.pageHide);
    if (this.options.readOnly) {
      document.addEventListener?.("visibilitychange", this.visibilityChanged);
      void this.history().then(() => {opened(); return this.watchHistory();});
      this.timer = setInterval(() => {
        if (!this.connected || document.hidden || !this.snapshot.session) return;
        if (!this.snapshot.terminal?.connected || this.historyNeedsSync) void this.history();
        void this.watchHistory();
      }, 1000);
      return;
    }
    void Promise.all([draft, this.history(), this.poll()]).then(opened);
    this.timer = setInterval(() => { if (this.connected && !document.hidden && this.snapshot.session) void this.poll(); }, 2000);
  }
  disconnect() {
    if (this.connected) this.persist();
    if (typeof window !== "undefined") window.removeEventListener("pagehide",this.pageHide);
    if (typeof document !== "undefined") document.removeEventListener?.("visibilitychange", this.visibilityChanged);
    this.connected = false; this.generation++; clearInterval(this.timer);
    this.readAbort?.abort(); this.streamAbort?.abort(); this.streamAbort = undefined; this.streamRun = undefined;
    this.polling = false; this.update({loading: false});
    this.historyRetryAt = 0;
    if (this.snapshot.terminal) this.update({terminal: {...this.snapshot.terminal, connected: false}});
  }
  async history(older = false) {
    if (!this.snapshot.session || this.snapshot.loading || !this.connected) return;
    const generation = this.generation;
    const revision = this.historyRevision;
    const sessionRevision = this.sessionRevision;
    const cursor = older ? this.snapshot.cursor : null;
    if (older && !cursor) return;
    this.update({loading: true, historyError: ""});
    try {
      let page = await this.options.request<History>(this.base() + "/history" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""), {signal: this.readAbort?.signal});
      if (generation !== this.generation) return;
      if (cursor && page.next_cursor === cursor) throw new Error("历史分页游标重复");
      let fresh = page.entries;
      const known = this.savedKeys;
      const cursors = new Set<string>();
      // Catch up without dropping turns between the newest page and our history.
      while (!older && page.next_cursor && (known.size > 0 && !fresh.some(e => known.has(entryKey(e))) || !this.options.readOnly && page.has_user_message === false && !fresh.some(e => e.kind === "user"))) {
        if (cursors.has(page.next_cursor)) throw new Error("历史分页游标重复");
        cursors.add(page.next_cursor);
        page = await this.options.request<History>(this.base() + "/history?cursor=" + encodeURIComponent(page.next_cursor), {signal: this.readAbort?.signal});
        if (generation !== this.generation) return;
        fresh = [...page.entries, ...fresh];
      }
      // A stream snapshot can arrive while a history page is in flight. Keep
      // those newer parts; otherwise let saved history finish completed parts.
      const entries = older ? mergeEntries(fresh, this.snapshot.entries) : mergeHistoryEntries(this.snapshot.entries, fresh);
      const live = this.snapshot.terminal?.entries.filter(e => e.status === "inProgress" || revision !== this.historyRevision) || [];
      const session = {...this.snapshot.session, ...page.session};
      if (sessionRevision !== this.sessionRevision && this.snapshot.session) session.name = this.snapshot.session.name;
      this.update({session, entries: mergeEntries(entries, live), cursor: older || !known.size ? page.next_cursor || null : this.snapshot.cursor});
      for(const entry of fresh)this.savedKeys.add(entryKey(entry));
      if (!older && revision === this.historyRevision) this.historyNeedsSync = false;
    } catch (error) { if (generation === this.generation && !this.readAbort?.signal.aborted) this.update({historyError: String((error as Error).message)}); }
    finally { if (generation === this.generation) this.update({loading: false}); }
  }
  private async watchHistory() {
    if (!this.connected || !this.options.readOnly || !this.snapshot.session || this.streamAbort || document.hidden || Date.now() < this.historyRetryAt) return;
    const generation = this.generation;
    const abort = new AbortController(); this.streamAbort = abort;
    try {
      const response = await this.options.stream(this.base() + "/history/events", abort.signal);
      if (!response.headers.get("Content-Type")?.startsWith("text/event-stream")) throw new Error("服务未返回实时事件流");
      await readSnapshots<HistoryPush>(response, terminal => {
        if (generation !== this.generation || abort.signal.aborted) return;
        const previous = this.snapshot.terminal;
        if (terminal.connected) {
          if (previous && previous.sync !== terminal.sync) this.historyNeedsSync = true;
          this.historyRevision++;
          this.update({terminal: {...terminal, entries: terminal.entries || []}, entries: mergeEntries(this.snapshot.entries, terminal.entries || [])});
        } else this.update({terminal: {...previous, ...terminal, entries: previous?.entries || []}});
      });
    } catch { /* Saved history continues polling while the stream reconnects. */ }
    finally {
      abort.abort();
      if (generation === this.generation && this.streamAbort === abort) {
        this.streamAbort = undefined;
        this.historyRetryAt = Date.now() + 5000;
        this.update({terminal: {...this.snapshot.terminal, connected: false, entries: this.snapshot.terminal?.entries || [], sync: this.snapshot.terminal?.sync || 0}});
      }
    }
  }
  private apply(chat: ChatState) {
    const previous = this.snapshot.chat;
    if (!chat.busy && chat.id === this.handoffID) this.handoffID = undefined;
    if (previous.busy && !chat.id && !previous.external && !chat.external) return;
    if (chat.id === previous.id && (chat.revision || 0) < (previous.revision || 0)) return;
    const pendingQuestions = new Set(chat.approvals.filter(a => a.kind === "questions").map(a => JSON.stringify([chat.id, a.id])));
    for (const key of this.questionDrafts.keys()) if (!key.startsWith('["async",') && (!chat.busy || !pendingQuestions.has(key))) this.questionDrafts.delete(key);
    if (chat.session_name && chat.session_name !== previous.session_name && this.snapshot.session) {
      this.update({session: {...this.snapshot.session, name: chat.session_name}});
      this.options.managed?.(this.snapshot.session!, "title");
    }
    if (chat.turn_id && this.submitted?.id === chat.id) this.submitted = undefined;
    if (!chat.busy && !chat.turn_id && this.submitted && this.submitted.id === chat.id) {
      this.removeEcho(chat.id!);
      if (!this.snapshot.draft && !this.draftAttachments.length) {
        this.draftAttachments = this.submitted.attachments;
        this.update({draft: this.submitted.text, draftRestore: this.snapshot.draftRestore + 1});this.draftChanged();
      }
      this.submitted = undefined;
    }
    if (!chat.busy) {
      chat = {...chat, entries: chat.entries.map(e => e.status === "inProgress" ? {...e, status: chat.status === "completed" ? "completed" : "interrupted"} : e)};
      this.update({entries: mergeEntries(this.snapshot.entries, chat.entries), chat});
    } else this.update({chat});
    if (this.snapshot.session) this.options.activity?.(this.snapshot.session.id, chat);
    if (chat.external || previous.busy && !chat.busy) { this.streamAbort?.abort(); void this.history(); }
    if (chat.busy && chat.id && !chat.external && this.connected) void this.watch(chat.id);
  }
  async poll() {
    if (this.options.readOnly || !this.snapshot.session || !this.connected || this.polling) return;
    const generation = this.generation;
    this.polling = true;
    const observedRun = this.snapshot.chat.id;
    try {
      const chat = await this.options.request<ChatState>(this.base() + "/chat", {signal: this.readAbort?.signal});
      if (generation === this.generation && (this.snapshot.chat.id === observedRun || chat.id === this.snapshot.chat.id)) this.apply(chat);
    } catch (error) { if (generation === this.generation && !this.readAbort?.signal.aborted) this.update({error: "状态读取失败：" + (error as Error).message}); }
    finally { if (generation === this.generation) this.polling = false; }
  }
  private async watch(id: string) {
    if (this.streamRun === id) return;
    this.streamAbort?.abort();
    const abort = new AbortController(); this.streamAbort = abort; this.streamRun = id;
    const generation = this.generation;
    try {
      const response = await this.options.stream(this.base() + "/chat/events?run=" + encodeURIComponent(id), abort.signal);
      await readSnapshots(response, chat => { if (generation === this.generation && !abort.signal.aborted) { this.update({error: ""}); this.apply(chat); } });
    } catch (error) { if (!abort.signal.aborted && generation === this.generation) this.update({error: "实时连接暂时断开，将自动重连，不会重复发送消息。"}); }
    finally { if (this.streamAbort === abort) this.streamRun = undefined; }
  }
  send = async (text: string, images: string[] = [], restoreDraftOnError = true) => {
    if (this.options.readOnly || this.snapshot.chat.external && (this.snapshot.chat.busy || this.snapshot.chat.status === "unknown")) return;
    text = text.trim();
    const messageText = [text, ...draftFiles(this.draftAttachments).map(f=>f.text)].filter(Boolean).join("\n\n");
    const before = this.snapshot;
    const steering = before.chat.busy;
    if (!messageText && !images.length) return;
    if (before.submitting || (steering && (!before.chat.turn_id || !["running","waiting"].includes(before.chat.status))) || before.chat.blocked || !this.canSend()) throw new Error("当前暂不能发送，草稿已保留，请稍后重试");
    try { validateImages(images); }
    catch (error) { this.update({error: (error as Error).message}); throw error; }
    const target: SessionTarget & {project_id: string} = before.session ? {project_id: ""}
      : {...this.options.target, ...(this.options.task ? {task_id: this.options.task.id} : {}), project_id: before.project};
    const samePending = this.pending?.text === messageText && this.pending.project_id === target.project_id && this.pending.task_id === target.task_id && this.pending.cwd === target.cwd
      && JSON.stringify(this.pending.additional_directories) === JSON.stringify(target.additional_directories)
      && (this.pending.images || []).length === images.length
      && images.every((image, i) => image === this.pending?.images?.[i])
      && this.pending?.turn_id === (steering ? before.chat.turn_id : undefined) && (steering || JSON.stringify(this.pending?.settings || {}) === JSON.stringify(before.settings));
    const pending = samePending ? this.pending! : {text: messageText, ...(images.length ? {images} : {}), ...target, request_id: crypto.randomUUID(), settings: before.settings, ...(steering ? {turn_id:before.chat.turn_id} : {})};
    this.pending = pending;
    const attachments = this.draftAttachments;
    const entry: Entry = {id: "local:" + pending.request_id, turn_id: "local:" + pending.request_id, kind: "user", text: messageText, ...(images.length ? {images} : {})};
    this.echoes.set(pending.request_id, {entry, known: new Set(mergeEntries(before.entries, before.chat.entries).map(entryKey)), turn: steering ? before.chat.turn_id : undefined, steering});
    // Preserve the current live turn before appending a steering message.
    this.update({submitting: true, error: "", entries: [...mergeEntries(before.entries, before.chat.entries), entry]});
    this.update({draft: ""}); this.draftChanged();
    try {
      let chat: ChatState;
      if (steering) {
        const result = await this.options.request<{chat:ChatState;accepted:string}>(this.base()+"/chat/steer", {method:"POST",body:JSON.stringify({text: messageText,images,request_id:pending.request_id,turn_id:pending.turn_id})});
        if (result.accepted !== pending.request_id) throw new Error("补充消息未确认，草稿已保留");
        chat = result.chat;
      } else if (!before.session) {
        const result = await this.options.request<{session: Session; chat: ChatState}>("/api/sessions/new", {method: "POST", body: JSON.stringify(pending)});
        this.update({session: result.session}); this.options.created(result.session); chat = result.chat;
      } else {
        chat = await this.options.request<ChatState>(this.base() + "/chat", {method: "POST", body: JSON.stringify({text: messageText, ...(images.length ? {images} : {}), request_id: pending.request_id, ...(Object.keys(before.settings).length ? {settings:before.settings} : {})})});
      }
      this.settleAttachments(attachments);
      this.pending = undefined; if (!steering) this.submitted = {id: chat.id, text, attachments}; this.apply(chat); this.draftChanged();
      if (steering && !chat.busy) void this.history();
      if (!before.session) this.clearCreationDraft();
    } catch (error) {
      // Recover an acknowledged turn after a lost POST response. Never resend it.
      if (before.session) {
        try {
          const chat = await this.options.request<ChatState>(this.base() + "/chat");
          if ((!steering && chat.id === pending.request_id) || (steering && chat.accepted_inputs?.includes(pending.request_id))) { this.settleAttachments(attachments); this.pending = undefined; if (!steering) this.submitted = {id: chat.id, text, attachments}; this.apply(chat); this.draftChanged();
      if (steering && !chat.busy) void this.history();
      if (!before.session) this.clearCreationDraft(); return; }
        } catch { /* Keep the same idempotency key for an explicit retry. */ }
      }
      this.removeEcho(pending.request_id);
      if (restoreDraftOnError && !this.snapshot.draft) {
        this.update({draft: text}); this.draftChanged();
      }
      this.update({error: (error as Error).message});
      throw error;
    } finally { this.update({submitting: false}); }
  };
  private settleAttachments(attachments:readonly Attachment[]) {
    const sent=new Set(attachments.map(a=>a.id));
    this.draftAttachments=this.draftAttachments.filter(a=>!sent.has(a.id));
  }
  private restoreDraft(record: DraftRecord) {
    this.draftUpdated = record.updated;
    this.reading = {...record.reading};
    this.draftAttachments = [...restoreImages(record.images), ...restoreFiles(record.files)];
    for (const [key, draft] of Object.entries(record.questions || {})) {
      if (key.startsWith('["async",') && draft && typeof draft === "object") this.questionDrafts.set(key, draft);
    }
    this.update({draft:record.text,settings:this.snapshot.session ? record.settings : newConversationSettings(record.settings),project:record.project || this.snapshot.project,draftRestore:this.snapshot.draftRestore+1});
  }
  private async loadDraft() {
    const revision=this.draftRevision;
    const key=conversationKey(this.options,this.snapshot.session?.id || null);
    try {
      const saved=await this.options.request<unknown>("/api/conversation-drafts?key="+encodeURIComponent(key));
      if (this.connected && revision===this.draftRevision && validDraft(saved) && saved.updated>=this.draftUpdated && !this.snapshot.submitting) this.restoreDraft(saved);
    } catch {this.update({draftNotice:"暂时无法恢复本地草稿，将在下次保存时重试"});}
  }
  private draftChanged() {
    this.draftRevision++;
    if (!this.options.persistDraft || this.options.readOnly) return;
    clearTimeout(this.draftTimer); this.draftTimer=setTimeout(()=>this.persist(),350);
  }
  persist = () => {
    clearTimeout(this.draftTimer);
    if (!this.options.persistDraft || this.options.readOnly) return;
    const key=conversationKey(this.options,this.snapshot.session?.id || null);
    this.draftUpdated=Math.max(Date.now(),this.draftUpdated+1);
    const questions = Object.fromEntries([...this.questionDrafts].filter(([key]) => key.startsWith('["async",')));
    const record:DraftRecord={text:this.snapshot.draft,images:draftImages(this.draftAttachments),files:draftFiles(this.draftAttachments),settings:this.snapshot.settings,project:this.snapshot.project,reading:this.reading,updated:this.draftUpdated,questions};
    cacheDraft(key,record);this.writeDraft(key,record);
  };
  private writeDraft(key:string,record:DraftRecord) {
    this.draftWrites=this.draftWrites.then(async()=>{
      try {await this.options.request("/api/conversation-drafts?key="+encodeURIComponent(key),{method:"POST",body:JSON.stringify(record)});this.update({draftNotice:""});}
      catch {this.update({draftNotice:"草稿暂未保存到后台，连接恢复后会重试，请保持页面打开"});if(this.connected){clearTimeout(this.draftTimer);this.draftTimer=setTimeout(()=>this.persist(),5000);}}
    });
  }
  private clearCreationDraft() {
    if (!this.options.persistDraft) return;
    const key=conversationKey(this.options,null);
    const empty:DraftRecord={text:"",images:[],settings:{},project:"",reading:{top:0,bottom:true,anchor:"",offset:0},updated:Date.now()+1};
    cacheDraft(key,empty);this.writeDraft(key,empty);
  }
  loadOptions = async () => {
    if(this.snapshot.optionsLoading) return;
    this.update({optionsLoading:true});
    try {
      const [catalog,context] = await Promise.all([this.options.readOnly ? Promise.resolve({models:[],modes:[]}) : this.options.request<{models:ChatModel[];modes:string[]}>("/api/codex/chat-options"),this.snapshot.session ? this.options.request<ChatContext>(this.base()+"/context") : Promise.resolve(undefined)]);
      this.update({models:catalog.models||[],modes:catalog.modes||[],context});
    } catch(error){this.update({error:(error as Error).message});}
    finally{this.update({optionsLoading:false});}
  };
  setSearch = (search:string) => this.update({search,searchError:""});
  searchAll = async () => {
    if(this.snapshot.searching || !this.snapshot.session) return;
    this.update({searching:true,searchError:""});
    try {while(this.snapshot.cursor && this.connected){const cursor=this.snapshot.cursor;await this.history(true);if(this.snapshot.historyError)throw new Error(this.snapshot.historyError);if(cursor===this.snapshot.cursor)throw new Error("历史正在加载，请稍后重试");}}
    catch(error){this.update({searchError:(error as Error).message});}
    finally{this.update({searching:false});}
  };
  manage = async (action:string,name?:string,turn="") => {
    if(!this.snapshot.session || this.snapshot.managing || this.options.readOnly) return;
    this.update({managing:true,error:""});
    if(action==="fork" && this.forkRequest?.turn!==turn)this.forkRequest={id:crypto.randomUUID(),turn};
    try {
      const result=await this.options.request<{session:Session}>(this.base()+"/manage",{method:"POST",body:JSON.stringify({action,name,turn_id:turn,request_id:action==="fork"?this.forkRequest?.id:undefined})});
      if(action!=="fork")this.update({session:{...this.snapshot.session,...result.session}});
      else this.forkRequest=undefined;
      this.options.managed?.(result.session,action);
    } catch(error){this.update({error:(error as Error).message});}
    finally{this.update({managing:false});}
  };
  handoff = async () => {
    if (this.options.readOnly) return;
    if (!this.snapshot.chat.can_handoff || this.snapshot.chat.busy || this.snapshot.submitting) return;
    this.handoffID ||= crypto.randomUUID();
    this.update({submitting: true, error: ""});
    try { this.apply(await this.options.request<ChatState>(this.base() + "/chat/handoff", {method: "POST", body: JSON.stringify({request_id: this.handoffID})})); }
    catch (error) { this.update({error: (error as Error).message}); }
    finally { this.update({submitting: false}); }
  };
  stop = async () => {
    if (this.snapshot.chat.external) return;
    if (this.options.readOnly) return;
    const {chat, stopping} = this.snapshot;
    if (!chat.busy || !chat.id || stopping) return;
    this.update({stopping: true, error: ""});
    try { this.apply(await this.options.request<ChatState>(this.base() + "/chat/stop", {method: "POST", body: JSON.stringify({run_id: chat.id})})); }
    catch (error) { this.update({error: (error as Error).message}); }
    finally { this.update({stopping: false}); }
  };
  openApprovalURL = async (approval: Approval) => {
    if (this.options.readOnly) return;
    const {chat, stopping} = this.snapshot;
    if (this.openingApproval || stopping || !chat.busy || chat.status === "stopping") return;
    this.openingApproval = true;
    this.update({error: ""});
    try { await this.options.request(this.base() + "/chat/approval/open", {method: "POST", body: JSON.stringify({run_id: chat.id, approval_id: approval.id})}); }
    catch (error) { this.update({error: (error as Error).message}); }
    finally { this.openingApproval = false; }
  };
  answer = async (approval: Approval, decision: string, answers: Record<string, string[]>, content?: Record<string, unknown>) => {
    if (this.options.readOnly) return;
    const asyncQuestion = approval.delivery === "async";
    if (this.snapshot.answering || this.snapshot.submitting || !asyncQuestion && !this.snapshot.chat.busy) return;
    this.update({answering: approval.id, error: ""});
    try {
      const runID = this.snapshot.chat.id;
      const chat = await this.options.request<ChatState>(this.base() + (asyncQuestion ? "/chat/question" : "/chat/approval"), {method: "POST", body: JSON.stringify(asyncQuestion
        ? {item_id: approval.id, turn_id: approval.turn_id, decision, answers}
        : {run_id: runID, approval_id: approval.id, decision, answers, ...(content === undefined ? {} : {content})})});
      if (asyncQuestion) this.resolvedQuestions.add(JSON.stringify([approval.turn_id, approval.id]));
      this.questionDrafts.delete(questionDraftKey(approval, runID));
      this.apply(chat); this.draftChanged();
      if (asyncQuestion) { this.persist(); void this.history(); }
    }
    catch (error) { this.update({error: (error as Error).message}); }
    finally { this.update({answering: null}); }
  };
}
