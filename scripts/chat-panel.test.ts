import {before, test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {JSDOM, VirtualConsole} from "jsdom";
import {idleChat, type Approval, type ChatState, type Entry} from "../frontend/chat/model";
import type {ChatOptions} from "../frontend/chat/controller";

let bundle = "";
before(async () => {
  const output = await build({entryPoints:["frontend/chat/main.tsx"], bundle:true, write:false, outfile:"chat-test.js", format:"iife", globalName:"ChatTest", jsx:"automatic", define:{"process.env.NODE_ENV":'"production"'}, plugins:[{name:"test-css",setup(builder){builder.onLoad({filter:/\.css$/},()=>({contents:"",loader:"css"}));}}]});
  bundle = output.outputFiles.find(file=>file.path.endsWith(".js"))!.text + "\nwindow.ChatTest = ChatTest;";
});

const task = {id:"task",name:"测试任务",state:"ready",primary_project_id:"p",members:[{project_id:"p",project_name:"项目",path:"/workspace/project"}]};
const session = {id:"session",name:"测试会话",cwd:"/workspace/project"};
const tick = () => new Promise(resolve=>setTimeout(resolve,20));
async function until(check:()=>unknown) { for(let i=0;i<100;i++){if(check()) return; await tick();} assert.ok(check(),"chat did not reach expected state"); }

function mount(existing = false, entries: Entry[] = [], extra: Partial<ChatOptions> = {}) {
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
  }, ...extra};
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

test("read-only sessions use official Markdown and tools without a composer or chat API", async () => {
  const h = mount(true, [{id:"a",turn_id:"turn",kind:"assistant",text:"**已完成**\n\n| 方案 | 结论 |\n| --- | --- |\n| 组件库 | 复用 |"}, {id:"c",turn_id:"turn",kind:"command",command:"git status",status:"completed",output:"clean"}], {readOnly:true});
  try {
    await until(() => h.w.document.querySelector(".aui-md-table"));
    assert.equal(h.w.document.querySelector(".aui-md-p strong")?.textContent, "已完成");
    assert(h.w.document.querySelector(".aui-tool-group-trigger"));
    assert.equal(h.input(), null);
    assert.equal(h.w.document.querySelector(".aui-composer-add-attachment"), null);
    assert(h.w.document.querySelector('[data-session-action="global-resume"]'));
    assert(h.calls.every(call => call.path.includes("/history") && !call.body));
    assert.deepEqual(h.errors, []);
  } finally { h.dispose(); }
});

test("an existing conversation exposes new conversation without replacing its draft or sending", async () => {
  let opened = 0;
  const h = mount(true, [], {newConversation: () => { opened++; }});
  try {
    await until(() => h.input());
    h.type("当前草稿"); await tick();
    const button = [...h.w.document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes("新建会话"));
    assert(button); button.click();
    assert.equal(opened, 1);
    assert.equal(h.input().value, "当前草稿");
    assert(!h.calls.some(call => call.body));
    assert.deepEqual(h.errors, []);
  } finally { h.dispose(); }
});
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
    await tick(); assert(!h.calls.some(call=>call.body));
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

test("chat chrome identifies task and project with expandable working directory details", async () => {
  const h = mount(true, [{id:"a",turn_id:"turn",kind:"assistant",text:"当前检查已完成。"}]);
  try {
    await until(() => h.input());
    assert.equal(h.w.document.querySelector("footer"), null);
    assert.doesNotMatch(h.w.document.body.textContent || "", /可以在这里继续对话|可粘贴或拖入图片|Ctrl\+Enter 发送/);
    assert.match(h.w.document.querySelector(".chat-panel-header")?.textContent || "", /任务 · 测试任务/);
    const context = h.w.document.querySelector<HTMLElement>(".chat-workspace-context")!;
    assert.match(context.textContent || "", /执行环境本机/);
    assert.match(context.textContent || "", /\/workspace\/project/);
    assert(h.w.document.querySelector('[aria-label="刷新历史"]'));
    assert.deepEqual(h.errors, []);
  } finally { h.dispose(); }
});

