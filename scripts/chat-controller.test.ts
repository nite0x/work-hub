import {test} from "node:test";
import assert from "node:assert/strict";
import {ChatController, type ChatOptions} from "../frontend/chat/controller";
import {convertEntries, convertEntry, idleChat, readSnapshots, mergeEntries, type ChatState} from "../frontend/chat/model";

const task = {id: "task", name: "跨项目任务", state: "ready", primary_project_id: "p", members: [{project_id:"p", project_name:"项目", path:"/home/test/workspaces/task/p"}]};
const session = {id:"thread", name:"会话", cwd:task.members[0].path};
function setup(request: ChatOptions["request"], isNew = false) {
  return new ChatController({task, session: isNew ? null : session, environment:"wsl-ubuntu", request, stream: async () => {throw new Error("offline");}, created() {}, close() {}});
}
const running = (id = "request"): ChatState => ({...idleChat(), id, turn_id:"turn", status:"running", busy:true});

test("official tool rendering receives live output without marking an executing command complete", () => {
  const message = convertEntry({id:"command", turn_id:"turn", kind:"command", command:"npm test", cwd:"/workspace", status:"inProgress", output:"\x1b[32mstarted\x1b[0m"});
  assert.equal(message.status?.type,"running");
  assert.notEqual(typeof message.content,"string");
  const part = message.content[0];
  assert.equal(typeof part,"object");
  if (typeof part !== "object" || part.type !== "tool-call") throw new Error("Expected a tool call");
  assert.deepEqual(part.args,{command:"npm test",cwd:"/workspace"});
  assert.equal(part.isPreliminary,true);
  assert.equal(part.result.output,"started");
  assert.deepEqual(JSON.parse(part.argsText || ""),part.args);
});

test("official tool rendering retains failure details and file changes as inert data", () => {
  const message = convertEntry({id:"command",turn_id:"turn",kind:"command",command:"npm test",status:"failed",output:"<script>failed</script>",exit_code:1,duration_ms:1200});
  const part = message.content[0];
  if (typeof part !== "object" || part.type !== "tool-call") throw new Error("Expected a tool call");
  assert.equal(part.isError,true);
  assert.equal(part.isPreliminary,undefined);
  assert.deepEqual(part.result,{status:"failed",output:"<script>failed</script>",exit_code:1,duration_ms:1200});
  const change = convertEntry({id:"diff",turn_id:"turn",kind:"change",text:"+ added\n- removed",status:"completed"}).content[0];
  if (typeof change !== "object" || change.type !== "tool-call") throw new Error("Expected a file change tool call");
  assert.deepEqual(change.args,{changes:"+ added\n- removed"});
});

test("assistant text and tools share one stable message per turn without merging user turns", () => {
  const entries = [{id:"u",turn_id:"first",kind:"user",text:"检查项目"},{id:"a",turn_id:"first",kind:"assistant",text:"开始检查"},{id:"b",turn_id:"first",kind:"assistant",text:"先运行测试"},{id:"c",turn_id:"first",kind:"command",command:"npm test",status:"inProgress"},{id:"d",turn_id:"first",kind:"assistant",text:"等待结果"},{id:"u",turn_id:"second",kind:"user",text:"继续"},{id:"a",turn_id:"second",kind:"assistant",text:"继续处理"}];
  const messages = convertEntries(entries);
  assert.equal(messages.length,4);
  assert.deepEqual(messages.map(message=>message.role),["user","assistant","user","assistant"]);
  assert.equal(messages[1].status?.type,"running");
  const content = messages[1].content;
  if(typeof content === "string") throw new Error("Expected message parts");
  assert.deepEqual(content.map(part=>part.type),["text","tool-call","text"]);
  assert.equal(content[0].type === "text" && content[0].text,"开始检查\n\n先运行测试");
  const updated = convertEntries(entries.map(entry=>entry.id === "c" ? {...entry,status:"completed",output:"passed"} : entry));
  assert.equal(updated[1].id,messages[1].id);
  assert.equal(updated[1].status?.type,"complete");
});

