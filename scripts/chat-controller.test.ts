import {test} from "node:test";
import assert from "node:assert/strict";
import {ChatController, conversationKey, type ChatOptions} from "../frontend/chat/controller";
import {convertEntries, convertEntry, idleChat, readSnapshots, mergeEntries, type ChatState, type HistoryPush} from "../frontend/chat/model";

const task = {id: "task", name: "跨项目任务", state: "ready", primary_project_id: "p", members: [{project_id:"p", project_name:"项目", path:"/home/test/workspaces/task/p"}]};
const session = {id:"thread", name:"会话", cwd:task.members[0].path};
function setup(request: ChatOptions["request"], isNew = false) {
  return new ChatController({task, session: isNew ? null : session, environment:"wsl-ubuntu", request, stream: async () => {throw new Error("offline");}, created() {}, close() {}});
}
const running = (id = "request"): ChatState => ({...idleChat(), id, turn_id:"turn", status:"running", busy:true});

test("read-only history streams retain newer parts, poll on disconnect and never call control APIs", async t => {
  Object.assign(globalThis, {document: {hidden: false}});
  let tick!: () => void;
  t.mock.method(globalThis, "setInterval", (fn: () => void) => { tick = fn; return 1; });
  t.mock.method(globalThis, "clearInterval", () => {});
  let push!: (snapshot: HistoryPush) => void;
  let finish!: () => void;
  let resolvePage: ((page: any) => void) | undefined;
  const paths: string[] = [];
  const entry = {id:"a",turn_id:"turn",kind:"assistant",text:"已保存"};
  const c = setup(async (path, init) => {
    assert.equal(init?.method, undefined);
    paths.push(path);
    if (paths.length > 1) return new Promise(resolve => { resolvePage = resolve; });
    return {session, entries:[entry], next_cursor:"older"} as any;
  });
  c.options.readOnly = true;
  c.options.stream = async (path, signal) => {
    assert(path.endsWith("/history/events"));
    return new Response(new ReadableStream({start(stream) {
      push = snapshot => stream.enqueue(new TextEncoder().encode("data: " + JSON.stringify(snapshot) + "\n\n"));
      finish = () => stream.close();
      signal.addEventListener("abort", () => { try {stream.close();} catch {} });
    }}), {headers: {"Content-Type":"text/event-stream"}});
  };
  c.connect();
  const flush = () => new Promise(resolve => setImmediate(resolve));
  try {
    await flush();
    push({connected:true,sync:1,entries:[{...entry,status:"inProgress",text:"实时回复"}],waiting:true,confirmations:[{id:"q",title:"需要确认"}]});
    await flush(); tick(); await flush();
    assert.equal(paths.length, 1);
    assert.equal(c.getSnapshot().terminal?.confirmations?.[0].title, "需要确认");
    const history = c.history();
    push({connected:true,sync:2,entries:[{...entry,status:"completed",text:"最终回复"}]});
    await flush();
    resolvePage!({session,entries:[entry]}); await history;
    assert.equal(c.getSnapshot().entries[0].text, "最终回复");
    assert.equal(c.getSnapshot().cursor, "older");
    finish(); await flush(); tick(); await flush();
    assert.equal(paths.length, 3);
    resolvePage!({session,entries:[{...entry,text:"最终保存"}]}); await flush();
    assert.equal(c.getSnapshot().entries[0].text, "最终保存");
    await c.send("不能发送"); await c.handoff(); await c.stop(); await c.answer({id:"q",title:"q",details:"",kind:"questions",can_accept:true}, "accept", {}); await c.poll();
    assert(paths.every(path => path.endsWith("/history")));
  } finally {c.disconnect();}
});

