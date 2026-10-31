const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const root = path.join(__dirname, '../web');
const storageKey = 'workhub:workspace-tabs:v1';

function harness(t, saved, hash = '', fetch) {
  const dom = new JSDOM(fs.readFileSync(path.join(root,'workspace.html'),'utf8'), {url:'http://localhost:4317/' + hash, runScripts:'outside-only'});
  t.after(() => dom.window.close());
  const {window:w} = dom;
  w.HTMLElement.prototype.scrollIntoView = function() {};
  w.eval(fs.readFileSync(path.join(root,'ui/workspace-tabs.js'),'utf8') + '\nwindow.WorkHubTabbar = WorkHubTabbar;');
  if (saved) w.localStorage.setItem(storageKey, JSON.stringify(saved));
  if (fetch) w.fetch = fetch;
  w.eval(fs.readFileSync(path.join(root,'core/workspace-tabs.js'),'utf8'));
  const frames = () => [...w.document.querySelectorAll('iframe')];
  const buttons = () => [...w.document.querySelectorAll('[role="tab"]')];
  const send = (frame,type,extra = {},origin = w.location.origin) => w.dispatchEvent(new w.MessageEvent('message',{source:frame.contentWindow,origin,data:{type,...extra}}));
  return {w,frames,buttons,send,add:()=>w.document.getElementById('workspaceTabNew').click(),saved:()=>JSON.parse(w.localStorage.getItem(storageKey))};
}

test('tabs keep separate mounted pages while switching and closing', t => {
  const h = harness(t);
  const first = h.frames()[0];
  first.contentDocument.open(); first.contentDocument.write('<!doctype html><body></body>'); first.contentDocument.close();
  const draft = first.contentDocument.createElement('textarea'); draft.value = '尚未发送的草稿'; first.contentDocument.body.append(draft);
  const scroll = first.contentDocument.createElement('div'); first.contentDocument.body.append(scroll); scroll.scrollTop = 321;
  h.add();
  assert.equal(h.frames().length,2);
  assert(first.hidden);
  h.buttons()[0].click();
  assert(!first.hidden);
  assert.equal(draft.value,'尚未发送的草稿');
  assert.equal(scroll.scrollTop,321);
  assert.equal(first,h.frames()[0]);
  h.w.document.querySelectorAll('.workspace-tab-close')[1].click();
  assert.equal(h.frames().length,1);
  assert.equal(first,h.frames()[0]);
  h.w.document.querySelector('.workspace-tab-close').click();
  assert.equal(h.frames().length,1,'closing the last tab leaves a usable workspace');
});

test('a single page hides the bar and multiple pages synchronize the reserved space without remounting', t => {
  const h = harness(t);
  const bar = h.w.document.getElementById('workspaceTabBar');
  const first = h.frames()[0];
  const messages = [];
  first.contentWindow.postMessage = message => messages.push(message);
  first.dispatchEvent(new h.w.Event('load'));
  assert.equal(messages.at(-1).height,0,'the initial layout does not wait for API readiness');
  first.contentWindow.WorkHubTab = {canClose:()=>true};
  h.send(first,'workhub:tab-ready');
  assert.equal(bar.hidden,true);
  assert.equal(messages.at(-1).tabBarHeight,0);
  h.send(first,'workhub:tab-open',{snapshot:{route:'/projects'}});
  assert.equal(bar.hidden,false);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.findLast(message=>message.type==='workhub:tab-layout'))),{type:'workhub:tab-layout',height:40});
  const secondMessages = [];
  h.frames()[1].contentWindow.postMessage = message => secondMessages.push(message);
  h.frames()[1].dispatchEvent(new h.w.Event('load'));
  assert.equal(secondMessages.at(-1).height,40);
  h.frames()[1].contentWindow.WorkHubTab = {canClose:()=>true};
  h.send(h.frames()[1],'workhub:tab-ready');
  assert.equal(secondMessages.at(-1).tabBarHeight,40);
  h.w.document.querySelectorAll('.workspace-tab-close')[1].click();
  assert.equal(bar.hidden,true);
  assert.equal(messages.findLast(message=>message.type==='workhub:tab-layout').height,0);
  assert.equal(h.frames()[0],first);
  assert.equal(first.hidden,false);
});

test('navigation reports update only their originating tab and render labels safely', t => {
  const h = harness(t);
  const first = h.frames()[0]; h.add();
  const second = h.frames()[1];
  h.send(first,'workhub:tab-state',{snapshot:{route:'/sessions',environment:'local',title:'<img src=x onerror=alert(1)>',conversation:{scope:{kind:'task',id:'one'},selected:'session-a'}}});
  h.send(second,'workhub:tab-state',{snapshot:{route:'/projects',environment:'wsl',title:'另一个项目',project:{id:'two',detail:true}}});
  assert.equal(h.w.location.hash,'#/projects');
  assert.equal(h.w.document.querySelector('.workspace-tab-label img'),null);
  assert.equal(h.buttons()[0].textContent,'<img src=x onerror=alert(1)>');
  h.buttons()[0].click();
  assert.equal(h.w.location.hash,'#/sessions');
  assert(!new URL(h.w.location.href).searchParams.has('environment'));
  assert.equal(h.saved().tabs[1].snapshot.project.id,'two');
});

test('two conversations from one task open as distinct tabs without changing the source', t => {
  const h = harness(t);
  const source = h.frames()[0];
  for (const id of ['a','b']) h.send(source,'workhub:tab-open',{snapshot:{route:'/sessions',environment:'local',title:'对话 '+id,conversation:{scope:{kind:'task',id:'same-task'},selected:id,pane:'detail'}}});
  assert.equal(h.frames().length,3);
  assert.equal(h.saved().tabs[0].snapshot.route,'/requirements');
  assert.deepEqual(h.saved().tabs.slice(1).map(tab=>tab.snapshot.conversation.selected),['a','b']);
});

