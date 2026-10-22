const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness() {
  const elements = new Map();
  const $ = key => {
    if (!elements.has(key)) elements.set(key, { value: '', textContent: '', innerHTML: '', hidden: true, dataset: {}, handlers: {}, scrollTop: 0, scrollHeight: 100, clientHeight: 100, addEventListener(event, fn) { this.handlers[event] = fn; }, querySelectorAll() { return []; }, focus() {} });
    return elements.get(key);
  };
  const creates = [];
  let timers = 0, sequence = 0;
  const context = vm.createContext({
    $, AbortController, TextDecoder, CSS: { escape: s => s },
    crypto: { randomUUID: () => 'request-' + ++sequence },
    document: { addEventListener() {}, querySelector() { return null; }, hidden: false },
    window: { addEventListener() {} }, setInterval() { timers++; return timers; }, clearInterval() {},
    state: { view: 'requirements', selectedRequirement: 'req', requirements: [{ id: 'req', name: '开发工作区', state: 'ready', primary_project_id: 'main', members: [{ project_id: 'main', project_name: 'Main', path: '/work/main' }, { project_id: 'other', project_name: 'Other', path: '/work/other' }] }] },
    requirementSessions: new Map(), updateRequirementSessionsView() {}, esc: s => String(s ?? ''),
    api(url, options) {
      if (url.endsWith('/sessions/new')) return new Promise((resolve, reject) => creates.push({ url, body: JSON.parse(options.body), resolve, reject }));
      if (url.endsWith('/history')) return Promise.resolve({ session: { id: 'created', name: 'Created', cwd: '/work/main' }, entries: [] });
      return Promise.resolve({ status: 'idle', busy: false, entries: [], approvals: [] });
    }
  });
  for (const file of ['session-history.js', 'session-chat.js', 'session-create.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../web', file), 'utf8'), context);
  return { context, $, creates, get timers() { return timers; }, current: () => vm.runInContext('sessionHistoryState', context) };
}
const created = () => ({ session: { id: 'created', name: 'Created', cwd: '/work/main' }, chat: { id: 'request-1', status: 'completed', busy: false, turn_id: 'turn', entries: [], approvals: [] } });

test('new sidebar opens without creating or polling, and retains draft and project after closing', () => {
  const h = harness();
  h.context.openSessionHistory('req');
  assert.equal(h.creates.length, 0);
  assert.equal(h.timers, 0);
  assert.equal(h.$('#sessionHistoryPanel').hidden, false);
  assert.equal(h.$('#refreshSessionHistory').hidden, true);
  assert.equal(h.$('#resumeHistorySession').hidden, true);
  assert.equal(h.$('#newSessionProject').value, 'main');
  h.$('#newSessionProject').value = 'other';
  h.$('#newSessionProject').handlers.change();
  h.$('#sessionChatInput').value = 'draft';
  h.context.closeSessionHistory(false);
  h.context.openSessionHistory('req');
  assert.equal(h.$('#sessionChatInput').value, 'draft');
  assert.equal(h.$('#newSessionProject').value, 'other');
  assert.equal(h.$('#sessionHistoryMeta').textContent, '/work/other');
});
test('first send creates once and transitions into the linked conversation; failed retry keeps request ID', async () => {
  const h = harness(); h.context.openSessionHistory('req');
  h.$('#sessionChatInput').value = 'first message';
  const first = h.context.sendNewSession(h.current());
  assert.equal(h.$('#newSessionProject').disabled, true);
  assert.equal(h.$('#sessionChatInput').disabled, true);
  assert.equal(h.creates[0].body.project_id, 'main');
  h.creates[0].reject(new Error('connection failed'));
  await first;
  assert.equal(h.$('#sessionChatInput').value, 'first message');
  assert.match(h.$('#sessionChatError').textContent, /connection failed/);
  const retry = h.context.sendNewSession(h.current());
  assert.equal(h.creates[1].body.request_id, h.creates[0].body.request_id);
  h.creates[1].resolve(created()); await retry;
  assert.equal(h.current().session, 'created');
  assert.equal(h.$('#newSessionProjectField').hidden, true);
  assert.equal(h.$('#sessionChatInput').disabled, false);
  assert.equal(h.context.requirementSessions.get('req').sessions[0].id, 'created');
});
test('reopening while a creation is pending reuses it; closing prevents late result from opening a panel', async () => {
  const h = harness(); h.context.openSessionHistory('req');
  h.$('#sessionChatInput').value = 'one request';
  const sending = h.context.sendNewSession(h.current());
  h.context.closeSessionHistory(false);
  h.context.openSessionHistory('req');
  assert.equal(h.current().submitting, true);
  assert.equal(h.creates.length, 1);
  h.context.closeSessionHistory(false);
  h.creates[0].resolve(created()); await sending;
  assert.equal(h.current(), null);
  assert.equal(h.$('#sessionHistoryPanel').hidden, true);
  assert.equal(h.context.requirementSessions.get('req').sessions.length, 1);
});
