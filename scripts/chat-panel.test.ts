import {before, test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {JSDOM, VirtualConsole} from "jsdom";
import {idleChat, type Approval, type ChatState, type Entry} from "../frontend/chat/model";

let bundle = "";
before(async () => {
  const output = await build({entryPoints:["frontend/chat/main.tsx"], bundle:true, write:false, outfile:"chat-test.js", format:"iife", globalName:"ChatTest", jsx:"automatic", define:{"process.env.NODE_ENV":'"production"'}, plugins:[{name:"test-css",setup(builder){builder.onLoad({filter:/\.css$/},()=>({contents:"",loader:"css"}));}}]});
  bundle = output.outputFiles.find(file=>file.path.endsWith(".js"))!.text + "\nwindow.ChatTest = ChatTest;";
});

const task = {id:"task",name:"测试任务",state:"ready",primary_project_id:"p",members:[{project_id:"p",project_name:"项目",path:"/workspace/project"}]};
const session = {id:"session",name:"测试会话",cwd:"/workspace/project"};
const tick = () => new Promise(resolve=>setTimeout(resolve,20));
async function until(check:()=>unknown) { for(let i=0;i<100;i++){if(check()) return; await tick();} assert.ok(check(),"chat did not reach expected state"); }

function mount(existing = false, entries: Entry[] = []) {
  const errors: unknown[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError",error=>errors.push(error));
  const dom = new JSDOM('<div class="session-history-panel" data-assistant-ui><div id="assistantChatRoot"></div></div>',{url:"http://localhost",runScripts:"dangerously",pretendToBeVisual:true,virtualConsole});
  const w = dom.window;
  Object.assign(w,{TransformStream,ReadableStream,WritableStream,TextEncoder,TextDecoder,Response,Request,Headers,ResizeObserver:class {observe(){} unobserve(){} disconnect(){}},IntersectionObserver:class {observe(){} unobserve(){} disconnect(){}},matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}})});
  w.HTMLElement.prototype.scrollTo = function() {};
  w.HTMLElement.prototype.scrollIntoView = function() {};
  w.URL.createObjectURL = () => "blob:http://localhost/test-image";
  w.URL.revokeObjectURL = () => {};
  w.eval(bundle);
  const calls: {path:string;body:any}[] = [];
  let sendFailures = 0;
  let chat: ChatState = idleChat();
  const options = {task,session:existing?session:null,environment:"local",created(){},close(){bridge.close();},stream:async()=>{throw new Error("fixture offline");},request:async(path:string,init?:RequestInit)=>{
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({path,body});
    if (body && (path.endsWith("/sessions/new") || path.endsWith("/chat")) && sendFailures-- > 0) throw new Error("发送失败，请重试");
    if(path.includes("/history")) return {session,entries};
    if(path.endsWith("/sessions/new")) return {session,chat:{...idleChat(),id:body.request_id,status:"completed",turn_id:"turn",entries:[{id:"u",turn_id:"turn",kind:"user",text:body.text}]}};
    if(path.endsWith("/chat/stop")) {chat={...chat,busy:false,status:"interrupted"}; return chat;}
    if(path.endsWith("/chat/approval")) {chat={...chat,approvals:[]}; return chat;}
    if(path.endsWith("/chat") && body) return {...idleChat(),id:body.request_id,status:"completed",turn_id:"turn"};
    return chat;
  }};
  const bridge = (w as any).ChatTest.bridge;
  bridge.open(options);
  const input = () => w.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="会话消息"]')!;
  const type = (text:string) => {
    Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,"value")!.set!.call(input(),text);
    input().dispatchEvent(new w.Event("input",{bubbles:true}));
  };
  return {w,errors,calls,bridge,options,input,type,setChat:(value:ChatState)=>{chat=value;},failSends:(count:number)=>{sendFailures=count;},dispose(){bridge.close();dom.window.close();}};
}

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=";
function pasteImage(h: ReturnType<typeof mount>, file = new h.w.File([Uint8Array.from(h.w.atob(png), c => c.charCodeAt(0))], "截图.png", {type:"image/png"})) {
  const event = new h.w.Event("paste", {bubbles:true,cancelable:true});
  Object.defineProperty(event, "clipboardData", {value:{files:[file]}});
  h.input().dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
}