for (const existing of [false, true]) test(`a slow ${existing ? "send" : "creation"} shows the user bubble before the server responds`, async () => {
  let accept!: (value: any) => void;
  let requestID = "";
  const h = mount(existing, [], {request: async (path, init) => {
    if (init?.method === "POST") {requestID = JSON.parse(String(init.body)).request_id; return new Promise(resolve => {accept = resolve;}) as any;}
    return (path.endsWith("/history") ? {session, entries: []} : idleChat()) as any;
  }});
  try {
    await until(() => h.input()); h.type("马上进入对话"); await tick();
    h.w.document.querySelector<HTMLButtonElement>(".aui-composer-send")!.click();
    await until(() => h.w.document.querySelector('[data-slot="aui_user-message-root"]')?.textContent?.includes("马上进入对话"));
    assert.match(h.w.document.querySelector(".chat-status")?.textContent || "", /发送中/);
    const chat = {...idleChat(), id: requestID, turn_id: "turn", status: "completed", session_name: "Codex 的简短标题", entries: [{id: "u", turn_id: "turn", kind: "user", text: "马上进入对话"}]};
    accept(existing ? chat : {session, chat});
    await until(() => h.w.document.querySelector("#assistantChatTitle")?.textContent === "Codex 的简短标题");
    assert.equal(h.w.document.querySelectorAll('[data-slot="aui_user-message-root"]').length, 1);
    assert.equal(h.input().value, "");
    assert.deepEqual(h.errors, []);
  } finally {h.dispose();}
});

