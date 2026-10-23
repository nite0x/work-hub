import type { ThreadMessageLike } from "@assistant-ui/react";

export interface Entry {
  id: string; turn_id: string; kind: string; text?: string; command?: string; cwd?: string;
  status?: string; output?: string | null; exit_code?: number | null; duration_ms?: number | null;
}
export interface Question { id: string; header: string; question: string; isSecret?: boolean; options?: {label: string; description: string}[] }
export interface Approval { id: string; title: string; details: string; kind: string; can_accept: boolean; questions?: Question[] }
export interface ChatState { id?: string; revision?: number; turn_id?: string; status: string; busy: boolean; entries: Entry[]; approvals: Approval[]; error?: string; blocked?: string; can_handoff?: boolean; notice?: string }
export interface Session { id: string; name: string; cwd: string; available?: boolean }
export interface Task { id: string; name: string; state: string; primary_project_id: string; members: {project_id: string; project_name: string; path: string}[] }
export const entryKey = (e: Entry) => JSON.stringify([e.turn_id, e.id]);
export const cleanText = (value?: string | null) => String(value ?? "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
export function mergeEntries(saved: Entry[], live: Entry[]) {
  const entries = new Map(saved.map(e => [entryKey(e), e]));
  for (const e of live) entries.set(entryKey(e), e);
  return [...entries.values()];
}
export function convertEntry(entry: Entry): ThreadMessageLike {
  const id = entryKey(entry);
  if (entry.kind === "user") return { id, role: "user", content: [{type: "text", text: cleanText(entry.text)}] };
  const status = entry.status === "inProgress" ? {type: "running" as const} : {type: "complete" as const, reason: "stop" as const};
  if (entry.kind === "assistant") return { id, role: "assistant", status, content: [{type: "text", text: cleanText(entry.text)}] };
  return { id, role: "assistant", status, content: [{type: "tool-call", toolCallId: id, toolName: entry.kind, args: {entry: {...entry}}, argsText: "", ...(entry.status !== "inProgress" ? {result: {status: entry.status}} : {})}] };
}
export const idleChat = (): ChatState => ({status: "idle", busy: false, entries: [], approvals: []});

// The stream carries display snapshots, never raw reasoning or credentials.
export async function readSnapshots(response: Response, receive: (state: ChatState) => void) {
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