test("pasted screenshots retain their preview across reopening and send without text in new and existing chats", async () => {
  for (const existing of [false,true]) {
    const h = mount(existing);
    try {
      await until(()=>h.input());
      pasteImage(h);
      await until(()=>h.w.document.querySelector(".aui-attachment-tile-remove"));
      h.bridge.close(); await tick(); h.bridge.open(h.options);
      await until(()=>h.w.document.querySelector(".aui-attachment-tile-remove"));
      h.input().dispatchEvent(new h.w.KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true,cancelable:true}));
      await until(()=>h.calls.some(call=>call.body?.images));
      const call = h.calls.find(call=>call.body?.images)!;
      assert.equal(call.path.endsWith(existing ? "/chat" : "/sessions/new"),true);
      assert.equal(call.body.text, "");
      assert.deepEqual(call.body.images,["data:image/png;base64,"+png]);
      assert.deepEqual(h.errors,[]);
    } finally {h.dispose();}
  }
});

test("a failed image send retains attachments for retry and removing an image excludes it from the message", async () => {
  const h = mount();
  try {
    await until(()=>h.input()); pasteImage(h);
    await until(()=>h.w.document.querySelector(".aui-attachment-tile-remove"));
    h.failSends(1);
    h.w.document.querySelector<HTMLButtonElement>(".aui-composer-send")!.click();
    await until(()=>h.w.document.body.textContent?.includes("发送失败，请重试"));
    await until(()=>h.w.document.querySelector(".aui-attachment-tile-remove"));
    h.w.document.querySelector<HTMLButtonElement>(".aui-composer-send")!.click();
    await until(()=>h.calls.filter(call=>call.body?.images).length===2);
    const sends = h.calls.filter(call=>call.body?.images);
    assert.equal(sends[0].body.request_id,sends[1].body.request_id);
    assert.deepEqual(sends[0].body.images,sends[1].body.images);
    assert.deepEqual(h.errors,[]);
  } finally {h.dispose();}
  const removed = mount();
  try {
    await until(()=>removed.input()); pasteImage(removed);
    await until(()=>removed.w.document.querySelector(".aui-attachment-tile-remove"));
    removed.w.document.querySelector<HTMLButtonElement>(".aui-attachment-tile-remove")!.click();
    await until(()=>!removed.w.document.querySelector(".aui-attachment-tile-remove"));
    removed.type("只发文字"); await tick();
    removed.w.document.querySelector<HTMLButtonElement>(".aui-composer-send")!.click();
    await until(()=>removed.calls.some(call=>call.body?.text));
    assert.equal(removed.calls.find(call=>call.body?.text)!.body.images,undefined);
    assert.deepEqual(removed.errors,[]);
  } finally {removed.dispose();}
});

test("oversized pasted images display an error without adding an attachment", async () => {
  const h = mount();
  try {
    await until(()=>h.input());
    pasteImage(h, new h.w.File([new Uint8Array(4*1024*1024+1)],"large.png",{type:"image/png"}));
    await until(()=>h.w.document.body.textContent?.includes("每张不能超过 4 MiB"));
    assert.equal(h.w.document.querySelector(".aui-attachment-tile-remove"),null);
    assert.deepEqual(h.errors,[]);
  } finally {h.dispose();}
});

test("an image is restored when Codex fails before starting a turn", async () => {
  const h = mount(true);
  const originalRequest = h.options.request;
  h.options.request = async (path, init) => {
    if (path.endsWith("/chat") && init?.body) {
      const body = JSON.parse(String(init.body));
      const starting = {...idleChat(),id:body.request_id,status:"starting",busy:true};
      h.setChat({...idleChat(),id:body.request_id,status:"failed",error:"无法启动"});
      return starting;
    }
    return originalRequest(path, init);
  };
  // Rebind the same session with the request behavior above.
  h.bridge.open(h.options);
  try {
    await until(()=>h.input()); pasteImage(h);
    await until(()=>h.w.document.querySelector(".aui-attachment-tile-remove"));
    h.w.document.querySelector<HTMLButtonElement>(".aui-composer-send")!.click();
    await until(()=>h.w.document.body.textContent?.includes("本轮未完成"));
    await until(()=>h.w.document.querySelector(".aui-attachment-tile-remove"));
    assert.equal(h.w.document.querySelectorAll(".aui-attachment-tile-remove").length,1);
    assert.deepEqual(h.errors,[]);
  } finally {h.dispose();}
});