test("session drafts and reading positions are shared across tasks and isolated from other sessions", async () => {
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
    await until(() => h.input()?.value === "第一个会话的草稿");
    await until(() => h.w.document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]')?.scrollTop === 360);
    const restoredViewport = h.w.document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]')!;
    Object.defineProperties(restoredViewport, {scrollHeight: {value: 2400}, clientHeight: {value: 400}});
    restoredViewport.dispatchEvent(new h.w.Event("scroll"));
    h.type("共享会话的新草稿"); await tick();
    h.bridge.open(h.options);
    await until(() => h.input()?.value === "共享会话的新草稿");
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
    await until(()=>h.w.document.querySelector('textarea[name="text:q"]'));
    const answer = h.w.document.querySelector<HTMLTextAreaElement>('textarea[name="text:q"]')!;
    Object.getOwnPropertyDescriptor(h.w.HTMLTextAreaElement.prototype,"value")!.set!.call(answer,"只检查当前项目");
    answer.dispatchEvent(new h.w.Event("input",{bubbles:true})); await tick();
    h.w.document.querySelector('form:has(textarea[name="text:q"])')!.dispatchEvent(new h.w.Event("submit",{bubbles:true,cancelable:true}));
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

const questionApproval = (questions: Approval["questions"]): Approval => ({id:"question",title:"Codex 需要你的回答",details:"",kind:"questions",can_accept:true,questions});
function questionType(h: ReturnType<typeof mount>, id: string, text: string) {
  const field = h.w.document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="text:${id}"]`)!;
  const prototype = field.tagName === "INPUT" ? h.w.HTMLInputElement.prototype : h.w.HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(prototype,"value")!.set!.call(field,text);
  field.dispatchEvent(new h.w.Event("input",{bubbles:true}));
}

test("structured questions occupy the composer, retain all answers across navigation and submit exactly once", async () => {
  const h = mount(true); h.setChat(waiting(questionApproval([
    {id:"title",header:"标题",question:"对话标题你希望怎么处理？",isOther:true,options:[{label:"自动生成（推荐）",description:"首轮完成后生成简短主题"},{label:"手动填写",description:"创建时填写标题"}]},
    {id:"scope",header:"范围",question:"应用到哪些会话？"},
  ])));
  try {
    await until(()=>h.w.document.querySelector(".chat-question-composer"));
    assert(h.w.document.querySelector(".aui-thread-viewport-footer .chat-question-composer"));
    assert.equal(h.input(),null);
    assert.equal(h.w.document.querySelector('input[type="radio"]:checked'),null);
    assert.equal(h.calls.some(c=>c.body),false);
    h.w.document.querySelector<HTMLInputElement>('input[value="自动生成（推荐）"]')!.click(); await tick();
    questionType(h,"title","保留手动改名"); await tick();
    [...h.w.document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="下一题")!.click();
    await until(()=>h.w.document.querySelector('[name="text:scope"]'));
    h.w.document.querySelector<HTMLButtonElement>('[aria-label="上一个问题"]')!.click();
    await until(()=>h.w.document.querySelector<HTMLTextAreaElement>('[name="text:title"]')?.value==="保留手动改名");
    assert(h.w.document.querySelector<HTMLInputElement>('input[value="自动生成（推荐）"]')!.checked);
    h.w.document.querySelector<HTMLButtonElement>('[aria-label="下一个问题"]')!.click();
    await until(()=>h.w.document.querySelector('[name="text:scope"]'));
    h.w.document.querySelector<HTMLFormElement>(".chat-question-composer")!.requestSubmit(); await tick();
    assert.match(h.w.document.body.textContent||"",/请回答这个问题/);
    assert.equal(h.calls.some(c=>c.path.endsWith("/chat/approval")),false);
    questionType(h,"scope","新建会话"); await tick();
    h.w.document.querySelector<HTMLButtonElement>('[aria-label="上一个问题"]')!.click(); await tick();
    [...h.w.document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="下一题")!.click(); await tick();
    assert.equal(h.calls.some(c=>c.path.endsWith("/chat/approval")),false,"navigation must not submit even when every question is answered");
    const field = h.w.document.querySelector<HTMLTextAreaElement>('[name="text:scope"]')!;
    field.dispatchEvent(new h.w.KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true,cancelable:true,isComposing:true})); await tick();
    assert.equal(h.calls.some(c=>c.path.endsWith("/chat/approval")),false);
    field.dispatchEvent(new h.w.KeyboardEvent("keydown",{key:"Enter",metaKey:true,bubbles:true,cancelable:true}));
    await until(()=>!h.w.document.querySelector(".chat-question-composer"));
    const calls = h.calls.filter(c=>c.path.endsWith("/chat/approval"));
    assert.equal(calls.length,1);
    assert.deepEqual(calls[0].body,{run_id:"run",approval_id:"question",decision:"accept",answers:{title:["自动生成（推荐）\n\n保留手动改名"],scope:["新建会话"]}});
    assert(!h.calls.some(c=>c.body && (c.path.endsWith("/steer") || c.path.endsWith("/chat"))));
    assert.deepEqual(h.errors,[]);
  } finally {h.dispose();}
});

test("question answers survive reopen and failures without overwriting the message and attachment draft", async () => {
  const h=mount(true);
  try {
    await until(()=>h.input()); h.type("普通消息草稿"); pasteImage(h);
    await until(()=>h.w.document.querySelector(".aui-attachment-tile-remove"));
    h.setChat(waiting(questionApproval([{id:"q",header:"方案",question:"选择方案？",isOther:true,options:[{label:"A",description:"方案 A"}]}])));
    h.bridge.open(h.options);
    await until(()=>h.w.document.querySelector(".chat-question-composer"));
    h.w.document.querySelector<HTMLInputElement>('input[name="choice:q"][value=""]')!.click(); await tick();
    questionType(h,"q","自定义方案"); await tick();
    h.bridge.close(); await tick(); h.bridge.open(h.options);
    await until(()=>h.w.document.querySelector<HTMLTextAreaElement>('[name="text:q"]')?.value==="自定义方案");
    const original=h.options.request;
    h.options.request=async(path,init)=>{if(path.endsWith("/chat/approval"))throw new Error("回答未送达"); return original(path,init);};
    h.bridge.open(h.options);
    await tick();
    await until(()=>h.w.document.querySelector<HTMLTextAreaElement>('[name="text:q"]')?.value==="自定义方案");
    h.w.document.querySelector<HTMLFormElement>(".chat-question-composer")!.requestSubmit();
    await until(()=>h.w.document.body.textContent?.includes("回答未送达"));
    assert.equal(h.w.document.querySelector<HTMLTextAreaElement>('[name="text:q"]')?.value,"自定义方案");
    h.options.request=original;
    h.bridge.open(h.options);
    await tick();
    await until(()=>h.w.document.querySelector<HTMLTextAreaElement>('[name="text:q"]')?.value==="自定义方案");
    h.w.document.querySelector<HTMLFormElement>(".chat-question-composer")!.requestSubmit();
    await until(()=>h.input()?.value==="普通消息草稿");
    await until(()=>h.w.document.querySelector(".aui-attachment-tile-remove"));
    assert.deepEqual(h.calls.find(c=>c.path.endsWith("/chat/approval"))?.body.answers,{q:["自定义方案"]});
    assert.deepEqual(h.errors,[]);
  } finally {h.dispose();}
});

test("skipping a secret question sends no draft, and an externally resolved question restores the composer", async () => {
  const h=mount(true); h.setChat(waiting(questionApproval([{id:"secret",header:"凭证",question:"输入凭证",isSecret:true}])));
  try {
    await until(()=>h.w.document.querySelector('input[type="password"]'));
    questionType(h,"secret","must-not-be-sent"); await tick();
    [...h.w.document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="跳过问询")!.click();
    await until(()=>h.calls.some(c=>c.path.endsWith("/chat/approval")));
    assert.deepEqual(h.calls.find(c=>c.path.endsWith("/chat/approval"))?.body,{run_id:"run",approval_id:"question",decision:"decline",answers:{}});
    h.setChat(waiting(questionApproval([{id:"q",header:"方案",question:"继续吗？"}]))); h.bridge.open(h.options);
    await until(()=>h.w.document.querySelector(".chat-question-composer"));
    h.setChat({...idleChat(),id:"run",status:"running",busy:true}); h.bridge.open(h.options);
    await until(()=>h.input());
    assert.equal(h.w.document.querySelector(".chat-question-composer"),null);
    assert.equal(h.calls.filter(c=>c.path.endsWith("/chat/approval")).length,1);
    assert.deepEqual(h.errors,[]);
  } finally {h.dispose();}
});

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


test("the shared panel opens a project directory without any task object", async () => {
 const h = mount(false,[],{task:undefined,target:{project_id:"p",cwd:"/workspace/project"}});
 try {
  await until(()=>h.input());
  assert.equal(h.w.document.querySelector("#assistantChatProject"),null);
  assert.match(h.w.document.querySelector(".chat-panel-header")?.textContent || "",/\/workspace\/project/);
  h.type("从项目页开始"); await tick();
  h.w.document.querySelector<HTMLButtonElement>(".aui-composer-send")!.click();
  await until(()=>h.calls.some(call=>call.body));
  const sent = h.calls.find(call=>call.body)!;
  assert.equal(sent.path,"/api/sessions/new");
  assert.equal(sent.body.task_id,undefined);
  assert.equal(sent.body.cwd,"/workspace/project");
  assert.deepEqual(h.errors,[]);
 } finally {h.dispose();}
});

test("a running conversation exposes both send and stop and sends follow-up input into the current turn",async()=>{
 const h=mount(true);
 const original=h.options.request;
 h.options.request=async(path,init)=>{
  if(path.endsWith('/chat/steer')){
   const body=JSON.parse(String(init?.body));h.calls.push({path,body});
   return {accepted:body.request_id,chat:{...idleChat(),id:'active',turn_id:'turn',status:'running',busy:true,entries:[{id:'u',turn_id:'turn',kind:'user',text:body.text}]}};
  }
  return original(path,init);
 };
 h.setChat({...idleChat(),id:'active',turn_id:'turn',status:'running',busy:true});h.bridge.open(h.options);
 try{
  await until(()=>h.w.document.querySelector('.aui-composer-cancel'));
  h.type('请先处理测试');await until(()=>h.w.document.querySelector<HTMLButtonElement>('.aui-composer-send')?.disabled===false);
  assert(h.w.document.querySelector('.aui-composer-cancel'));
  h.w.document.querySelector<HTMLButtonElement>('.aui-composer-send')!.click();
  await until(()=>h.calls.some(c=>c.path.endsWith('/chat/steer')));
  await until(()=>[...h.w.document.querySelectorAll<HTMLElement>('[data-chat-message-id]')].some(node=>node.dataset.chatMessageId===JSON.stringify(['turn','u'])));
  assert.equal(h.w.document.querySelectorAll('[data-slot="aui_user-message-root"]').length,1);
  assert.equal(h.calls.find(c=>c.path.endsWith('/chat/steer'))?.body.turn_id,'turn');
  assert(!h.calls.some(c=>c.path.endsWith('/chat/stop')));assert.deepEqual(h.errors,[]);
 }finally{h.dispose();}
});

test("context settings use the catalog and stay out of user text",async()=>{
 const h=mount(true,[],{request:async(path,init)=>{
  if(path.endsWith('/history'))return {session:{...session,model:'model',reasoningEffort:'medium'},entries:[]} as any;
  if(path.endsWith('/context'))return {model:'model',reasoningEffort:'medium',cwd:'/workspace/project',additional_directories:['/extra']} as any;
  if(path.endsWith('/chat-options'))return {models:[{id:'model',model:'model',displayName:'Fixture',isDefault:false,supportedReasoningEfforts:[{reasoningEffort:'high'}]},{id:'other',model:'other',displayName:'Other',isDefault:true,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],modes:['plan','default']} as any;
  if(init?.body){h.calls.push({path,body:JSON.parse(String(init.body))});return {...idleChat(),status:'completed',turn_id:'new'} as any;}
  return idleChat() as any;
 }});
 try{
  await until(()=>h.input());
  const settings=h.w.document.querySelector<HTMLButtonElement>('[aria-label="上下文与设置"]')!;
  await until(()=>settings.textContent?.includes('Fixture'));
  assert(settings.closest('.aui-composer-root'));
  assert(settings.closest('.aui-composer-action-wrapper'));
  assert.equal(h.w.document.querySelector('.chat-panel-header [aria-label="上下文与设置"]'),null);
  settings.click();
  await until(()=>h.w.document.querySelector<HTMLSelectElement>('[aria-label="下轮工作模式"]')?.options.length===3);
  const model=h.w.document.querySelector<HTMLSelectElement>('[aria-label="下轮模型"]')!;
  assert.equal(model.value,'model');assert.equal(model.selectedOptions[0].textContent,'Fixture');
  const effort=h.w.document.querySelector<HTMLSelectElement>('[aria-label="下轮思考强度"]')!;
  assert.equal(effort.value,'medium');assert.equal(effort.selectedOptions[0].textContent,'中');
  model.value='other';model.dispatchEvent(new h.w.Event('change',{bubbles:true}));
  await until(()=>effort.value==='low');assert.equal(effort.selectedOptions[0].textContent,'低');
  model.value='model';model.dispatchEvent(new h.w.Event('change',{bubbles:true}));
  await until(()=>effort.value==='medium');
  assert(!h.w.document.querySelector('.chat-settings-popover')!.textContent?.includes('沿用当前'));
  const mode=h.w.document.querySelector<HTMLSelectElement>('[aria-label="下轮工作模式"]')!;mode.value='plan';mode.dispatchEvent(new h.w.Event('change',{bubbles:true}));
  h.type('先做计划');await tick();h.w.document.querySelector<HTMLButtonElement>('.aui-composer-send')!.click();
  await until(()=>h.calls.some(c=>c.path.endsWith('/chat')&&c.body));
  const sent=h.calls.find(c=>c.path.endsWith('/chat')&&c.body)!.body;
  assert.equal(sent.settings.mode,'plan');assert.equal(sent.text,'先做计划');
  assert.equal(sent.settings.model,undefined);assert.equal(sent.settings.effort,undefined);
  h.w.document.querySelector<HTMLButtonElement>('.chat-context-disclosure')!.click();
  await until(()=>h.w.document.body.textContent?.includes('/extra'));assert.deepEqual(h.errors,[]);
 }finally{h.dispose();}
});

test("conversation search finds command output even while execution details are collapsed",async()=>{
 const h=mount(true,[{id:'command',turn_id:'turn',kind:'command',command:'npm test',status:'completed',output:'unique-result-123'}]);
 try{
  await until(()=>h.w.document.querySelector('.aui-tool-group-trigger'));
  h.w.document.querySelector<HTMLButtonElement>('[aria-label="查找消息"]')!.click();
  await until(()=>h.w.document.querySelector('[aria-label="查找会话内容"]'));
  const search=h.w.document.querySelector<HTMLInputElement>('[aria-label="查找会话内容"]')!;
  Object.getOwnPropertyDescriptor(h.w.HTMLInputElement.prototype,'value')!.set!.call(search,'unique-result-123');
  search.dispatchEvent(new h.w.Event('input',{bubbles:true}));
  await until(()=>h.w.document.querySelector('[data-search-hit]'));
  assert.equal(h.w.document.querySelectorAll('[data-search-hit]').length,1);
  search.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  await until(()=>!h.w.document.querySelector('[aria-label="查找会话内容"]'));
  assert.equal(h.w.document.querySelector('[data-search-hit]'),null);
  assert.equal(h.w.document.activeElement?.getAttribute('aria-label'),'查找消息');assert.deepEqual(h.errors,[]);
 }finally{h.dispose();}
});


test("settings dismiss with Escape, restore focus and never send the conversation", async () => {
  const h = mount(true);
  try {
    await until(() => h.input()); h.type("未发送的草稿");
    const trigger = h.w.document.querySelector<HTMLButtonElement>('[aria-label="上下文与设置"]')!;
    trigger.click();
    await until(() => h.w.document.querySelector('.chat-settings-popover'));
    assert(h.w.document.querySelector('.assistant-chat-scope .chat-settings-popover'));
    const field = h.w.document.querySelector<HTMLSelectElement>('[aria-label="下轮模型"]')!;
    field.focus(); field.dispatchEvent(new h.w.KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    await until(() => !h.w.document.querySelector('.chat-settings-popover'));
    await until(() => h.w.document.activeElement === trigger);
    assert.equal(h.input().value, "未发送的草稿");
    assert(!h.calls.some(call => call.body)); assert.deepEqual(h.errors, []);
  } finally {h.dispose();}
});

function openSessionMenu(h: ReturnType<typeof mount>) {
  const button = h.w.document.querySelector<HTMLButtonElement>('[aria-label="整理会话"]')!;
  button.focus(); button.dispatchEvent(new h.w.KeyboardEvent("keydown", {key: "ArrowDown", bubbles: true, cancelable: true}));
}

test("an unnamed existing session displays a placeholder but its rename editor stays empty", async () => {
  const unnamed = {...session, name: ""};
  const h = mount(true, [], {session: unnamed, request: async path => path.endsWith("/history") ? {session: unnamed, entries: []} as any : idleChat() as any});
  try {
    await until(() => h.w.document.querySelector('#assistantChatTitle')?.textContent === "未命名对话");
    openSessionMenu(h);
    await until(() => h.w.document.querySelector('[role="menuitem"]'));
    [...h.w.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "重命名")!.click();
    await until(() => h.w.document.querySelector<HTMLInputElement>('[aria-label="会话名称"]'));
    assert.equal(h.w.document.querySelector<HTMLInputElement>('[aria-label="会话名称"]')!.value, "");
    assert.deepEqual(h.errors, []);
  } finally {h.dispose();}
});

test("session menu renames via its focused editor without losing the composer draft", async () => {
  const h = mount(true);
  const original = h.options.request;
  h.options.request = async (path, init) => {
    if (path.endsWith('/manage')) {const body = JSON.parse(String(init?.body)); h.calls.push({path, body}); return {session: {...session, name: body.name}} as any;}
    return original(path, init);
  };
  h.bridge.open(h.options);
  try {
    await until(() => h.input()); h.type("保留草稿"); openSessionMenu(h);
    await until(() => h.w.document.querySelector('[role="menuitem"]'));
    [...h.w.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "重命名")!.click();
    await until(() => h.w.document.querySelector<HTMLInputElement>('[aria-label="会话名称"]'));
    const field = h.w.document.querySelector<HTMLInputElement>('[aria-label="会话名称"]')!;
    await until(() => h.w.document.activeElement === field);
    assert.equal(field.value, session.name);
    Object.getOwnPropertyDescriptor(h.w.HTMLInputElement.prototype, "value")!.set!.call(field, "新的会话名称");
    field.dispatchEvent(new h.w.Event("input", {bubbles: true})); await tick();
    field.closest('form')!.dispatchEvent(new h.w.Event("submit", {bubbles: true, cancelable: true}));
    await until(() => !h.w.document.querySelector('.chat-manage-popover'));
    assert.equal(h.calls.find(call => call.path.endsWith('/manage'))?.body.name, "新的会话名称");
    assert.equal(h.input().value, "保留草稿");
    assert.equal(h.w.document.querySelector('#assistantChatTitle')?.textContent, "新的会话名称");
    assert.deepEqual(h.errors, []);
  } finally {h.dispose();}
});

test("running state appears above the composer and disables archive and fork", async () => {
  const h = mount(true, [{id: "active-user", turn_id: "turn", kind: "user", text: "正在处理的要求"}]);
  h.setChat({...idleChat(), id: 'active', turn_id: 'turn', status: 'running', busy: true}); h.bridge.open(h.options);
  try {
    await until(() => h.w.document.querySelector('.chat-status[data-state="running"]'));
    assert.match(h.w.document.querySelector('.chat-status')!.textContent || "", /运行中/);
    const indicator = h.w.document.querySelector('.chat-run-indicator[data-state="running"]');
    assert(indicator);
    assert.match(indicator.textContent || '', /进行中/);
    assert(indicator.closest('.aui-thread-viewport-footer'));
    assert.equal(indicator.getAttribute('role'), 'status');
    assert.doesNotMatch(h.w.document.querySelector('footer')?.textContent || '', /运行中/);
    openSessionMenu(h); await until(() => h.w.document.querySelector('[role="menuitem"]'));
    const items = [...h.w.document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    for (const label of ["从历史分叉", "归档会话"]) assert.equal(items.find(item => item.textContent === label)?.getAttribute('aria-disabled'), 'true');
    assert.equal(items.find(item => item.textContent === "重命名")?.getAttribute('aria-disabled'), null);
    h.w.document.querySelector('[role="menu"]')!.dispatchEvent(new h.w.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
    await until(() => !h.w.document.querySelector('[role="menu"]'));
    assert(!h.calls.some(call => call.body)); assert.deepEqual(h.errors, []);
  } finally {h.dispose();}
});

test("the composer indicator follows live run states after tool output and disappears when the turn ends", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const active = {...idleChat(), id: 'active', turn_id: 'turn', status: 'running', busy: true};
  const h = mount(true, [
    {id: 'user', turn_id: 'turn', kind: 'user', text: '检查项目'},
    {id: 'command', turn_id: 'turn', kind: 'command', command: 'npm test', status: 'completed', output: 'passed'},
  ], {stream: async () => new Response(new ReadableStream<Uint8Array>({start(controller) {stream = controller;}}))});
  h.setChat(active); h.bridge.open(h.options);
  const send = (chat: ChatState) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chat)}\n\n`));
  try {
    await until(() => stream && h.w.document.querySelector('.chat-run-indicator[data-state="running"]'));
    assert(h.w.document.querySelector('.aui-tool-group-trigger'));
    assert.equal(h.w.document.querySelector('.aui-tool-fallback-result'), null);
    for (const [status, label] of [['starting', '正在连接'], ['waiting', '等待你的确认'], ['stopping', '正在停止'], ['running', '进行中']]) {
      send({...active, status});
      await until(() => h.w.document.querySelector(`.chat-run-indicator[data-state="${status}"]`));
      assert.match(h.w.document.querySelector('.chat-run-indicator')!.textContent || '', new RegExp(label));
    }
    send({...active, status: 'completed', busy: false});
    await until(() => h.w.document.querySelector('.chat-status[data-state="completed"]'));
    assert.equal(h.w.document.querySelector('.chat-run-indicator'), null);
    assert.deepEqual(h.errors, []);
  } finally {h.dispose();}
});


