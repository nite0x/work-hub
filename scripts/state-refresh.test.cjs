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

function harness({ fullPage = false, readOnly = false } = {}) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) {
      let html = '';
      elements.set(selector, {
        content: selector === 'meta[name="session-mode"]' ? (readOnly ? 'read-only' : 'interactive') : 'token',
        value: '', checked: false, hidden: false, writes: 0,
        classList: { toggle() {}, remove() {} }, addEventListener() {}, querySelectorAll() { return []; },
        get innerHTML() { return html; },
        set innerHTML(value) { html = value; this.writes++; }
      });
    }
    return elements.get(selector);
  };
  const times = [];
  const timers = [];
  const ready = [];
  const requests = [];
  let result;
  let failure;
  const context = vm.createContext({
    document: {
      querySelector: element,
      querySelectorAll: selector => selector === '#content time[data-status-path]' ? times : [],
      addEventListener() {}
    },
    window: { addEventListener(event, handler) { if (event === 'DOMContentLoaded') ready.push(handler); } }, location: { hash: '#/requirements/task', search: '' }, URLSearchParams, DOMException,
    setTimeout: (callback, delay) => { timers.push(delay); return timers.length; },
    clearTimeout() {}, renderSettings() {}, refreshRequirementProjectPicker() {},
    renderRequirementSessions() { return ''; }, refreshRequirementSessions() {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (failure) throw failure;
      if (url === '/api/environments') return { ok: true, json: async () => ({ environments: [{ id: 'local', name: '本机' }], distributions: [], platform: result?.terminal?.platform, wsl_supported: result?.terminal?.platform === 'darwin' ? false : undefined }) };
      if (url.startsWith('/api/task-inventory')) return { ok: true, json: async () => ({
        requirements: result.requirements.map(q => ({ ...structuredClone(q), environment_id: 'local', environment_name: '本机', connected: true })),
        environments: [{ id: 'local', name: '本机', connected: true }], project_count: result.projects.length, status_refreshing: result.status_refreshing,
      }) };
      if (url.endsWith('/sessions')) return { ok: true, json: async () => ({ sessions: [] }) };
      return { ok: true, json: async () => structuredClone(result) };
    }
  });
  const scripts = fullPage
    ? [...fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8').matchAll(/<script src="\/([^"]+)" defer><\/script>/g)].map(match => match[1])
      .filter(file => !readOnly || !['features/sessions/session-chat.js', 'features/sessions/session-create.js'].includes(file))
    : ['core/core.js', 'features/projects/projects.js', 'features/tasks/requirements.js', 'core/app.js'];
  for (const file of scripts) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../web', file), 'utf8'), context, { filename: file });
  }
  context.readRoute();
  return {
    context, element, times, timers, requests,
    async start(data) { result = data; ready.forEach(handler => handler()); await new Promise(resolve => setImmediate(resolve)); },
    async refresh(data, force = false) { result = data; failure = null; await context.refresh(force); },
    async fail() { failure = new Error('offline'); await context.refresh(); }
  };
}