test("official composer keeps drafts across reopening and sends through the existing creation API", async () => {
  const h = mount();
  try {
    await until(()=>h.input());
    assert.equal(h.w.document.querySelector(".aui-thread-root")!=null,true);
    assert.ok(h.w.document.querySelector(".aui-composer-add-attachment"));
    h.type("继续完成任务"); await tick();
    assert.equal(h.input().value,"继续完成任务");
    h.input().dispatchEvent(new h.w.KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
    await tick(); assert.equal(h.calls.length,0);
    h.bridge.close(); await tick(); h.bridge.open(h.options);
    await until(()=>h.input()?.value==="继续完成任务");
    h.input().dispatchEvent(new h.w.KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true,cancelable:true}));
    await until(()=>h.calls.some(call=>call.path.endsWith("/sessions/new")));
    assert.equal(h.calls.find(call=>call.path.endsWith("/sessions/new"))?.body.text,"继续完成任务");
    assert.deepEqual(h.errors,[]);
  } finally {h.dispose();}
});

test("official Markdown and tool components render existing history and expose command output", async () => {
  const h = mount(true,[{id:"a",turn_id:"turn",kind:"assistant",text:"## 检查结果\n\n**已经完成**\n\n```sh\nnpm test\n```",status:"completed"},{id:"c",turn_id:"turn",kind:"command",command:"npm test",status:"completed",output:"<script>not executable</script>",exit_code:0}]);
  try {
    await until(()=>h.w.document.querySelector(".aui-tool-group-trigger"));
    assert.equal(h.w.document.querySelector(".aui-md-h2")?.textContent,"检查结果");
    assert.equal(h.w.document.querySelector(".aui-code-header-root")!=null,true);
    h.w.document.querySelector<HTMLButtonElement>(".aui-tool-group-trigger")!.click();
    await until(()=>h.w.document.querySelector(".aui-tool-fallback-trigger"));
    h.w.document.querySelector<HTMLButtonElement>(".aui-tool-fallback-trigger")!.click();
    await until(()=>h.w.document.body.textContent?.includes("not executable"));
    assert.equal(h.w.document.querySelector(".aui-tool-fallback-result script"),null);
    assert.match(h.w.document.querySelector(".aui-tool-fallback-result")?.textContent||"",/not executable/);
    assert.deepEqual(h.errors,[]);
  } finally {h.dispose();}
});

test("chat chrome keeps context available without repeated task labels or idle hints", async () => {
  const h = mount(true, [{id:"a",turn_id:"turn",kind:"assistant",text:"当前检查已完成。"}]);
  try {
    await until(() => h.input());
    assert.equal(h.w.document.querySelector("footer"), null);
    assert.doesNotMatch(h.w.document.body.textContent || "", /可以在这里继续对话|可粘贴或拖入图片|Ctrl\+Enter 发送/);
    assert.doesNotMatch(h.w.document.querySelector(".chat-panel-header")?.textContent || "", /测试任务/);
    const context = h.w.document.querySelector<HTMLDetailsElement>(".chat-context")!;
    assert.equal(context.open, false);
    assert.match(context.querySelector("summary")?.textContent || "", /项目/);
    assert.match(context.textContent || "", /\/workspace\/project/);
    assert(h.w.document.querySelector('[aria-label="刷新历史"]'));
    assert.deepEqual(h.errors, []);
  } finally { h.dispose(); }
});