test("changing an image changes the retry key while identical image retries keep it", async () => {
  const bodies: any[] = [];
  const c = setup(async (_path, options) => {
    bodies.push(JSON.parse(String(options?.body)));
    throw new Error("offline");
  }, true);
  const image = "data:image/png;base64,aGVsbG8=";
  await assert.rejects(c.send("",[image]));
  await assert.rejects(c.send("",[image]));
  await assert.rejects(c.send("",["data:image/png;base64,d29ybGQ="]));
  assert.equal(bodies[0].request_id,bodies[1].request_id);
  assert.notEqual(bodies[1].request_id,bodies[2].request_id);
});

test("image count and total size limits reject without a POST", async () => {
  let calls = 0;
  const c = setup(async () => { calls++; return running() as any; });
  const image = "data:image/png;base64,aGVsbG8=";
  await assert.rejects(c.send("", Array(5).fill(image)), /最多附加 4 张/);
  const large = "data:image/png;base64," + Buffer.alloc(3*1024*1024).toString("base64");
  await assert.rejects(c.send("", [large,large,large]), /总大小不能超过 8 MiB/);
  assert.equal(calls,0);
});

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
  // Further input now steers the active turn rather than silently disappearing.
  await assert.rejects(c.send("运行中补充要求")); assert.equal(posts,2);
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
  assert.equal(calls[1].path,"/api/sessions/thread/chat/approval");
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

test("existing sessions send independently of task state and keep retry identity across task entry points", async () => {
  const bodies: any[] = [];
  const c = setup(async (path, options) => {
    assert(path.startsWith("/api/sessions/thread/"));
    if (options?.method === "POST") bodies.push(JSON.parse(String(options.body)));
    throw new Error("offline");
  });
  c.options.task = {...task,state:"archived"};
  await assert.rejects(c.send("继续这个会话"));
  c.options.task = {...task,id:"another-task"};
  await assert.rejects(c.send("继续这个会话"));
  assert.equal(bodies.length,2);
  assert.equal(bodies[0].request_id,bodies[1].request_id);
});

test("a project worktree creates a conversation without a task", async () => {
  const calls: {path:string; body:any}[] = [];
  const c = new ChatController({session:null,target:{project_id:"project",cwd:"/repo/worktree"},environment:"local",created(){},close(){},stream:async()=>{throw new Error("offline");},request:async(path,options)=>{
    calls.push({path,body:JSON.parse(String(options?.body))});
    return {session:{...session,cwd:"/repo/worktree"},chat:running()} as any;
  }});
  await c.send("检查代码");
  assert.equal(calls[0].path,"/api/sessions/new");
  assert.equal(calls[0].body.project_id,"project");
  assert.equal(calls[0].body.cwd,"/repo/worktree");
  assert.equal(calls[0].body.task_id,undefined);
  assert.equal(c.getSnapshot().session?.id,"thread");
});


test("conversation identity depends on environment and session, while new drafts depend on the target", () => {
 const options: ChatOptions = {task,session,environment:"local",request:async()=>({} as any),stream:async()=>new Response(),created(){},close(){}};
 assert.equal(conversationKey(options),conversationKey({...options,task:{...task,id:"other"}}));
 assert.equal(conversationKey(options),conversationKey({...options,task:undefined,target:{project_id:"p",cwd:session.cwd}}));
 assert.notEqual(conversationKey(options),conversationKey({...options,environment:"wsl"}));
 assert.notEqual(conversationKey({...options,session:null}),conversationKey({...options,task:{...task,id:"other"},session:null}));
 assert.notEqual(conversationKey({...options,task:undefined,session:null,target:{project_id:"p",cwd:"/one"}}),conversationKey({...options,task:undefined,session:null,target:{project_id:"p",cwd:"/two"}}));
});

