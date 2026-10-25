import type { ThreadMessageLike } from "@assistant-ui/react";
import type {ApprovalChoice, Elicitation} from "./approval";

export interface Entry {
  id: string; turn_id: string; kind: string; text?: string; command?: string; cwd?: string;
  tool?: string; images?: string[]; local_images?: Record<string,string>; status?: string; output?: string | null; exit_code?: number | null; duration_ms?: number | null;
}
export interface Question { id: string; header: string; question: string; isOther?: boolean; isSecret?: boolean; options?: {label: string; description: string}[] }
export interface QuestionDraft { choice?: string; text: string }
export interface Approval { id: string; title: string; details: string; kind: string; can_accept: boolean; questions?: Question[]; choices?: ApprovalChoice[]; elicitation?: Elicitation }
export interface ChatState { id?: string; revision?: number; turn_id?: string; status: string; busy: boolean; external?: boolean; entries: Entry[]; approvals: Approval[]; error?: string; blocked?: string; can_handoff?: boolean; notice?: string; accepted_inputs?: string[]; context?: ChatContext; session_name?: string }
export interface HistoryPush { connected: boolean; entries: Entry[]; sync: number; message?: string; waiting?: boolean; confirmations?: {id: string; title: string; details?: string; questions?: Question[]}[] }
export interface Session { id: string; name: string; cwd: string; available?: boolean; pinned?: boolean; archived?: boolean; model?: string; reasoningEffort?: string }
export interface Task { id: string; name: string; state: string; primary_project_id: string; members: {project_id: string; project_name: string; path: string}[] }
export type PermissionMode = "ask" | "auto" | "full";
export interface TurnSettings {model?: string;effort?: string;mode?: string;permission?: PermissionMode}
export interface ChatContext {model?:string;reasoningEffort?:string;mode?:string;cwd?:string;approvalPolicy?:unknown;approvalsReviewer?:string;sandbox?:{type?:string;writableRoots?:string[];networkAccess?:boolean};additional_directories?:string[]}
export interface ChatModel {id:string;model:string;displayName:string;isDefault:boolean;defaultReasoningEffort:string;supportedReasoningEfforts:{reasoningEffort:string}[]}
export const entryKey = (e: Entry) => JSON.stringify([e.turn_id, e.id]);
export const cleanText = (value?: string | null) => String(value ?? "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
export function mergeEntries(saved: Entry[], live: Entry[]) {
  const entries = new Map(saved.map(e => [entryKey(e), e]));
  for (const e of live) entries.set(entryKey(e), e);
  return [...entries.values()];
}
// Merge a chronological saved page around known anchors. A completed live
// snapshot can arrive before the initial history response; those newer items
// must remain after the saved page, including after a full page reload.
export function mergeHistoryEntries(saved:Entry[],fresh:Entry[]) {
 const savedKeys=new Set(saved.map(entryKey));
 const values=new Map(fresh.map(e=>[entryKey(e),e]));
 const shared=saved.filter(e=>values.has(entryKey(e)));
 if(!shared.length)return mergeEntries(fresh,saved);
 const before=new Map<string,Entry[]>();let next="";
 for(let i=fresh.length-1;i>=0;i--){const entry=fresh[i],key=entryKey(entry);if(savedKeys.has(key))next=key;else{const bucket=before.get(next)||[];bucket.push(entry);before.set(next,bucket);}}
 const out:Entry[]=[];const last=entryKey(shared.at(-1)!);
 for(const entry of saved){const key=entryKey(entry);out.push(...(before.get(key)||[]).slice().reverse(),values.get(key)||entry);if(key===last)out.push(...(before.get("")||[]).slice().reverse());}
 return out;
}
export function convertEntry(entry: Entry): ThreadMessageLike {
  const id = entryKey(entry);
  if (entry.kind === "user") return { id, role: "user", content: [{type: "text", text: cleanText(entry.text)}, ...(entry.images || []).filter(image=>/^data:image\/(png|jpeg|gif|webp);base64,/.test(image) || !!entry.local_images?.[image]).map(image=>({type:"image" as const,image}))] };
  const status = entry.status === "inProgress" ? {type: "running" as const} : {type: "complete" as const, reason: "stop" as const};
  if (entry.kind === "assistant") return { id, role: "assistant", status, content: [{type: "text", text: cleanText(entry.text)}] };
  // Feed the official ToolFallback its normal args/result shape. Output is a
  // result, never a command argument, and remains available after expansion.
  const args: Record<string,string> = entry.kind === "change"
    ? {changes: cleanText(entry.text), ...(entry.cwd ? {cwd: cleanText(entry.cwd)} : {})}
    : entry.kind === "activity" ? {activity: cleanText(entry.text)} : {command: cleanText(entry.command), ...(entry.cwd ? {cwd: cleanText(entry.cwd)} : {})};
  const result = {status: entry.status || "unknown", ...(entry.output != null ? {output: cleanText(entry.output)} : {}), ...(entry.exit_code != null ? {exit_code: entry.exit_code} : {}), ...(entry.duration_ms != null ? {duration_ms: entry.duration_ms} : {})};
  return { id, role: "assistant", status, content: [{type: "tool-call", toolCallId: id, toolName: entry.tool || ({command:"执行命令",change:"文件修改"}[entry.kind] || entry.kind), args, argsText: JSON.stringify(args, null, 2), ...(entry.status !== "inProgress" || entry.output != null ? {result} : {}), ...(entry.status === "inProgress" ? {isPreliminary: true} : {}), ...(entry.status === "failed" ? {isError: true} : {})}] };
}

// One assistant message per turn lets the registry group adjacent tool calls,
// show one action bar and lay out text/tool parts as a continuous reply.
export function convertEntries(entries: Entry[]): ThreadMessageLike[] {
  const messages: ThreadMessageLike[] = [];
  let previousTurn: string | undefined;
  for (const entry of entries) {
    const message = convertEntry(entry);
    const previous = messages.at(-1);
    if (previous?.role === "assistant" && message.role === "assistant" && previousTurn === entry.turn_id) {
      const content = [...(typeof previous.content === "string" ? [{type: "text" as const, text: previous.content}] : previous.content)];
      const parts = typeof message.content === "string" ? [{type: "text" as const, text: message.content}] : message.content;
      for (const part of parts) {
        const last = content.at(-1);
        if (last?.type === "text" && part.type === "text") content[content.length - 1] = {...last, text: last.text + "\n\n" + part.text};
        else content.push(part);
      }
      messages[messages.length - 1] = {...previous, content, status: previous.status?.type === "running" || message.status?.type === "running" ? {type: "running"} : message.status};
    } else messages.push(message);
    previousTurn = entry.turn_id;
  }
  return messages;
}
export const idleChat = (): ChatState => ({status: "idle", busy: false, entries: [], approvals: []});

// The stream carries display snapshots, never raw reasoning or credentials.
export async function readSnapshots<T = ChatState>(response: Response, receive: (state: T) => void) {
  if (!response.ok || !response.body) throw new Error("实时连接失败，请稍后重试");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const {value, done} = await reader.read();
      buffer += decoder.decode(value, {stream: !done});
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data) receive(JSON.parse(data));
      }
      if (buffer.length > 8 * 1024 * 1024) throw new Error("实时事件过大，请刷新历史");
      if (done) break;
    }
  } finally { reader.releaseLock(); }
}