test("switching sessions and tasks restores each composer and its reading position", async () => {
  const h = mount(true, [{id: "reply", turn_id: "turn", kind: "assistant", text: "一段需要保留阅读位置的历史记录"}]);
  try {
    await until(() => h.input());
    h.type("第一个会话的草稿"); await tick();
    const viewport = h.w.document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]')!;
    Object.defineProperties(viewport, {scrollHeight: {value: 2400}, clientHeight: {value: 400}});
    viewport.scrollTop = 360;
    viewport.dispatchEvent(new h.w.Event("scroll"));
    const second = {...h.options, session: {...session, id: "second"}};
    h.bridge.open(second); await until(() => h.input()?.value === "");
    h.type("第二个会话的草稿"); await tick();
    h.bridge.open({...h.options, task: {...task, id: "other-task"}});
    await until(() => h.input()?.value === "");
    h.type("其他任务的草稿"); await tick();
    h.bridge.open(h.options);
    await until(() => h.input()?.value === "第一个会话的草稿");
    await until(() => h.w.document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]')?.scrollTop === 360);
    h.bridge.open(second);
    await until(() => h.input()?.value === "第二个会话的草稿");
    assert.deepEqual(h.errors, []);
    assert(!h.calls.some(call => call.body));
  } finally { h.dispose(); }
});

test("official stop control and application approval fields retain their existing API targets", async () => {
  const h = mount(true);
  h.setChat({...idleChat(),id:"run",status:"waiting",busy:true,approvals:[{id:"approval",title:"选择执行方式",details:"运行项目检查",kind:"questions",can_accept:true,questions:[{id:"q",header:"方式",question:"检查哪些项目？",options:[{label:"全部",description:"检查所有项目"}]}]}]});
  try {
    await until(()=>h.w.document.querySelector('input[name="text:q"]'));
    const answer = h.w.document.querySelector<HTMLInputElement>('input[name="text:q"]')!;
    answer.value="只检查当前项目";
    h.w.document.querySelector('form:has(input[name="text:q"])')!.dispatchEvent(new h.w.Event("submit",{bubbles:true,cancelable:true}));
    await until(()=>h.calls.some(call=>call.path.endsWith("/chat/approval")));
    assert.deepEqual(h.calls.find(call=>call.path.endsWith("/chat/approval"))?.body,{run_id:"run",approval_id:"approval",decision:"accept",answers:{q:["只检查当前项目"]}});
    await until(()=>h.w.document.querySelector<HTMLButtonElement>(".aui-composer-cancel"));
    h.w.document.querySelector<HTMLButtonElement>(".aui-composer-cancel")!.click();
    await until(()=>h.calls.some(call=>call.path.endsWith("/chat/stop")));
    assert.equal(h.calls.find(call=>call.path.endsWith("/chat/stop"))?.body.run_id,"run");
    assert.deepEqual(h.errors,[]);
  } finally {h.dispose();}
});

const mcpApproval = (changes: Partial<Approval> = {}): Approval => ({id:"mcp",title:"工具授权",details:'Allow apix to run "list_mcp_servers"?',kind:"elicitation",can_accept:true,
  choices:[{id:"decline",label:"拒绝",accepts:false},{id:"cancel",label:"取消本次交互",accepts:false},{id:"accept",label:"允许一次",accepts:true},{id:"accept_session",label:"本会话允许",accepts:true},{id:"accept_always",label:"始终允许",accepts:true}],
  elicitation:{mode:"form",server_name:"apix",fields:[]},...changes});
const waiting = (approval: Approval): ChatState => ({...idleChat(),id:"run",status:"waiting",busy:true,approvals:[approval]});

test("MCP approval offers the advertised scopes and never submits before a user choice", async () => {
  for (const decision of ["accept","accept_session","accept_always"]) {
    const h = mount(true); h.setChat(waiting(mcpApproval()));
    try {
      await until(()=>h.w.document.querySelector('button[value="accept_always"]'));
      assert.match(h.w.document.body.textContent||"",/list_mcp_servers/);
      assert.equal(h.calls.some(c=>c.path.endsWith("/chat/approval")),false);
      h.w.document.querySelector<HTMLButtonElement>(`button[value="${decision}"]`)!.click();
      await until(()=>h.calls.some(c=>c.path.endsWith("/chat/approval")));
      assert.deepEqual(h.calls.find(c=>c.path.endsWith("/chat/approval"))?.body,{run_id:"run",approval_id:"mcp",decision,answers:{},content:{}});
      assert.deepEqual(h.errors,[]);
    } finally {h.dispose();}
  }
});