test("active-turn input uses steer and recovers a lost acknowledgement without another POST",async()=>{
 const posts:{path:string;body:any}[]=[];let accepted:string[]=[];
 const c=setup(async(path,init)=>{
  if(init?.method==='POST'){
   const body=JSON.parse(String(init.body));posts.push({path,body});
   if(path.endsWith('/steer')){accepted.push(body.request_id);throw new Error('lost steer response');}
   return running(body.request_id) as any;
  }
  return {...running(posts[0].body.request_id),accepted_inputs:accepted} as any;
 });
 await c.send('start');c.setDraft('优先修复测试');await c.send('优先修复测试');
 assert.equal(posts.length,2);assert.equal(posts[1].path,'/api/sessions/thread/chat/steer');
 assert.equal(posts[1].body.turn_id,'turn');assert.equal(posts[1].body.text,'优先修复测试');
 assert.equal(c.getSnapshot().draft,'');assert.equal(c.getSnapshot().chat.busy,true);
});

for (const identity of ["generated", "correlated"]) test(`steering reconciles ${identity} message IDs without collapsing repeated user input`, async () => {
  Object.assign(globalThis, {document: {hidden: false}});
  const text = "再检查一次";
  const original = {id: "original", turn_id: "turn", kind: "user", text};
  let native = [original];
  const requests: string[] = [];
  const state = () => ({...running("active"), entries: [...native], accepted_inputs: [...requests]});
  const c = setup(async (path, init) => {
    if (init?.method === "POST") {
      assert(path.endsWith("/chat/steer"));
      requests.push(JSON.parse(String(init.body)).request_id);
      return {accepted: requests.at(-1), chat: state()} as any;
    }
    return (path.endsWith("/history") ? {session, entries: [...native]} : state()) as any;
  });
  const users = () => mergeEntries(c.getSnapshot().entries, c.getSnapshot().chat.entries).filter(e => e.kind === "user");
  c.connect();
  try {
    await new Promise(resolve => setImmediate(resolve));
    await c.send(text);
    await c.send(text);
    assert.equal(users().length, 3);
    // The native item ID can be unrelated to the request ID, or explicitly
    // identify the second message before the first one is observed.
    const first = {...original, id: identity === "generated" ? "native-first" : requests[1]};
    native = [original, first];
    await c.poll();
    assert.equal(users().length, 3);
    const remaining = "local:" + requests[identity === "generated" ? 1 : 0];
    assert.deepEqual(users().filter(e => e.id.startsWith("local:")).map(e => e.id), [remaining]);
    // Repeated snapshots must not use the same native message to confirm two sends.
    await c.poll();
    assert.equal(users().length, 3);
    assert(users().some(e => e.id === remaining));
    native = [original, first, {...original, id: "native-last"}];
    await c.poll();
    await c.history();
    assert.equal(users().length, 3);
    assert(users().every(e => !e.id.startsWith("local:")));
    assert(users().every(e => e.text === text));
  } finally { c.disconnect(); }
});

test("failed steering preserves the same retry identity and never silently starts a new turn",async()=>{
 const posts:any[]=[];
 const c=setup(async(path,init)=>{
  if(init?.method==='POST'){
   const body=JSON.parse(String(init.body));posts.push({path,body});
   if(path.endsWith('/steer'))throw new Error('unconfirmed');return running(body.request_id) as any;
  }
  return running(posts[0].body.request_id) as any;
 });
 await c.send('start');await assert.rejects(c.send('补充'));await assert.rejects(c.send('补充'));
 assert.equal(posts[1].body.request_id,posts[2].body.request_id);
 assert(posts.slice(1).every(p=>p.path.endsWith('/steer')));assert.equal(c.getSnapshot().draft,'补充');
});

