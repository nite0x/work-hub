const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
require('tsx/cjs');
const { workspaceUI } = require('../frontend/workspace/renderers.tsx');

function harness() {
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', value: '', hidden: true, dataset: {}, scrollHeight: 1000, scrollTop: 900, clientHeight: 100, handlers: {}, querySelectorAll() { return []; }, addEventListener(event, fn) { this.handlers[event] = fn; } });
    return elements.get(id);
  };
  const current = { requirement: 'req', session: 'session', entries: [] };
  const context = vm.createContext({ window: { WorkHubUI: workspaceUI }, cleanHistoryApproval: value => value, plainHistoryText: value => String(value ?? ''), $, sessionHistoryState: current, state: { requirements: [{ id: 'req', state: 'ready' }] }, token: 'token', AbortController, TextDecoder, URLSearchParams, crypto: { randomUUID: () => 'request' }, setInterval() { return 1; }, clearInterval() {}, document: { hidden: false }, esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]), historyText: s => String(s), renderHistoryEntry: e => e.text || e.command, loadSessionHistory() {}, api: async () => ({ status: 'idle', busy: false, entries: [], approvals: [] }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/features/sessions/session-chat.js'), 'utf8'), context);
  return { context, $, current };
}
const idle = () => ({ status: 'idle', busy: false, entries: [], approvals: [] });

test('streaming output updates the dialog without rebuilding unchanged command rows', () => {
  const h = harness();
  const container = h.$('#sessionChatLiveEntries');
  let writes = 0;
  let markup = '';
  Object.defineProperty(container, 'innerHTML', { get() { return markup; }, set(value) { writes++; markup = value; } });
  const dialogOutputs = [];
  h.context.syncCommandOutput = current => dialogOutputs.push(current.chat.entries[0].output);
  const command = { id: 'c', turn_id: 't', kind: 'command', command: 'npm run build', output: 'started' };
  h.context.applyChatState(h.current, { ...idle(), entries: [command] });
  h.context.applyChatState(h.current, { ...idle(), entries: [{ ...command, output: 'finished' }] });
  assert.equal(writes, 1);
  assert.deepEqual(dialogOutputs, ['started', 'finished']);
});

test('handoff waits disable both composers and cancellation keeps terminal ownership visible', () => {
  const h = harness();
  h.$('#sessionChatInput').value = 'next';
  h.context.applyChatState(h.current, { ...idle(), id: 'handoff', status: 'handoff', busy: true, notice: '本轮完成后切换' });
  assert.equal(h.$('#sendSessionChat').disabled, true);
  assert.equal(h.$('#resumeHistorySession').disabled, true);
  assert.equal(h.$('#stopSessionChat').textContent, '取消交接');
  assert.equal(h.$('#handoffSessionChat').hidden, true);
  h.context.applyChatState(h.current, { ...idle(), id: 'handoff', blocked: '终端仍有控制权', can_handoff: true });
  assert.equal(h.$('#sendSessionChat').disabled, true);
  assert.equal(h.$('#handoffSessionChat').hidden, false);
});

test('idle state is usable without a pending send, and terminal conflicts disable sending', () => {
  const h = harness();
  h.$('#sessionChatInput').value = 'hello';
  h.context.applyChatState(h.current, idle());
  assert.equal(h.$('#sendSessionChat').disabled, false);
  h.context.applyChatState(h.current, { ...idle(), status: 'conflict', blocked: '退出终端后再发送' });
  assert.equal(h.$('#sendSessionChat').disabled, true);
  assert.match(h.$('#sessionChatStatus').textContent, /退出终端/);
});
test('uncertain sends are recovered once, and pre-turn failures restore the draft', () => {
  const h = harness();
  h.current.pendingMessage = { id: 'r', text: 'draft' };
  h.$('#sessionChatInput').value = 'draft';
  h.context.applyChatState(h.current, { ...idle(), id: 'r', status: 'starting', busy: true });
  assert.equal(h.$('#sessionChatInput').value, '');
  assert.equal(h.current.pendingMessage, null);
  h.context.applyChatState(h.current, { ...idle(), id: 'r', status: 'conflict', error: 'terminal busy' });
  assert.equal(h.$('#sessionChatInput').value, 'draft');
  const other = { requirement: 'req', session: 'other', entries: [] };
  h.context.sessionHistoryState = other;
  h.context.applyChatState(h.current, { ...idle(), error: 'STALE_ERROR' });
  assert.doesNotMatch(h.$('#sessionChatError').textContent, /STALE_ERROR/);
});
test('stream parser handles fragmented UTF-8 and exposes terminal completion', async () => {
  const h = harness();
  h.current.chatAbort = new AbortController();
  const state = { ...idle(), id: 'r', status: 'completed', turn_id: 'turn', entries: [{ id: 'a', turn_id: 'turn', kind: 'assistant', text: '回复完成' }] };
  const data = new TextEncoder().encode('data: ' + JSON.stringify(state) + '\n\n');
  let index = 0;
  h.context.fetch = async () => ({ ok: true, body: { getReader: () => ({ read: async () => index < data.length ? { value: data.slice(index, index += 7), done: false } : { done: true } }) } });
  await h.context.streamChat(h.current, 'r');
  assert.equal(h.current.chat.status, 'completed');
  assert.match(h.$('#sessionChatLiveEntries').innerHTML, /回复完成/);
  assert.equal(h.current.streaming, false);
});