test("settings and session editors stay inside the native conversation dialog", async () => {
  const h = mount(true);
  const dialog = h.w.document.createElement('dialog'); dialog.open = true;
  dialog.append(h.w.document.querySelector('.session-history-panel')!); h.w.document.body.append(dialog);
  try {
    await until(() => h.input());
    h.w.document.querySelector<HTMLButtonElement>('[aria-label="上下文与设置"]')!.click();
    await until(() => h.w.document.querySelector('.chat-settings-popover'));
    assert.equal(h.w.document.querySelector('.chat-settings-popover')!.closest('dialog'), dialog);
    h.w.document.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click();
    await until(() => !h.w.document.querySelector('.chat-settings-popover'));
    openSessionMenu(h); await until(() => h.w.document.querySelector('[role="menuitem"]'));
    assert.equal(h.w.document.querySelector('[role="menu"]')!.closest('dialog'), dialog);
    [...h.w.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "从历史分叉")!.click();
    await until(() => h.w.document.querySelector('.chat-manage-popover'));
    assert.equal(h.w.document.querySelector('.chat-manage-popover')!.closest('dialog'), dialog);
    h.w.document.querySelector('.chat-manage-popover')!.dispatchEvent(new h.w.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
    await until(() => !h.w.document.querySelector('.chat-manage-popover'));
    assert(!h.calls.some(call => call.body)); assert.deepEqual(h.errors, []);
  } finally {h.dispose();}
});

test("native Codex runs show their activity without offering local stop or sending another turn", async () => {
  let streams = 0;
  const h = mount(true, [{id:'native-user',turn_id:'native',kind:'user',text:'原生运行'}], {stream:async()=>{streams++;throw new Error('must not subscribe as an owner');}});
  h.setChat({...idleChat(),external:true,busy:true,status:'running',turn_id:'native'});h.bridge.open(h.options);
  try {
    await until(()=>h.w.document.querySelector('.chat-status[data-state="running"]'));
    assert.match(h.w.document.querySelector('.chat-status')!.textContent||'',/Codex 中运行/);
    assert.equal(h.w.document.querySelector('.aui-composer-cancel'),null);
    h.type('暂存的补充');await tick();
    assert.equal(h.w.document.querySelector<HTMLButtonElement>('.aui-composer-send')?.disabled,true);
    h.input().dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));
    await tick();assert(!h.calls.some(c=>c.body));assert.equal(streams,0);
    h.setChat({...idleChat(),external:true,status:'completed',turn_id:'native'});h.bridge.open(h.options);
    await until(()=>h.w.document.querySelector('.chat-status[data-state="completed"]'));
    assert.equal(h.input().value,'暂存的补充');
    await until(()=>h.w.document.querySelector<HTMLButtonElement>('.aui-composer-send')?.disabled===false);
    assert.deepEqual(h.errors,[]);
  } finally {h.dispose();}
});