test("drafts, images, reading and settings restore through the database on a fresh controller",async()=>{
 Object.assign(globalThis,{document:{hidden:false}});
 const records=new Map<string,any>();
 const make=()=>{
  const c=setup(async(path,init)=>{
   if(path.startsWith('/api/conversation-drafts')){
    if(init?.method==='POST'){records.set(path,JSON.parse(String(init.body)));return {saved:true} as any;}
    return records.get(path) || null;
   }
   return (path.endsWith('/history')?{session,entries:[]}:idleChat()) as any;
  });c.options.persistDraft=true;return c;
 };
 const first=make();first.setDraft('下次继续写');first.setSettings({model:'model',effort:'high',mode:'plan'});
 first.reading={top:250,bottom:false,anchor:'message',offset:4};
 first.draftAttachments=[{id:'image',type:'image',name:'screen.png',contentType:'image/png',status:{type:'complete'},content:[{type:'image',image:'data:image/png;base64,aGVsbG8='}]}];
 first.persist();await new Promise(r=>setImmediate(r));
 const next=make();next.connect();await new Promise(r=>setImmediate(r));
 try{
  assert.equal(next.getSnapshot().draft,'下次继续写');assert.equal(next.getSnapshot().settings.mode,'plan');
  assert.equal(next.draftAttachments.length,1);assert.equal(next.reading.anchor,'message');
 }finally{next.disconnect();}
});

test("late draft restoration never replaces text typed during loading",async()=>{
 Object.assign(globalThis,{document:{hidden:false}});let restore!:(v:any)=>void;
 const c=setup(async(path,init)=>{
  if(path.startsWith('/api/conversation-drafts')&&!init?.method)return new Promise(r=>{restore=r;});
  return (path.endsWith('/history')?{session,entries:[]}:idleChat()) as any;
 });c.options.persistDraft=true;c.connect();c.setDraft('正在输入的新内容');
 restore({text:'old',images:[],settings:{},project:'p',reading:{top:0,bottom:true,anchor:'',offset:0},updated:Date.now()});
 await new Promise(r=>setImmediate(r));assert.equal(c.getSnapshot().draft,'正在输入的新内容');c.disconnect();
});

test("history image parts and tool activities retain user-visible shape",()=>{
 const image='data:image/png;base64,aGVsbG8=';
 const user=convertEntry({id:'u',turn_id:'t',kind:'user',text:'看截图',images:[image,'https://external.example/tracker.png']});
 assert.deepEqual(user.content,[{type:'text',text:'看截图'},{type:'image',image}]);
 const tool=convertEntry({id:'mcp',turn_id:'t',kind:'activity',tool:'repo · search',status:'completed'}).content[0];
 assert.equal(typeof tool==='object'&&tool.type==='tool-call'&&tool.toolName,'repo · search');
});

test("a completed snapshot arriving before history keeps older saved turns first",async()=>{
 Object.assign(globalThis,{document:{hidden:false}});let saved!:(v:any)=>void;
 const old={id:'old',turn_id:'older',kind:'assistant',text:'之前的历史'};
 const live={id:'new',turn_id:'latest',kind:'assistant',text:'最新回复'};
 const c=setup(async(path)=>path.endsWith('/history')?new Promise(r=>{saved=r;}):({...idleChat(),id:'run',turn_id:'latest',status:'completed',entries:[live]} as any));
 c.connect();await new Promise(r=>setImmediate(r));saved({session,entries:[old],next_cursor:'previous-page'});await new Promise(r=>setImmediate(r));
 assert.deepEqual(c.getSnapshot().entries.map(e=>e.id),['old','new']);assert.equal(c.getSnapshot().cursor,'previous-page');c.disconnect();
});

test("a delayed acknowledgement never clears the next draft typed while sending",async()=>{
 let accept!:(v:any)=>void;
 const c=setup(async()=>new Promise(r=>{accept=r;}));
 const sending=c.send('正在发送');c.setDraft('发送期间输入的下一条');accept(running('accepted'));await sending;
 assert.equal(c.getSnapshot().draft,'发送期间输入的下一条');
});