test('restores all pages and active selection, rejects foreign messages and invalid routes', t => {
  const h = harness(t,{selected:'b',tabs:[{id:'a',snapshot:{route:'/sessions',title:'会话 A',environment:'local',conversation:{scope:{kind:'task',id:'task'},selected:'one'}}},{id:'b',snapshot:{route:'/projects',title:'项目 B',environment:'wsl'}}]});
  assert.equal(h.frames().length,2);
  assert.equal(h.buttons()[1].getAttribute('aria-selected'),'true');
  h.send(h.frames()[0],'workhub:tab-open',{snapshot:{}},'https://untrusted.example');
  assert.equal(h.frames().length,2);
  h.send(h.frames()[0],'workhub:tab-open',{snapshot:{route:'https://untrusted.example',environment:'local'}});
  const url = new URL(h.frames()[2].src);
  assert.equal(url.origin,'http://localhost:4317');
  assert.equal(url.hash,'#/requirements');
});

test('close runs the existing cleanup but blocks during an in-progress foreground submission', t => {
  const h = harness(t); h.add();
  const frame = h.frames()[1]; let cleanup = 0;
  frame.contentWindow.WorkHubTab = {canClose:()=>false,dispose:()=>cleanup++};
  h.send(frame,'workhub:tab-ready');
  h.w.document.querySelectorAll('.workspace-tab-close')[1].click();
  assert.equal(h.frames().length,2);
  frame.contentWindow.WorkHubTab.canClose = ()=>true;
  h.w.document.querySelectorAll('.workspace-tab-close')[1].click();
  assert.equal(h.frames().length,1);
  assert.equal(cleanup,1);
});

test('database state restores on a fresh origin and takes precedence over stale browser storage', async t => {
  const old={selected:'old',tabs:[{id:'old',snapshot:{route:'/requirements',title:'过期页面'}}]};
  const stored={initialized:true,selected:'current',tabs:[{id:'current',snapshot:{route:'/sessions',title:'后端对话',conversation:{scope:{kind:'task',id:'task'},selected:'back'}}}]};
  const calls=[];
  const h=harness(t,old,'',async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>stored};});
  for(let i=0;i<4;i++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.frames().length,1);
  assert.equal(h.buttons()[0].textContent,'后端对话');
  assert.equal(h.saved().tabs[0].snapshot.conversation.selected,'back');
  assert.equal(calls[0].options.headers['X-Environment-ID'],'local');
  h.w.dispatchEvent(new h.w.Event('pagehide'));
  for(let i=0;i<4;i++) await new Promise(resolve=>setImmediate(resolve));
  const write=calls.find(call=>call.options.method==='PUT');
  assert.equal(JSON.parse(write.options.body).selected,'current');
});

test('Radix tab keyboard navigation retains panel associations and independent close buttons', async t => {
  const h=harness(t);h.add();
  const second=h.buttons()[1];second.focus();
  second.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(h.buttons()[0].getAttribute('aria-selected'),'true');
  assert.equal(h.frames()[0].getAttribute('aria-labelledby'),h.buttons()[0].id);
  assert.equal(h.buttons()[0].getAttribute('aria-controls'),h.frames()[0].id);
  assert(h.w.document.querySelector('[data-slot="tabs-list"][data-variant="line"]'));
  assert.equal(h.w.document.querySelector('button button'),null);
});

test('background navigation changes do not redraw the bar and title updates retain other tab nodes', t => {
  const h=harness(t);h.add();
  const [first,second]=h.frames();
  h.send(first,'workhub:tab-state',{snapshot:{route:'/sessions',environment:'local',title:'前端',context:'任务'}});
  const other=h.buttons()[1];
  let renders=0;
  const render=h.w.WorkHubTabbar.render;
  h.w.WorkHubTabbar={...h.w.WorkHubTabbar,render:(...args)=>{renders++;return render(...args);}};
  h.send(first,'workhub:tab-state',{snapshot:{route:'/sessions',environment:'local',title:'前端',context:'任务',conversation:{search:'新筛选',selected:'session'}}});
  assert.equal(renders,0);
  h.send(first,'workhub:tab-state',{snapshot:{route:'/sessions',environment:'local',title:'新的很长的前端对话标题',context:'任务'}});
  assert.equal(renders,1);
  assert.equal(h.buttons()[1],other);
  assert.equal(h.frames()[1],second);
});

test('the integrated bar tracks only active sidebar geometry including collapsed and mobile layouts', t => {
  const h=harness(t);const first=h.frames()[0];h.add();const second=h.frames()[1];
  h.send(second,'workhub:tab-chrome',{chrome:{left:300,top:0}});
  assert.equal(h.w.document.body.style.getPropertyValue('--workspace-sidebar-width'),'300px');
  h.send(first,'workhub:tab-chrome',{chrome:{left:72,top:0}});
  assert.equal(h.w.document.body.style.getPropertyValue('--workspace-sidebar-width'),'300px');
  h.buttons()[0].click();
  assert.equal(h.w.document.body.style.getPropertyValue('--workspace-sidebar-width'),'72px');
  h.send(first,'workhub:tab-chrome',{chrome:{left:0,top:184}});
  assert.equal(h.w.document.body.style.getPropertyValue('--workspace-sidebar-width'),'0px');
  assert.equal(h.w.document.body.style.getPropertyValue('--workspace-tabs-top'),'184px');
});
