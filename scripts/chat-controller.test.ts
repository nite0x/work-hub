import {test} from "node:test";
import assert from "node:assert/strict";
import {ChatController, type ChatOptions} from "../frontend/chat/controller";
import {idleChat, readSnapshots, mergeEntries, type ChatState} from "../frontend/chat/model";

const task = {id: "task", name: "跨项目任务", state: "ready", primary_project_id: "p", members: [{project_id:"p", project_name:"项目", path:"/home/test/workspaces/task/p"}]};
const session = {id:"thread", name:"会话", cwd:task.members[0].path};
function setup(request: ChatOptions["request"], isNew = false) {
  return new ChatController({task, session: isNew ? null : session, environment:"wsl-ubuntu", request, stream: async () => {throw new Error("offline");}, created() {}, close() {}});
}
const running = (id = "request"): ChatState => ({...idleChat(), id, turn_id:"turn", status:"running", busy:true});

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