test('the unified task list keeps colliding task IDs distinct by environment', () => {
  const h = harness();
  const task = snapshot().requirements[0];
  const requirements = [
    { ...task, environment_id: 'local', environment_name: 'Windows', connected: true },
    { ...task, environment_id: 'wsl-ubuntu', environment_name: 'WSL Ubuntu', connected: false },
  ];
  vm.runInContext(`taskInventory = ${JSON.stringify({ requirements, environments: [], loaded: true })}`, h.context);
  const html = h.context.renderRequirements();
  assert.match(html, /\?environment=local#\/requirements\/task/);
  assert.match(html, /\?environment=wsl-ubuntu#\/requirements\/task/);
  assert.match(html, /Windows/);
  assert.match(html, /WSL Ubuntu/);
  assert.match(html, /环境未连接/);
});

test('listing all tasks does not connect the previously selected environment', async () => {
  const h = harness();
  vm.runInContext("state.selectedRequirement = null; activeEnvironment = 'wsl-offline'", h.context);
  await h.refresh(snapshot());
  assert.deepEqual(h.requests.map(r => r.url), ['/api/task-inventory']);
  assert.equal(h.requests[0].options.headers['X-Environment-ID'], 'local');
  assert.match(h.element('#content').innerHTML, /打开任务 Task/);
});

function prepareEnvironmentPicker(h) {
  h.element('#requirementDialog').open = true;
  h.element('#requirementForm').elements = { primary_project_id: h.element('#primaryProject'), slug: { value: 'demo' } };
}

test('task creation reads only the chosen environment and previews its root', async () => {
  const h = harness();
  prepareEnvironmentPicker(h);
  const local = { ...snapshot(), root: 'D:\\workspaces' };
  const remote = { root: '/home/user/workspaces', projects: [{ id: 'remote', name: 'Remote project', folder: 'remote', has_master: true, status_updated_at: 'now' }] };
  const requests = [];
  h.context.api = async (url, options) => { requests.push(options.environment); return options.environment === 'local' ? local : remote; };
  h.element('#requirementEnvironment').value = 'wsl-ubuntu';
  await h.context.loadRequirementProjects();
  assert.match(h.element('#primaryProject').innerHTML, /Remote project/);
  assert.doesNotMatch(h.element('#primaryProject').innerHTML, /value="app"/);
  assert.match(h.element('#workspacePreview').textContent, /^\/home\/user\/workspaces\/demo/);
  h.element('#requirementEnvironment').value = 'local';
  await h.context.loadRequirementProjects();
  assert.match(h.element('#primaryProject').innerHTML, /value="app"/);
  assert.doesNotMatch(h.element('#primaryProject').innerHTML, /Remote project/);
  assert.match(h.element('#workspacePreview').textContent, /^D:\\workspaces\\demo/);
  assert.deepEqual(requests, ['wsl-ubuntu', 'local']);
});

test('late project responses cannot replace a newly chosen environment', async () => {
  const h = harness();
  prepareEnvironmentPicker(h);
  const pending = [];
  h.context.api = () => new Promise(resolve => pending.push(resolve));
  h.element('#requirementEnvironment').value = 'wsl-old';
  const first = h.context.loadRequirementProjects();
  h.element('#requirementEnvironment').value = 'local';
  const second = h.context.loadRequirementProjects();
  pending[1](snapshot());
  await second;
  const html = h.element('#primaryProject').innerHTML;
  pending[0]({ root: '/old', projects: [{ id: 'old', name: 'Old project' }] });
  await first;
  assert.equal(h.element('#primaryProject').innerHTML, html);
  assert.equal(vm.runInContext('requirementEnvironmentData.environment', h.context), 'local');
});

test('explicit environment calls survive navigation while old ambient calls are rejected', async () => {
  const h = harness();
  await h.refresh(snapshot());
  const ambient = h.context.api('/api/state');
  const explicit = h.context.api('/api/state', { environment: 'wsl-ubuntu' });
  vm.runInContext('environmentRevision += 2', h.context);
  await assert.rejects(ambient, /执行环境已切换/);
  await explicit;
  assert.equal(h.requests.at(-1).options.headers['X-Environment-ID'], 'wsl-ubuntu');
});

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

for (const readOnly of [true, false]) {
  test(`the page starts with its actual script order in ${readOnly ? 'read-only' : 'interactive'} mode`, async () => {
    const h = harness({ fullPage: true, readOnly });
    await h.start(snapshot());
    assert.equal(vm.runInContext('state.loaded', h.context), true);
    assert.equal(vm.runInContext('sessionReadOnly', h.context), readOnly);
    assert.equal(h.element('#offlineBanner').hidden, true);
    assert.match(h.element('#content').innerHTML, /打开终端/);
    assert.match(h.element('#content').innerHTML, /关联会话/);
    assert.equal(vm.runInContext('typeof openSessionChat', h.context), readOnly ? 'undefined' : 'function');
    // Navigation must still find both domain renderers after splitting the entry script.
    vm.runInContext("state.view = 'projects'; state.selectedProject = 'app'; render()", h.context);
    assert.match(h.element('#content').innerHTML, /Git 操作 · 分支管理/);
    vm.runInContext("state.view = 'requirements'; state.selectedRequirement = null; render()", h.context);
    assert.match(h.element('#content').innerHTML, /打开任务 Task/);
  });
}

test('macOS settings show Terminal and hide WSL without discarding unsaved terminal inputs', async () => {
  const h = harness({ fullPage: true, readOnly: true });
  const data = snapshot();
  data.terminal = { platform: 'darwin', settings: { kind: 'macos-terminal', style: 'macos-terminal' }, supported_kinds: ['macos-terminal', 'custom', 'auto'], supported_styles: ['command'], available: true };
  await h.start(data);
  assert.match(h.element('#terminalKind').innerHTML, /Terminal（macOS）/);
  assert.doesNotMatch(h.element('#terminalKind').innerHTML, /PowerShell|Windows Terminal/);
  assert.equal(h.element('#addEnvironment').hidden, true);
  assert.equal(h.element('#platformLabel').textContent, 'macOS');
  h.element('#terminalKind').value = 'custom';
  h.element('#terminalStyle').value = 'command';
  h.element('#terminalPath').value = '/my unsaved terminal';
  h.context.updateTerminalFields();
  const next = structuredClone(data);
  next.terminal.supported_styles.push('otty'); // late capability discovery must preserve the draft.
  await h.refresh(next);
  assert.equal(h.element('#terminalKind').value, 'custom');
  assert.equal(h.element('#terminalStyle').value, 'command');
  assert.equal(h.element('#terminalPath').value, '/my unsaved terminal');
});