test("MCP fields submit typed values and original enum IDs, preserving defaults and whitespace", async () => {
  const h=mount(true);h.setChat(waiting(mcpApproval({elicitation:{mode:"form",server_name:"tool",fields:[
    {name:"choice",title:"选择方案",type:"string",required:true,options:[{value:"id-a",label:"方案 A"},{value:"id-b",label:"方案 B"}]},
    {name:"enabled",title:"启用",type:"boolean",required:true,default:false},
    {name:"count",title:"次数",type:"integer",required:true,default:2},
    {name:"ratio",title:"比例",type:"number",required:true,default:1.25},
    {name:"text",title:"文字",type:"string",required:true},
    {name:"tags",title:"标签",type:"array",required:true,options:[{value:"x",label:"标签 X"},{value:"y",label:"标签 Y"}],default:["x"]},
    {name:"optional",title:"选填",type:"string",required:false},
  ]}})));
  try {
    await until(()=>h.w.document.querySelector('select[name="elicitation:choice"]'));
    const choice=h.w.document.querySelector<HTMLSelectElement>('select[name="elicitation:choice"]')!;
    assert.equal(choice.value,"");choice.value=JSON.stringify("id-b");
    h.w.document.querySelector<HTMLInputElement>('input[name="elicitation:text"]')!.value="  原始文字  ";
    h.w.document.querySelector<HTMLButtonElement>('button[value="accept"]')!.click();
    await until(()=>h.calls.some(c=>c.path.endsWith("/chat/approval")));
    assert.deepEqual(h.calls.find(c=>c.path.endsWith("/chat/approval"))?.body.content,{choice:"id-b",enabled:false,count:2,ratio:1.25,text:"  原始文字  ",tags:["x"]});
    assert.deepEqual(h.errors,[]);
  }finally{h.dispose();}
});

test("invalid advanced JSON stays editable and cancelling never forwards draft content",async()=>{
  const h=mount(true);h.setChat(waiting(mcpApproval({elicitation:{mode:"openai/form",server_name:"tool",json_fallback:true,schema:{type:"object"}}})));
  try{
    await until(()=>h.w.document.querySelector('textarea[name="elicitation-json"]'));
    const input=h.w.document.querySelector<HTMLTextAreaElement>('textarea[name="elicitation-json"]')!;
    input.value="{invalid";
    h.w.document.querySelector<HTMLButtonElement>('button[value="accept"]')!.click();
    await until(()=>h.w.document.querySelector('[role="alert"]'));
    assert.equal(h.calls.some(c=>c.path.endsWith("/chat/approval")),false);
    assert.equal(input.value,"{invalid");
    h.w.document.querySelector<HTMLButtonElement>('button[value="cancel"]')!.click();
    await until(()=>h.calls.some(c=>c.path.endsWith("/chat/approval")));
    assert.deepEqual(h.calls.find(c=>c.path.endsWith("/chat/approval"))?.body,{run_id:"run",approval_id:"mcp",decision:"cancel",answers:{}});
    assert.deepEqual(h.errors,[]);
  }finally{h.dispose();}
});

test("URL flow opens the system browser through the scoped API and awaits a separate confirmation",async()=>{
  const h=mount(true);h.setChat(waiting(mcpApproval({elicitation:{mode:"url",server_name:"auth",url:"https://example.com/login"},choices:[{id:"cancel",label:"取消",accepts:false},{id:"accept",label:"已完成，继续",accepts:true}]})));
  try{
    await until(()=>h.w.document.querySelector('[data-elicitation-open]'));
    h.w.document.querySelector<HTMLAnchorElement>('[data-elicitation-open]')!.click();
    await until(()=>h.calls.some(c=>c.path.endsWith("/chat/approval/open")));
    assert.deepEqual(h.calls.find(c=>c.path.endsWith("/chat/approval/open"))?.body,{run_id:"run",approval_id:"mcp"});
    assert.equal(h.calls.some(c=>c.path.endsWith("/chat/approval")),false);
    h.w.document.querySelector<HTMLButtonElement>('button[value="accept"]')!.click();
    await until(()=>h.calls.some(c=>c.path.endsWith("/chat/approval")));
    assert.deepEqual(h.calls.find(c=>c.path.endsWith("/chat/approval"))?.body,{run_id:"run",approval_id:"mcp",decision:"accept",answers:{}});
    assert.deepEqual(h.errors,[]);
  }finally{h.dispose();}
});