test("assistant local Markdown images load through the session image API and fail with readable text", async () => {
  const local='/workspace/截图 (1).png';
  const h=mount(true,[{id:'image-answer',turn_id:'turn',kind:'assistant',text:`![检查结果](<${local}>)`,local_images:{[local]:'signed-image-reference'}}],{request:async(path)=>{
    if(path.includes('/history'))return {session,entries:[{id:'image-answer',turn_id:'turn',kind:'assistant',text:`![检查结果](<${local}>)`,local_images:{[local]:'signed-image-reference'}}]} as any;
    if(path.includes('/image?')) {h.calls.push({path,body:undefined});return {data_url:'data:image/png;base64,'+png} as any;}
    return idleChat() as any;
  }});
  try {
    await until(()=>h.w.document.querySelector<HTMLImageElement>('img.chat-history-image')?.src.startsWith('data:image/png;base64,'));
    const image=h.w.document.querySelector<HTMLImageElement>('img.chat-history-image')!;
    assert.equal(image.alt,'检查结果');assert(h.calls.some(c=>c.path==='/api/sessions/session/image?ref=signed-image-reference'));
    assert(!h.calls.some(c=>c.body));assert.deepEqual(h.errors,[]);
  } finally {h.dispose();}
  const failed=mount(true,[{id:'missing',turn_id:'turn',kind:'assistant',text:'![旧截图](/missing.png)',local_images:{'/missing.png':'missing-ref'}}],{request:async(path)=>{
    if(path.includes('/history'))return {session,entries:[{id:'missing',turn_id:'turn',kind:'assistant',text:'![旧截图](/missing.png)',local_images:{'/missing.png':'missing-ref'}}]} as any;
    if(path.includes('/image?'))throw new Error('file gone');return idleChat() as any;
  }});
  try {await until(()=>failed.w.document.querySelector('.chat-image-unavailable'));assert.match(failed.w.document.body.textContent||'',/图片不存在、已移动/);assert.equal(failed.w.document.querySelector('img[src="/missing.png"]'),null);assert.deepEqual(failed.errors,[]);}finally{failed.dispose();}
});
