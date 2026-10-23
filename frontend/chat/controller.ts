import {entryKey, idleChat, mergeEntries, readSnapshots, type Approval, type ChatState, type Entry, type Session, type Task} from "./model";

export interface ChatOptions {
  task: Task; session: Session | null; environment: string;
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
  stream: (path: string, signal: AbortSignal) => Promise<Response>;
  created: (session: Session) => void;
  activity?: (session: string, chat: ChatState) => void;
  close: () => void;
}
export interface Snapshot {
  session: Session | null; entries: Entry[]; chat: ChatState; project: string; draft: string;
  error: string; historyError: string; loading: boolean; submitting: boolean; stopping: boolean;
  answering: string | null; cursor: string | null;
}
type History = {session: Session; entries: Entry[]; next_cursor?: string | null};
export class ChatController {
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
  private submitted?: {id?: string; text: string};
  private pending?: {text: string; project_id: string; request_id: string};
  private openingApproval = false;
  constructor(public options: ChatOptions) {
    this.snapshot = {session: options.session, entries: [], chat: idleChat(), project: options.task.primary_project_id, draft: "", error: "", historyError: "", loading: false, submitting: false, stopping: false, answering: null, cursor: null};
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<Snapshot>) { this.snapshot = {...this.snapshot, ...patch}; for (const listener of this.listeners) listener(); }
  private base() { return `/api/requirements/${encodeURIComponent(this.options.task.id)}/sessions/${encodeURIComponent(this.snapshot.session!.id)}`; }
  setDraft = (draft: string) => { if (draft !== this.snapshot.draft) this.update({draft}); };
  setProject = (project: string) => this.update({project});
  connect() {
    this.disconnect(); this.connected = true; this.readAbort = new AbortController();
    if (this.snapshot.session) { void this.history(); void this.poll(); }
    this.timer = setInterval(() => { if (this.connected && !document.hidden && this.snapshot.session) void this.poll(); }, 2000);
  }
  disconnect() {
    this.connected = false; this.generation++; clearInterval(this.timer);
    this.readAbort?.abort(); this.streamAbort?.abort(); this.streamRun = undefined;
    this.polling = false; this.update({loading: false});
  }
  async history(older = false) {
    if (!this.snapshot.session || this.snapshot.loading || !this.connected) return;
    const generation = this.generation;
    const cursor = older ? this.snapshot.cursor : null;
    if (older && !cursor) return;
    this.update({loading: true, historyError: ""});
    try {
      let page = await this.options.request<History>(this.base() + "/history" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""), {signal: this.readAbort?.signal});
      if (generation !== this.generation) return;
      let fresh = page.entries;
      const known = new Set(this.snapshot.entries.map(entryKey));
      const cursors = new Set<string>();
      // Catch up without dropping turns between the newest page and our history.
      while (!older && known.size && page.next_cursor && !fresh.some(e => known.has(entryKey(e)))) {
        if (cursors.has(page.next_cursor)) throw new Error("历史分页游标重复");
        cursors.add(page.next_cursor);
        page = await this.options.request<History>(this.base() + "/history?cursor=" + encodeURIComponent(page.next_cursor), {signal: this.readAbort?.signal});
        if (generation !== this.generation) return;
        fresh = [...page.entries, ...fresh];
      }
      this.update({entries: older ? mergeEntries(fresh, this.snapshot.entries) : mergeEntries(this.snapshot.entries, fresh), cursor: older || !known.size ? page.next_cursor || null : this.snapshot.cursor});
    } catch (error) { if (generation === this.generation && !this.readAbort?.signal.aborted) this.update({historyError: String((error as Error).message)}); }
    finally { if (generation === this.generation) this.update({loading: false}); }
  }
  private apply(chat: ChatState) {
    const previous = this.snapshot.chat;
    if (!chat.busy && chat.id === this.handoffID) this.handoffID = undefined;
    if (previous.busy && !chat.id) return;
    if (chat.id === previous.id && (chat.revision || 0) < (previous.revision || 0)) return;
    if (!chat.busy && !chat.turn_id && this.submitted && this.submitted.id === chat.id && !this.snapshot.draft) this.update({draft: this.submitted.text});
    if (!chat.busy) {
      chat = {...chat, entries: chat.entries.map(e => e.status === "inProgress" ? {...e, status: chat.status === "completed" ? "completed" : "interrupted"} : e)};
      this.update({entries: mergeEntries(this.snapshot.entries, chat.entries), chat});
    } else this.update({chat});
    if (this.snapshot.session) this.options.activity?.(this.snapshot.session.id, chat);
    if (previous.busy && !chat.busy) { this.streamAbort?.abort(); void this.history(); }
    if (chat.busy && chat.id && this.connected) void this.watch(chat.id);
  }
  async poll() {
    if (!this.snapshot.session || !this.connected || this.polling) return;
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
  send = async (text: string) => {
    text = text.trim();
    const before = this.snapshot;
    if (!text || before.submitting || before.chat.busy || before.chat.blocked || this.options.task.state !== "ready") return;
    const pending = this.pending?.text === text && this.pending.project_id === before.project ? this.pending : {text, project_id: before.project, request_id: crypto.randomUUID()};
    this.pending = pending;
    this.update({submitting: true, error: "", draft: text});
    try {
      let chat: ChatState;
      if (!before.session) {
        const result = await this.options.request<{session: Session; chat: ChatState}>(`/api/requirements/${encodeURIComponent(this.options.task.id)}/sessions/new`, {method: "POST", body: JSON.stringify(pending)});
        this.update({session: result.session}); this.options.created(result.session); chat = result.chat;
      } else {
        chat = await this.options.request<ChatState>(this.base() + "/chat", {method: "POST", body: JSON.stringify({text, request_id: pending.request_id})});
      }
      this.pending = undefined; this.submitted = {id: chat.id, text}; this.update({draft: ""}); this.apply(chat);
    } catch (error) {
      // Recover an acknowledged turn after a lost POST response. Never resend it.
      if (before.session) {
        try {
          const chat = await this.options.request<ChatState>(this.base() + "/chat");
          if (chat.id === pending.request_id) { this.pending = undefined; this.submitted = {id: chat.id, text}; this.update({draft: ""}); this.apply(chat); return; }
        } catch { /* Keep the same idempotency key for an explicit retry. */ }
      }
      this.update({error: (error as Error).message});
      throw error;
    } finally { this.update({submitting: false}); }
  };
  handoff = async () => {
    if (!this.snapshot.chat.can_handoff || this.snapshot.chat.busy || this.snapshot.submitting) return;
    this.handoffID ||= crypto.randomUUID();
    this.update({submitting: true, error: ""});
    try { this.apply(await this.options.request<ChatState>(this.base() + "/chat/handoff", {method: "POST", body: JSON.stringify({request_id: this.handoffID})})); }
    catch (error) { this.update({error: (error as Error).message}); }
    finally { this.update({submitting: false}); }
  };
  stop = async () => {
    const {chat, stopping} = this.snapshot;
    if (!chat.busy || !chat.id || stopping) return;
    this.update({stopping: true, error: ""});
    try { this.apply(await this.options.request<ChatState>(this.base() + "/chat/stop", {method: "POST", body: JSON.stringify({run_id: chat.id})})); }
    catch (error) { this.update({error: (error as Error).message}); }
    finally { this.update({stopping: false}); }
  };
  openApprovalURL = async (approval: Approval) => {
    const {chat, stopping} = this.snapshot;
    if (this.openingApproval || stopping || !chat.busy || chat.status === "stopping") return;
    this.openingApproval = true;
    this.update({error: ""});
    try { await this.options.request(this.base() + "/chat/approval/open", {method: "POST", body: JSON.stringify({run_id: chat.id, approval_id: approval.id})}); }
    catch (error) { this.update({error: (error as Error).message}); }
    finally { this.openingApproval = false; }
  };
  answer = async (approval: Approval, decision: string, answers: Record<string, string[]>, content?: Record<string, unknown>) => {
    if (this.snapshot.answering || !this.snapshot.chat.busy) return;
    this.update({answering: approval.id, error: ""});
    try { this.apply(await this.options.request<ChatState>(this.base() + "/chat/approval", {method: "POST", body: JSON.stringify({run_id: this.snapshot.chat.id, approval_id: approval.id, decision, answers, ...(content === undefined ? {} : {content})})})); }
    catch (error) { this.update({error: (error as Error).message}); }
    finally { this.update({answering: null}); }
  };
}
