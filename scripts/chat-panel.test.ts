import {before, test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {JSDOM, VirtualConsole} from "jsdom";
import {idleChat, type ChatState, type Entry} from "../frontend/chat/model";

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
  w.eval(bundle);
  const calls: {path:string;body:any}[] = [];
  let chat: ChatState = idleChat();
  const options = {task,session:existing?session:null,environment:"local",created(){},close(){bridge.close();},stream:async()=>{throw new Error("fixture offline");},request:async(path:string,init?:RequestInit)=>{
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({path,body});
    if(path.includes("/history")) return {session,entries};
    if(path.endsWith("/sessions/new")) return {session,chat:{...idleChat(),id:body.request_id,status:"completed",turn_id:"turn",entries:[{id:"u",turn_id:"turn",kind:"user",text:body.text}]}};
    if(path.endsWith("/chat/stop")) {chat={...chat,busy:false,status:"interrupted"}; return chat;}
    if(path.endsWith("/chat/approval")) {chat={...chat,approvals:[]}; return chat;}
    return chat;
  }};
  const bridge = (w as any).ChatTest.bridge;
  bridge.open(options);
  const input = () => w.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="会话消息"]')!;
  const type = (text:string) => {
    Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,"value")!.set!.call(input(),text);
    input().dispatchEvent(new w.Event("input",{bubbles:true}));
  };
  return {w,errors,calls,bridge,options,input,type,setChat:(value:ChatState)=>{chat=value;},dispose(){bridge.close();dom.window.close();}};
}

test("official composer keeps drafts across reopening and sends through the existing creation API", async () => {
  const h = mount();
  try {
    await until(()=>h.input());
    assert.equal(h.w.document.querySelector(".aui-thread-root")!=null,true);
    assert.equal(h.w.document.querySelector(".aui-composer-add-attachment"),null);
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
