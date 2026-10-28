import {test} from "node:test";
import assert from "node:assert/strict";
import {ChatController, type ChatOptions} from "../frontend/chat/controller";
import {idleChat, pendingAsyncQuestion, questionDraftKey, type Entry} from "../frontend/chat/model";

const session = {id:"thread",name:"异步问询",cwd:"/workspace/project"};
const question: Entry = {id:"question",turn_id:"turn",kind:"assistant",delivery:"async",text:"选择方案？",questions:[{id:"0",header:"问题 1",question:"选择方案？",isOther:true,options:[{label:"A（推荐）",description:""},{label:"B",description:""}]}]};
const user: Entry = {id:"user",turn_id:"turn",kind:"user",text:"执行迁移"};
const flush = () => new Promise(resolve => setImmediate(resolve));
function controller(request: ChatOptions['request']) {
  Object.assign(globalThis,{document:{hidden:false}});
  return new ChatController({session,environment:"local",persistDraft:true,request,stream:async()=>{throw new Error("offline");},created(){},close(){}});
}

test("async question selection survives turn completion and only later user input or a receipt resolves it",()=>{
  assert.equal(pendingAsyncQuestion([user,question])?.id,"question");
  assert.equal(pendingAsyncQuestion([user,{...question,status:"completed"}])?.id,"question");
  assert.equal(pendingAsyncQuestion([user,question,{...user,id:"answer"}]),undefined);
  for(const status of ["accepted","skipped"])assert.equal(pendingAsyncQuestion([user,{...question,question_status:status}]),undefined);
  assert.equal(pendingAsyncQuestion([user,{...question,question_status:"pending"}])?.question_status,"pending");
});

test("opening scans older history pages for async questions until the last user input",async()=>{
  const pages:string[]=[];
  const c=controller(async(path)=>{
    if(path.includes('/history')){
      pages.push(path);
      if(path.includes('cursor=older'))return {session,entries:[user,question],has_user_message:true,next_cursor:'past-turn'} as any;
      return {session,entries:[{id:'latest',turn_id:'turn',kind:'assistant',text:'继续执行'}],has_user_message:false,next_cursor:'older'} as any;
    }
    if(path.startsWith('/api/conversation-drafts'))return null as any;
    return idleChat() as any;
  });
  c.connect();await flush();
  try {
    assert.equal(c.question()?.id,'question');
    assert.equal(pages.length,2);
    assert.deepEqual(c.getSnapshot().entries.map(e=>e.id),['user','question','latest']);
    assert.equal(c.getSnapshot().cursor,'past-turn');
  }finally{c.disconnect();}
});

test("async answers and ordinary drafts restore on a fresh controller; retry keeps the answer and does not clear either draft",async()=>{
  const records=new Map<string,any>();let failures=1;let answered=false;
  const posts:any[]=[];
  const request:ChatOptions['request']=async(path,init)=>{
    if(path.startsWith('/api/conversation-drafts')){
      if(init?.method==='POST'){records.set(path,JSON.parse(String(init.body)));return {saved:true} as any;}
      return records.get(path)||null;
    }
    if(path.includes('/history'))return {session,entries:[user,{...question,...(answered?{question_status:'accepted'}:{})}]} as any;
    if(path.endsWith('/chat/question')){
      posts.push(JSON.parse(String(init?.body)));
      if(failures-->0)throw new Error('回答暂未送达');
      answered=true;return idleChat() as any;
    }
    return idleChat() as any;
  };
  const first=controller(request);first.connect();await flush();
  const key=questionDraftKey(first.question()!);
  first.setDraft('普通消息草稿');first.setQuestionDraft(key,{'0':{choice:'A（推荐）',text:'保留历史数据'}});
  first.disconnect();await flush();
  const next=controller(request);next.connect();await flush();
  try{
    assert.equal(next.question()?.id,'question');
    assert.deepEqual(next.questionDrafts.get(key),{'0':{choice:'A（推荐）',text:'保留历史数据'}});
    const approval=next.question()!;
    await next.answer(approval,'accept',{'0':['A（推荐）\n\n保留历史数据']});
    assert.equal(next.getSnapshot().error,'回答暂未送达');
    assert.equal(next.question()?.id,'question');assert(next.questionDrafts.has(key));
    await next.answer(approval,'accept',{'0':['A（推荐）\n\n保留历史数据']});await flush();
    assert.deepEqual(posts[0],posts[1]);
    assert.deepEqual(posts[0],{item_id:'question',turn_id:'turn',decision:'accept',answers:{'0':['A（推荐）\n\n保留历史数据']}});
    assert.equal(next.question(),undefined);assert.equal(next.questionDrafts.has(key),false);
    assert.equal(next.getSnapshot().draft,'普通消息草稿');
  }finally{next.disconnect();}
  await flush();
  const reopened=controller(request);reopened.connect();await flush();
  try{assert.equal(reopened.question(),undefined);assert.equal(reopened.questionDrafts.has(key),false);assert.equal(reopened.getSnapshot().draft,'普通消息草稿');}
  finally{reopened.disconnect();}
});