test("a lost creation response reuses its idempotency key and binds the created thread", async () => {
  const bodies: any[] = [];
  let created = "";
  const c = setup(async (_path, options) => {
    bodies.push(JSON.parse(String(options?.body)));
    if (bodies.length === 1) throw new Error("lost response");
    return {session, chat: running(bodies[1].request_id)} as any;
  }, true);
  c.options.created = s => {created = s.id;};
  await assert.rejects(c.send("第一条消息"));
  assert.equal(c.getSnapshot().draft,"第一条消息");
  await c.send("第一条消息");
  assert.equal(bodies[0].request_id,bodies[1].request_id);
  assert.equal(created,"thread"); assert.equal(c.getSnapshot().session?.id,"thread");
});
test("an acknowledged turn is recovered without posting a second time", async () => {
  let id = "", posts = 0;
  const c = setup(async (_path, options) => {
    if (options?.method === "POST") {posts++; id = JSON.parse(String(options.body)).request_id; throw new Error("lost response");}
    return running(id) as any;
  });
  await c.send("继续处理");
  assert.equal(posts,1); assert.equal(c.getSnapshot().chat.busy,true); assert.equal(c.getSnapshot().draft,"");
  await c.send("不能并发发送"); assert.equal(posts,1);
});
test("stop and approval responses target the exact session and run", async () => {
  const calls: {path:string; body:any}[] = [];
  const approval = {id:"approval", title:"执行命令", details:"pwd", kind:"decision", can_accept:true};
  const c = setup(async (path, options) => {
    calls.push({path,body:JSON.parse(String(options?.body))});
    return {...running("same-run"), approvals: path.endsWith("/chat") ? [approval] : []} as any;
  });
  await c.send("运行测试");
  await c.answer(approval,"decline",{}); await c.stop();
  assert.equal(calls[1].path,"/api/requirements/task/sessions/thread/chat/approval");
  assert.deepEqual(calls[1].body,{run_id:"same-run",approval_id:"approval",decision:"decline",answers:{}});
  assert.equal(calls[2].body.run_id,"same-run");
});
test("closing while creation is pending keeps the result without reopening or stopping Codex", async () => {
  let resolve!: (value:any)=>void;
  const calls: string[] = [];
  const c = setup((path) => {calls.push(path); return new Promise(r=>{resolve=r;});},true);
  const sending = c.send("后台继续"); c.disconnect();
  resolve({session,chat:running()}); await sending;
  assert.equal(c.getSnapshot().session?.id,"thread");
  assert.equal(c.getSnapshot().chat.busy,true); assert.equal(calls.length,1);
});
test("SSE handles fragmented Chinese text, CRLF, comments and terminal status", async () => {
  const state = {...running(),entries:[{id:"a",turn_id:"turn",kind:"assistant",text:"中文回复"}]};
  const bytes = new TextEncoder().encode(": heartbeat\r\n\r\ndata: "+JSON.stringify(state)+"\r\n\r\ndata: "+JSON.stringify({...state,busy:false,status:"completed"})+"\n\n");
  const snapshots: ChatState[] = [];
  await readSnapshots(new Response(new ReadableStream({start(stream){for(let i=0;i<bytes.length;i+=3) stream.enqueue(bytes.slice(i,i+3));stream.close();}})),s=>snapshots.push(s));
  assert.equal(snapshots.length,2); assert.equal(snapshots[0].entries[0].text,"中文回复"); assert.equal(snapshots[1].status,"completed");
});
test("history and live snapshots deduplicate by turn and item without dropping newer output", () => {
  const saved = [{id:"a",turn_id:"t1",kind:"assistant",text:"第一轮"},{id:"a",turn_id:"t2",kind:"assistant",text:"第二轮"}];
  const merged = mergeEntries(saved,[{...saved[1],text:"第二轮已完成"}]);
  assert.equal(merged.length,2); assert.equal(merged[1].text,"第二轮已完成");
});

test("an old in-flight poll cannot replace a newly accepted turn", async () => {
  Object.assign(globalThis,{document:{hidden:false}});
  let resolve!: (value:any)=>void;
  const c = setup(async (path, options) => {
    if (path.endsWith("/history")) return {session,entries:[]} as any;
    if (options?.method === "POST") return running("new-run") as any;
    return new Promise(r => {resolve=r;});
  });
  c.connect();
  await c.send("新的一轮");
  resolve({...idleChat(),id:"old-run",status:"completed"});
  await new Promise(r=>setImmediate(r));
  assert.equal(c.getSnapshot().chat.id,"new-run");
  assert.equal(c.getSnapshot().chat.busy,true);
  c.disconnect();
});

test("opening an idle existing conversation needs no previous submitted draft", async () => {
 Object.assign(globalThis,{document:{hidden:false}});
 const c=setup(async path => (path.endsWith("/history") ? {session,entries:[]} : idleChat()) as any);
 c.connect(); await new Promise(r=>setImmediate(r));
 assert.equal(c.getSnapshot().error,"");assert.equal(c.getSnapshot().chat.status,"idle");c.disconnect();
});

test("chat state updates publish session activity for the surrounding list", async () => {
  Object.assign(globalThis, {document: {hidden: false}});
  let chat = idleChat();
  const c = setup(async (path, options) => {
    if (path.endsWith('/history')) return {session, entries: []} as any;
    if (options?.method === 'POST') chat = running('activity-run');
    return chat as any;
  });
  const states: string[] = [];
  c.options.activity = (id, state) => { assert.equal(id, session.id); states.push(state.status); };
  c.connect();
  try {
    await new Promise(r => setImmediate(r));
    await c.send('开始工作');
    chat = {...running('activity-run'), status: 'waiting'};
    await c.poll();
    chat = {...chat, status: 'completed', busy: false};
    await c.poll();
    assert.deepEqual(states, ['idle', 'running', 'waiting', 'completed']);
  } finally { c.disconnect(); }
});