for (const isNew of [false, true]) test(`local user messages appear before ${isNew ? "creation" : "send"} responds and reconcile with history`, async () => {
  Object.assign(globalThis, {document: {hidden: false}});
  let accept!: (value: any) => void;
  let requestID = "";
  const image = "data:image/png;base64,aGVsbG8=";
  let chat = idleChat();
  let history: any[] = [];
  const c = setup(async (path, init) => {
    if (init?.method === "POST") {requestID = JSON.parse(String(init.body)).request_id; return new Promise(resolve => {accept = resolve;});}
    return (path.endsWith("/history") ? {session, entries: history} : chat) as any;
  }, isNew);
  c.setDraft("立即显示");
  const sending = c.send("立即显示", [image]);
  assert.equal(c.getSnapshot().submitting, true);
  assert.equal(c.getSnapshot().draft, "");
  assert.equal(c.getSnapshot().entries.at(-1)?.text, "立即显示");
  assert.deepEqual(c.getSnapshot().entries.at(-1)?.images, [image]);
  const starting = {...idleChat(), id: requestID, status: "starting", busy: true};
  accept(isNew ? {session, chat: starting} : starting); await sending;
  assert.equal(c.getSnapshot().entries.filter(e => e.kind === "user").length, 1);
  const user = {id: "saved-user", turn_id: "turn", kind: "user", text: "立即显示", images: [image]};
  chat = {...running(requestID), entries: [user]}; history = [user];
  c.connect();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(mergeEntries(c.getSnapshot().entries, c.getSnapshot().chat.entries).filter(e => e.kind === "user").length, 1);
    assert.equal(c.getSnapshot().entries.some(e => e.id.startsWith("local:")), false);
  } finally {c.disconnect();}
});

test("failed local messages restore the draft and attachments and retry only once", async () => {
  let reject!: (error: Error) => void;
  const bodies: any[] = [];
  const c = setup(async (_path, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Promise((_resolve, fail) => {reject = fail;});
  }, true);
  const attachment = {id: "image", type: "image", name: "image.png", contentType: "image/png", status: {type: "complete"}, content: [{type: "image", image: "data:image/png;base64,aGVsbG8="}]} as any;
  c.draftAttachments = [attachment]; c.setDraft("保留消息");
  const first = c.send("保留消息", [attachment.content[0].image]);
  reject(new Error("offline")); await assert.rejects(first);
  assert.equal(c.getSnapshot().entries.length, 0);
  assert.equal(c.getSnapshot().draft, "保留消息");
  assert.equal(c.draftAttachments[0]?.id, "image");
  const retry = c.send("保留消息", [attachment.content[0].image]);
  assert.equal(c.getSnapshot().entries.length, 1);
  assert.equal(bodies[0].request_id, bodies[1].request_id);
  reject(new Error("offline")); await assert.rejects(retry);
});

test("a delayed history page cannot overwrite a newer Codex title", async () => {
  Object.assign(globalThis, {document: {hidden: false}});
  let resolveHistory!: (value: any) => void;
  const c = setup(async path => path.endsWith("/history") ? new Promise(resolve => {resolveHistory = resolve;}) : {...idleChat(), session_name: "Codex 的主题标题"} as any);
  c.connect();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(c.getSnapshot().session?.name, "Codex 的主题标题");
    resolveHistory({session: {...session, name: "未命名对话"}, entries: []});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(c.getSnapshot().session?.name, "Codex 的主题标题");
  } finally {c.disconnect();}
});

test("manual rename survives an already in-flight history response", async () => {
  Object.assign(globalThis, {document: {hidden: false}});
  let resolveHistory!: (value: any) => void;
  const c = setup(async (path, init) => {
    if (path.endsWith("/history")) return new Promise(resolve => {resolveHistory = resolve;});
    if (path.endsWith("/manage")) {
      assert.equal(JSON.parse(String(init?.body)).name, "手动名称");
      return {session: {...session, name: "手动名称"}} as any;
    }
    return idleChat() as any;
  });
  c.connect();
  try {
    await new Promise(resolve => setImmediate(resolve));
    await c.manage("rename", "手动名称");
    resolveHistory({session, entries: []});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(c.getSnapshot().session?.name, "手动名称");
  } finally {c.disconnect();}
});
