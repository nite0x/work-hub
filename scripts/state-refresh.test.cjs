const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function snapshot(updatedAt = '2026-10-22T05:23:13Z', refreshing = false) {
  const tree = { path: '/workspace/app', branch: 'codex/task', dirty: 0, refreshing };
  if (updatedAt) tree.status_updated_at = updatedAt;
  return {
    root: '/workspace', terminal: {}, status_refreshing: refreshing,
    projects: [{ id: 'app', name: 'app', path: '/repo/app', has_master: true, refreshing, ...(updatedAt ? { status_updated_at: updatedAt } : {}), worktrees: [tree] }],
    requirements: [{ id: 'task', name: 'Task', state: 'ready', branch: 'codex/task', path: '/workspace', primary_project_id: 'app', members: [{ project_id: 'app', project_name: 'app', path: tree.path, state: 'ready', base_commit: '12345678', worktree: { ...tree } }] }]
  };
}

function harness() {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) {
      let html = '';
      elements.set(selector, {
        content: 'token', value: '', checked: false, hidden: false, writes: 0,
        classList: { toggle() {}, remove() {} }, addEventListener() {},
        get innerHTML() { return html; },
        set innerHTML(value) { html = value; this.writes++; }
      });
    }
    return elements.get(selector);
  };
  const times = [];
  const timers = [];
  let result;
  let failure;
  const context = vm.createContext({
    document: {
      querySelector: element,
      querySelectorAll: selector => selector === '#content time[data-status-path]' ? times : [],
      addEventListener() {}
    },
    window: { addEventListener() {} }, location: { hash: '#/requirements/task', search: '' }, URLSearchParams,
    setTimeout: (callback, delay) => { timers.push(delay); return timers.length; },
    clearTimeout() {}, renderSettings() {}, refreshRequirementProjectPicker() {},
    renderRequirementSessions() { return ''; }, refreshRequirementSessions() {},
    fetch: async () => {
      if (failure) throw failure;
      return { ok: true, json: async () => structuredClone(result) };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8'), context);
  context.readRoute();
  return {
    context, element, times, timers,
    async refresh(data, force = false) { result = data; failure = null; await context.refresh(force); },
    async fail() { failure = new Error('offline'); await context.refresh(); }
  };
}

test('background refresh keeps the project table and only updates its check time', async () => {
  const h = harness();
  await h.refresh(snapshot());
  const content = h.element('#content');
  assert.equal(content.writes, 1);
  assert.match(content.innerHTML, /上次检查 <time/);
  let datetime = '2026-10-22T05:23:13Z';
  const time = {
    dataset: { statusPath: '/workspace/app' },
    textContent: new Date(datetime).toLocaleTimeString('zh-CN', { hour12: false }),
    getAttribute() { return datetime; }, setAttribute(name, value) { datetime = value; }
  };
  h.times.push(time);
  // The backend returns its previous result while a scan is running.
  await h.refresh(snapshot('2026-10-22T05:23:13Z', true));
  assert.equal(content.writes, 1);
  assert.equal(h.timers.at(-1), 1000);
  assert.doesNotMatch(content.innerHTML, /更新中/);
  // A completed scan with identical Git data must not replace focused buttons.
  await h.refresh(snapshot('2026-10-22T05:23:24Z'));
  assert.equal(content.writes, 1);
  assert.equal(h.times[0], time);
  assert.equal(datetime, '2026-10-22T05:23:24Z');
  assert.equal(time.textContent, new Date(datetime).toLocaleTimeString('zh-CN', { hour12: false }));
  assert.equal(h.timers.at(-1), 10000);
  await h.refresh(snapshot('2026-10-22T05:23:24Z', true), true);
  assert.equal(content.writes, 1);
});

test('the first completed check enables project actions even with no Git changes', async () => {
  const h = harness();
  await h.refresh(snapshot(null, true));
  assert.match(h.element('#content').innerHTML, /正在检查/);
  assert.match(h.element('#content').innerHTML, /aria-label="打开 app 的终端" disabled/);
  await h.refresh(snapshot());
  assert.equal(h.element('#content').writes, 2);
  assert.match(h.element('#content').innerHTML, /aria-label="打开 app 的终端" >打开终端/);
  assert.match(h.element('#content').innerHTML, /干净/);
});

test('real status changes are rendered, including errors and branch drift', async () => {
  for (const patch of [{ dirty: 2 }, { branch: 'other' }, { missing: true }, { error: 'Git failed' }, { ahead: 1, behind: 2, compare_available: true }]) {
    const h = harness();
    await h.refresh(snapshot());
    const next = snapshot('2026-10-22T05:23:24Z');
    Object.assign(next.projects[0].worktrees[0], patch);
    Object.assign(next.requirements[0].members[0].worktree, patch);
    await h.refresh(next);
    assert.equal(h.element('#content').writes, 2, JSON.stringify(patch));
  }
});

test('connection failures retain the last table and recover without rebuilding it', async () => {
  const h = harness();
  await h.refresh(snapshot());
  await h.fail();
  assert.equal(h.element('#content').writes, 1);
  assert.equal(h.element('#offlineBanner').hidden, false);
  await h.refresh(snapshot('2026-10-22T05:23:24Z'));
  assert.equal(h.element('#content').writes, 1);
  assert.equal(h.element('#offlineBanner').hidden, true);
});
