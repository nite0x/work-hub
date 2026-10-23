const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
require('tsx/cjs');
const { workspaceUI } = require('../frontend/workspace/renderers.tsx');

function harness() {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { hidden: true, open: false, handlers: {}, dataset: {}, textContent: '', innerHTML: '', scrollTop: 0, scrollHeight: 100, clientHeight: 100, querySelectorAll() { return []; }, addEventListener(event, handler) { this.handlers[event] = handler; }, focus() {}, showModal() { this.open = true; }, close() { this.open = false; this.handlers.close?.(); } });
    return elements.get(selector);
  };
  const requests = [];
  const timers = new Map();
  const listeners = new Map();
  let timerID = 0;
  const context = vm.createContext({
    $, AbortController, URLSearchParams, CSS: { escape: s => s },
    state: { requirements: [{ id: 'req', state: 'ready' }] },
    requirementSessions: new Map(), markSessionRead() {},
    document: { hidden: false, addEventListener(event, handler) { listeners.set(event, handler); }, querySelector() { return null; } },
    window: { WorkHubUI: workspaceUI, addEventListener() {} },
    setInterval(callback, delay) { timers.set(++timerID, { callback, delay }); return timerID; },
    clearInterval(id) { timers.delete(id); },
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    api: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }))
  });
  function $(selector) { return element(selector); }
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/features/sessions/session-history.js'), 'utf8'), context);
  return { context, requests, element, timers, listeners, tick() { for (const timer of timers.values()) timer.callback(); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const page = (id, entries, next_cursor = null) => ({ session: { id, name: id, cwd: '/workspace' }, entries, next_cursor });
const message = (id, text = id) => ({ id, turn_id: 'turn', kind: 'assistant', text });

function enablePush(h) {
  const streams = [];
  Object.assign(h.context, {
    sessionReadOnly: true, token: 'csrf', activeEnvironment: 'wsl', TextDecoder,
    fetch: (url, options) => new Promise((resolve, reject) => streams.push({ url, options, resolve, reject }))
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/features/sessions/session-history-live.js'), 'utf8'), h.context);
  return streams;
}

test('terminal confirmations display safely without controls, and clear after the terminal handles them', async () => {
  const h = harness(); enablePush(h);
  h.context.openSessionHistory('req', 'session');
  h.requests[0].resolve(page('session', [])); await flush();
  const current = vm.runInContext('sessionHistoryState', h.context);
  const confirmation = { id: 'pending', title: '需要回答 <svg>', details: '理由 <script>alert(1)</script>', questions: [{ header: '方案', question: '采用哪个方案？', options: [{ label: '方案 A', description: '兼容旧数据' }] }] };
  h.context.applyHistoryPush(current, { connected: true, sync: 0, entries: [], confirmations: [confirmation], waiting: true });
  const attention = h.element('#sessionHistoryAttention');
  assert.equal(attention.hidden, false);
  assert.match(attention.innerHTML, /采用哪个方案？/);
  assert.match(attention.innerHTML, /方案 A：兼容旧数据/);
  assert.match(attention.innerHTML, /请回到原终端/);
  assert.doesNotMatch(attention.innerHTML, /<script>|<svg>|<button|<input|<form/);
  const old = attention.innerHTML;
  let renders = 0;
  Object.defineProperty(attention, 'innerHTML', { get() { return this.markup || old; }, set(value) { this.markup = value; renders++; } });
  h.context.applyHistoryPush(current, { connected: true, sync: 0, entries: [message('reply', '新增内容')], confirmations: [confirmation], waiting: true });
  assert.equal(renders, 0);
  h.context.applyHistoryPush(current, { connected: true, sync: 0, entries: [], confirmations: [], waiting: false });
  assert.equal(attention.hidden, true);
});

test('existing waiting status has a fallback notice; disconnect marks pending state stale and session switches clear it', async () => {
  const h = harness(); enablePush(h);
  h.context.openSessionHistory('req', 'session');
  h.requests[0].resolve(page('session', [])); await flush();
  const current = vm.runInContext('sessionHistoryState', h.context);
  const attention = h.element('#sessionHistoryAttention');
  h.context.applyHistoryPush(current, { connected: true, sync: 0, entries: [], waiting: true });
  assert.equal(attention.hidden, false);
  assert.match(attention.innerHTML, /等待审批或回答/);
  h.context.applyHistoryPush(current, { connected: false, message: '断开' });
  assert.match(attention.innerHTML, /提示可能已处理/);
  h.context.applyHistoryPush(current, { connected: true, sync: 0, entries: [], confirmations: [], waiting: false });
  assert.equal(attention.hidden, true);
  h.context.applyHistoryPush(current, { connected: true, entries: [], waiting: true });
  h.context.openSessionHistory('req', 'other');
  assert.equal(attention.hidden, true);
  h.context.applyHistoryPush(current, { connected: true, entries: [], waiting: true });
  assert.equal(attention.hidden, true);
});

test('read-only sessions expose saved history without starting chat or creating a session', () => {
  const h = harness();
  h.context.sessionReadOnly = true;
  h.context.openSessionChat = () => { throw new Error('interactive chat must stay disabled'); };
  h.context.openSessionHistory('req');
  assert.equal(h.requests.length, 0);
  h.context.openSessionHistory('req', 'saved-session');
  assert.equal(h.element('#sessionChatForm').hidden, true);
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].url, /\/history$/);
});

test('switching and closing the panel prevents stale history from appearing', async () => {
  const h = harness();
  h.context.openSessionHistory('req', 'first');
  h.context.openSessionHistory('req', 'second');
  assert.equal(h.requests[0].options.signal.aborted, true);
  h.requests[1].resolve(page('second', [message('second')]));
  await flush();
  h.requests[0].resolve(page('first', [message('STALE_CONTENT')]));
  await flush();
  assert.equal(h.element('#sessionHistoryTitle').textContent, 'second');
  assert.doesNotMatch(h.element('#sessionHistoryEntries').innerHTML, /STALE_CONTENT/);
  h.context.loadSessionHistory();
  h.context.closeSessionHistory(false);
  assert.equal(h.requests[2].options.signal.aborted, true);
  h.requests[2].resolve(page('second', [message('LATE_CONTENT')]));
  await flush();
  assert.equal(h.element('#sessionHistoryPanel').hidden, true);
  assert.doesNotMatch(h.element('#sessionHistoryEntries').innerHTML, /LATE_CONTENT/);
});

test('older pages prepend without duplicate records and failed reads can be retried', async () => {
  const h = harness();
  h.context.openSessionHistory('req', 'session');
  h.requests[0].resolve(page('session', [message('new')], 'opaque cursor'));
  await flush();
  h.context.loadSessionHistory(true);
  assert.match(h.requests[1].url, /cursor=opaque%20cursor/);
  h.requests[1].resolve(page('session', [message('old'), message('new')]));
  await flush();
  assert.equal(vm.runInContext('sessionHistoryState.entries.map(e => e.id).join(",")', h.context), 'old,new');
  assert.equal(h.element('#loadOlderHistory').hidden, true);
  h.context.loadSessionHistory();
  h.requests[2].reject(new Error('CLI unavailable'));
  await flush();
  assert.equal(h.element('#sessionHistoryError').hidden, false);
  assert.match(h.element('#sessionHistoryEntries').innerHTML, /old/);
  h.context.loadSessionHistory();
  h.requests[3].resolve(page('session', []));
  await flush();
  assert.equal(h.element('#sessionHistoryError').hidden, true);
  assert.match(h.element('#sessionHistoryEntries').innerHTML, /尚无已保存/);
});

test('commands collapse to a summary and output is rendered as inert text only in the dialog', () => {
  const h = harness();
  const command = { id: 'command', turn_id: 'turn', kind: 'command', command: '<img onerror="bad()">\nsecond line', cwd: '/workspace', status: 'completed', output: '\x1b[31m<script>bad()</script>\x1b[0m', exit_code: 0, duration_ms: 0 };
  const html = h.context.renderHistoryEntry(command);
  assert.match(html, /退出码 0/);
  assert.match(html, /耗时 0 秒/);
  assert.match(html, /<details class="history-command-details">/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /<script>|<img|\x1b|bad\(\)<\/script>|&lt;script&gt;/);
  assert.doesNotMatch(h.context.renderHistoryEntry({ ...command, status: 'failed' }), /<details[^>]*\sopen/);
  h.context.openSessionHistory('req', 'session');
  vm.runInContext('sessionHistoryState.entries = ' + JSON.stringify([command]), h.context);
  h.context.openCommandOutput(JSON.stringify(['turn', 'command']));
  assert.equal(h.element('#sessionCommandOutputDialog').open, true);
  assert.equal(h.element('#sessionCommandOutputText').textContent, '<script>bad()</script>');
  assert.match(h.element('#sessionCommandOutputMeta').textContent, /退出码 0/);
  assert.doesNotMatch(h.context.renderHistoryEntry(message('x', '<svg onload="bad()">')), /<svg/);
});

test('read-only history polls every second, pauses while hidden and catches up on return', async () => {
  const h = harness();
  h.context.sessionReadOnly = true;
  h.context.openSessionHistory('req', 'session');
  assert.equal([...h.timers.values()][0].delay, 1000);
  h.requests[0].resolve(page('session', [message('first')]));
  await flush();
  assert.match(h.element('#sessionHistoryStatus').textContent, /每秒自动刷新/);
  h.tick();
  h.tick(); // Do not overlap a slow read.
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(page('session', [message('first', 'updated'), message('second')]));
  await flush();
  assert.match(h.element('#sessionHistoryEntries').innerHTML, /updated/);
  assert.match(h.element('#sessionHistoryEntries').innerHTML, /second/);
  h.context.document.hidden = true;
  h.tick();
  assert.equal(h.requests.length, 2);
  h.context.document.hidden = false;
  h.listeners.get('visibilitychange')();
  assert.equal(h.requests.length, 3);
  h.context.closeSessionHistory(false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.requests[2].options.signal.aborted, true);
});

test('automatic refresh retains older pages and the reading position, and follows the bottom', async () => {
  const h = harness();
  h.context.openSessionHistory('req', 'session');
  h.requests[0].resolve(page('session', [message('recent')], 'older'));
  await flush();
  h.context.loadSessionHistory(true);
  h.requests[1].resolve(page('session', [message('old')], 'oldest'));
  await flush();
  const scroll = h.element('#sessionHistoryScroll');
  scroll.scrollHeight = 1000;
  scroll.scrollTop = 250;
  h.tick();
  h.requests[2].resolve(page('session', [message('recent', 'changed'), message('new')], 'different-head-cursor'));
  await flush();
  assert.equal(vm.runInContext('sessionHistoryState.entries.map(e => e.id).join(",")', h.context), 'old,recent,new');
  assert.equal(vm.runInContext('sessionHistoryState.cursor', h.context), 'oldest');
  assert.equal(scroll.scrollTop, 250);
  scroll.scrollTop = 900;
  h.tick();
  scroll.scrollHeight = 1200;
  // The user is at the bottom at the instant the response is applied.
  scroll.scrollTop = 1100;
  h.requests[3].resolve(page('session', [message('new'), message('newest')], 'head'));
  await flush();
  assert.equal(scroll.scrollTop, 1200);
});

test('a busy terminal is caught up through intervening pages without gaps or duplicates', async () => {
  const h = harness();
  h.context.openSessionHistory('req', 'session');
  h.requests[0].resolve(page('session', [message('old')], 'oldest'));
  await flush();
  h.tick();
  h.requests[1].resolve(page('session', [message('newest')], 'middle'));
  await flush();
  assert.match(h.requests[2].url, /cursor=middle/);
  h.requests[2].resolve(page('session', [], 'overlap')); // Filtered internal records.
  await flush();
  h.requests[3].resolve(page('session', [message('old', 'updated'), message('middle')], 'older'));
  await flush();
  assert.equal(vm.runInContext('sessionHistoryState.entries.map(e => e.id).join(",")', h.context), 'old,middle,newest');
  assert.match(h.element('#sessionHistoryEntries').innerHTML, /updated/);
  assert.equal(vm.runInContext('sessionHistoryState.cursor', h.context), 'oldest');
});

test('failed automatic reads preserve records and recover on the next tick; switching cancels the old timer', async () => {
  const h = harness();
  h.context.openSessionHistory('req', 'session');
  h.requests[0].resolve(page('session', [message('saved')]));
  await flush();
  h.tick();
  h.requests[1].reject(new Error('temporarily offline'));
  await flush();
  assert.equal(h.element('#sessionHistoryError').hidden, false);
  assert.match(h.element('#sessionHistoryEntries').innerHTML, /saved/);
  h.tick();
  h.requests[2].resolve(page('session', [message('saved'), message('recovered')]));
  await flush();
  assert.equal(h.element('#sessionHistoryError').hidden, true);
  assert.match(h.element('#sessionHistoryEntries').innerHTML, /recovered/);
  h.tick();
  h.context.openSessionHistory('req', 'other');
  assert.equal(h.timers.size, 1);
  assert.equal(h.requests[3].options.signal.aborted, true);
  h.requests[3].resolve(page('session', [message('STALE_CONTENT')]));
  await flush();
  assert.doesNotMatch(h.element('#sessionHistoryEntries').innerHTML, /STALE_CONTENT/);
});

test('refresh preserves command details and updates the open output dialog by record identity', async () => {
  const h = harness();
  h.context.openSessionHistory('req', 'session');
  const command = { id: 'command', turn_id: 'turn', kind: 'command', status: 'inProgress', output: 'first' };
  h.requests[0].resolve(page('session', [command]));
  await flush();
  const key = JSON.stringify(['turn', 'command']);
  h.context.openCommandOutput(key);
  assert.equal(h.element('#sessionCommandOutputText').textContent, 'first');
  const output = h.element('#sessionCommandOutputText');
  output.scrollHeight = 1000;
  output.scrollTop = 200;
  const detail = { open: true, closest() { return { dataset: { historyEntry: key } }; } };
  const container = h.element('#sessionHistoryEntries');
  container.querySelectorAll = () => [detail];
  Object.defineProperty(container, 'innerHTML', { get() { return this.markup; }, set(value) { this.markup = value; detail.open = false; } });
  h.tick();
  h.requests[1].resolve(page('session', [{ ...command, status: 'completed', output: 'finished' }, message('reply')]));
  await flush();
  assert.equal(detail.open, true);
  assert.doesNotMatch(container.innerHTML, /finished/);
  assert.equal(output.textContent, 'finished');
  assert.equal(output.scrollTop, 200);
  assert.match(h.element('#sessionCommandOutputMeta').textContent, /已完成/);
  h.context.openSessionHistory('req', 'other');
  assert.equal(h.element('#sessionCommandOutputDialog').open, false);
});

test('output dialog distinguishes missing, empty and pending output and closes with its conversation', () => {
  const h = harness();
  h.context.openSessionHistory('req', 'session');
  const current = vm.runInContext('sessionHistoryState', h.context);
  const command = { id: 'c', turn_id: 't', kind: 'command', status: 'inProgress', output: null };
  current.entries = [command];
  h.context.openCommandOutput(JSON.stringify(['t', 'c']));
  assert.equal(h.element('#sessionCommandOutputText').textContent, '等待命令输出…');
  command.status = 'completed';
  h.context.syncCommandOutput(current);
  assert.equal(h.element('#sessionCommandOutputText').textContent, '此记录未保存命令输出。');
  command.output = '';
  h.context.syncCommandOutput(current);
  assert.equal(h.element('#sessionCommandOutputText').textContent, '（无输出）');
  current.chat = { entries: [{ ...command, output: 'live output' }] };
  h.context.syncCommandOutput(current);
  assert.equal(h.element('#sessionCommandOutputText').textContent, 'live output');
  h.context.closeSessionHistory(false);
  assert.equal(h.element('#sessionCommandOutputDialog').open, false);
});

test('push updates reply and open output immediately while retaining reading position and avoiding history polling', async () => {
  const h = harness();
  const streams = enablePush(h);
  h.context.openSessionHistory('req', 'session');
  h.requests[0].resolve(page('session', [message('saved')]));
  await flush();
  assert.equal(streams.length, 1);
  assert.equal(streams[0].options.headers['X-Environment-ID'], 'wsl');
  assert.equal(streams[0].options.headers['X-CSRF-Token'], 'csrf');
  const current = vm.runInContext('sessionHistoryState', h.context);
  const scroll = h.element('#sessionHistoryScroll');
  scroll.scrollHeight = 1000; scroll.scrollTop = 100;
  const command = { id: 'c', turn_id: 'live', kind: 'command', command: 'test', status: 'inProgress', output: 'one' };
  const reply = { ...message('reply', '正在'), turn_id: 'live', status: 'inProgress' };
  h.context.applyHistoryPush(current, { connected: true, entries: [command, reply], sync: 0 });
  h.context.openCommandOutput(JSON.stringify(['live', 'c']));
  h.context.applyHistoryPush(current, { connected: true, entries: [{ ...command, output: 'one\ntwo' }, { ...reply, text: '正在回复' }], sync: 0 });
  assert.equal(h.element('#sessionCommandOutputText').textContent, 'one\ntwo');
  assert.match(h.element('#sessionHistoryEntries').innerHTML, /正在回复/);
  assert.equal(scroll.scrollTop, 100);
  assert.equal(current.entries.length, 3);
  h.tick();
  assert.equal(h.requests.length, 1);
  assert.match(h.element('#sessionHistoryStatus').textContent, /终端实时推送中/);
  h.context.closeSessionHistory(false);
  assert.equal(streams[0].options.signal.aborted, true);
});

test('stale saved snapshots never roll back live text and command output', async () => {
  const h = harness(); enablePush(h);
  h.context.openSessionHistory('req', 'session');
  h.requests[0].resolve(page('session', [message('saved')])); await flush();
  const current = vm.runInContext('sessionHistoryState', h.context);
  const reply = { ...message('live', 'first'), status: 'inProgress' };
  h.context.applyHistoryPush(current, { connected: true, entries: [reply], sync: 0 });
  h.context.loadSessionHistory();
  h.context.applyHistoryPush(current, { connected: true, entries: [{ ...reply, text: 'first second', status: 'completed' }], sync: 1 });
  h.requests[1].resolve(page('session', [message('saved'), message('live', 'first')])); await flush();
  assert.equal(current.entries.find(e => e.id === 'live').text, 'first second');
  assert.equal(current.pushNeedsSync, true);
  h.tick();
  h.requests[2].resolve(page('session', [message('saved'), message('live', 'first second')])); await flush();
  assert.equal(current.pushNeedsSync, false);
});

test('fragmented UTF-8 SSE is decoded once; disconnect falls back and reconnect snapshots do not duplicate text', async () => {
  const h = harness(); const streams = enablePush(h);
  h.context.openSessionHistory('req', 'session');
  h.requests[0].resolve(page('session', [])); await flush();
  const text = '实时回复';
  const bytes = new TextEncoder().encode('data: ' + JSON.stringify({ connected: true, sync: 0, entries: [{ ...message('live', text), status: 'inProgress' }] }) + '\n\n');
  let stream;
  const body = new ReadableStream({ start(controller) { stream = controller; } });
  streams[0].resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })); await flush();
  for (let i = 0; i < bytes.length; i += 2) stream.enqueue(bytes.slice(i, i + 2));
  await flush();
  const current = vm.runInContext('sessionHistoryState', h.context);
  assert.equal(current.entries[0].text, text);
  stream.close(); await flush();
  assert.equal(current.pushConnected, false);
  h.tick(); assert.equal(h.requests.length, 2);
  h.requests[1].resolve(page('session', [])); await flush();
  assert.equal(current.entries[0].text, text);
  current.pushRetryAt = 0; h.tick();
  assert.equal(streams.length, 2);
  h.context.applyHistoryPush(current, { connected: true, sync: 0, entries: [{ ...message('live', text + '完成'), status: 'completed' }] });
  assert.equal(current.entries.length, 1);
  assert.equal(current.entries[0].text, text + '完成');
});

test('closing or switching environments suppresses late SSE chunks and pauses subscriptions while hidden', async () => {
  const h = harness(); const streams = enablePush(h);
  h.context.openSessionHistory('req', 'session');
  h.requests[0].resolve(page('session', [])); await flush();
  let stream;
  streams[0].resolve(new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  await flush();
  h.context.document.hidden = true; h.listeners.get('visibilitychange')();
  assert.equal(streams[0].options.signal.aborted, true);
  h.context.activeEnvironment = 'other';
  stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ connected: true, entries: [message('late', 'STALE')] }) + '\n\n'));
  await flush();
  assert.doesNotMatch(h.element('#sessionHistoryEntries').innerHTML, /STALE/);
  h.context.closeSessionHistory(false);
});
