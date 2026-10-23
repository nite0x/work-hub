const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MessageChannel } = require('node:worker_threads');
const { JSDOM } = require('jsdom');

const web = path.join(__dirname, '../web');
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

async function harness(t, readOnly = true) {
  const tree = (path, branch) => ({ path, branch, dirty: 0, status_updated_at: '2026-10-23T06:00:00Z' });
  const app = { id: 'app', name: 'App', folder: 'app', path: '/repo/app', worktrees: [tree('/repo/app', 'master'), tree('/workspace/task/app', 'feature/task')] };
  const backend = { id: 'backend', name: 'Backend', folder: 'backend', path: '/repo/backend', worktrees: [tree('/repo/backend', 'master')] };
  const task = { id: 'task', name: 'Billing', slug: 'task', branch: 'feature/task', state: 'ready', path: '/workspace/task', created_at: '2026-10-23T06:00:00Z', primary_project_id: app.id, members: [{ project_id: app.id, project_name: app.name, mode: 'worktree', path: app.worktrees[1].path, state: 'ready', worktree: app.worktrees[1] }] };
  const data = { root: '/workspace', projects: [app, backend], requirements: [task, { ...task, id: 'archived', name: 'Archived', state: 'archived' }], terminal: { platform: 'linux', available: true, settings: { kind: 'auto' }, supported_kinds: ['auto', 'custom'], supported_styles: ['command', 'otty'], launcher: '/usr/bin/terminal', message: '终端已就绪' }, master_sync: { settings: { enabled: true, time: '09:00' }, last_run: { date: '2026-10-23', status: 'completed', results: [{ project_name: 'App', status: 'current', message: '已是最新' }] } } };
  const environments = { environments: [{ id: 'local', name: '本机' }], distributions: [], platform: 'linux', wsl_supported: false };
  const sessions = [{ id: 'session-1', name: 'Billing review', cwd: app.worktrees[1].path, updated_at: 1792735200, available: true, source: 'workspace' }];
  const history = [
    { id: 'message-1', turn_id: 'turn-1', kind: 'user', text: '检查当前代码' },
    { id: 'command-1', turn_id: 'turn-1', kind: 'command', command: 'git status --short', cwd: app.worktrees[1].path, status: 'completed', exit_code: 0, duration_ms: 12, output: 'working tree clean' },
    { id: 'reply-1', turn_id: 'turn-1', kind: 'assistant', text: '当前工作目录干净。' },
  ];
  const overview = project => ({ project, current: 'master', credentials: { available: true, message: '使用已有凭证' }, master_source: 'refs/remotes/origin/master', remotes: [{ name: 'origin', url: '/test/remote.git' }], branches: [
    { name: 'master', ref: 'refs/heads/master', kind: 'local', commit: '12345678', worktrees: [project.path] },
    { name: 'release', ref: 'refs/heads/release', kind: 'local', commit: '12345678', worktrees: [] },
    { name: 'feature/task', ref: 'refs/heads/feature/task', kind: 'local', commit: '12345678', worktrees: project.id === 'app' ? ['/workspace/task/app'] : [] },
    { name: 'origin/master', ref: 'refs/remotes/origin/master', kind: 'remote', commit: '12345678', worktrees: [] },
  ] });
  const dom = new JSDOM(fs.readFileSync(path.join(web, 'index.html'), 'utf8').replace('__SESSION_MODE__', readOnly ? 'read-only' : 'interactive'), { url: 'http://localhost:4317/#/requirements/task', runScripts: 'outside-only', pretendToBeVisual: true });
  const channels = [];
  t.after(() => { dom.window.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close(); } });
  const { window } = dom;
  const document = window.document;
  Object.assign(window, { TextEncoder, TextDecoder, ReadableStream, WritableStream, TransformStream, CSS: { escape: value => value }, MessageChannel: class extends MessageChannel { constructor() { super(); channels.push(this); } }, scrollTo() {}, confirm: () => true });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const requests = [];
  let intercept;
  window.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url, options, body });
    if (intercept) { const result = await intercept(url, options, body); if (result) return result; }
    let result;
    if (url.startsWith('/api/task-inventory')) result = { requirements: data.requirements.map(q => ({ ...q, environment_id: 'local', environment_name: '本机', connected: true })), environments: [{ id: 'local', name: '本机', connected: true }], project_count: data.projects.length };
    else if (url === '/api/environments') result = options.method === 'POST' ? { id: 'wsl-test' } : environments;
    else if (url === '/api/settings/terminal' && options.method === 'PUT') result = data.terminal = { ...data.terminal, settings: body, launcher: body.path || '/usr/bin/terminal', message: '终端已就绪' };
    else if (url === '/api/settings/master-sync' && options.method === 'PUT') result = data.master_sync.settings = body;
    else if (url.endsWith('/history/events') || url.includes('/chat/events?')) return { ok: true, headers: { get: () => 'text/event-stream' }, body: new ReadableStream({ start(controller) { controller.close(); } }) };
    else if (url.includes('/history')) result = { session: sessions[0], entries: url.includes('cursor=') ? [{ id: 'older', turn_id: 'old-turn', kind: 'assistant', text: '更早的记录' }] : history, next_cursor: url.includes('cursor=') ? null : 'older-page' };
    else if (url.endsWith('/chat/approval') || url.endsWith('/chat')) result = { id: body?.request_id || 'run-1', status: 'idle', busy: false, entries: [], approvals: [] };
    else if (url.endsWith('/resume')) result = { message: '已打开会话终端' };
    else if (url.startsWith('/api/codex/sessions?')) result = { data: sessions.map(s => ({ ...s, updatedAt: s.updated_at })), nextCursor: null };
    else if (url.endsWith('/sessions')) result = options.method === 'POST' ? { message: '会话已关联' } : { sessions };
    else if (url.endsWith('/git')) result = options.method === 'POST' ? { message: '已完成', output: 'fixture result' } : overview(data.projects.find(p => url.includes('/' + p.id + '/')));
    else if (url === '/api/projects' && options.method === 'POST') { data.projects.push({ id: 'new-project', ...body, folder: 'new-project', worktrees: [tree(body.path, 'master')] }); result = { id: 'new-project' }; }
    else if (url === '/api/requirements/task/projects' && options.method === 'POST') { result = { ...task, members: [...task.members, { project_id: backend.id, project_name: backend.name, mode: 'project', path: backend.path, state: 'ready', worktree: backend.worktrees[0] }] }; data.requirements[0] = result; }
    else if (url === '/api/requirements' && options.method === 'POST') { result = { ...task, ...body, id: 'created', members: task.members }; data.requirements.push(result); }
    else if (url.endsWith('/worktrees') && options.method === 'POST') result = { message: 'Worktree 已创建', branch: body.branch };
    else if (url.endsWith('/launch')) result = { command: 'codex --cd /workspace/task/app' };
    else result = data;
    return { ok: true, json: async () => structuredClone(result) };
  };
  for (const script of document.querySelectorAll('script[src]')) {
    const file = script.getAttribute('src').slice(1);
    // Legacy controller tests exercise the fallback; the bridge is covered below.
    if (file === 'chat/loader.js') continue;
    if (readOnly && ['features/sessions/session-chat.js', 'features/sessions/session-create.js'].includes(file)) continue;
    vm.runInContext(fs.readFileSync(path.join(web, file), 'utf8'), dom.getInternalVMContext(), { filename: file });
  }
  await settle();
  const $ = selector => document.querySelector(selector);
  const change = (selector, value) => { const node = $(selector); node.value = value; node.dispatchEvent(new window.Event('change', { bubbles: true })); return node; };
  const input = (selector, value) => { const node = $(selector); node.value = value; node.dispatchEvent(new window.Event('input', { bubbles: true })); return node; };
  return { window, document, $, change, input, data, environments, sessions, history, requests, currentSession: () => vm.runInContext('sessionHistoryState', dom.getInternalVMContext()), setIntercept(fn) { intercept = fn; }, click(selector) { $(selector).click(); }, async navigate(route) { const changed = new Promise(resolve => window.addEventListener('hashchange', resolve, { once: true })); window.navigate(route); await changed; await settle(); }, async submit(selector) { $(selector).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle(); } };
}

for (const readOnly of [true, false]) test(`the production UI mounts before controllers in ${readOnly ? 'read-only' : 'interactive'} mode`, async t => {
  const h = await harness(t, readOnly);
  assert.match(h.$('#content').textContent, /Billing|关联项目/);
  assert(h.$('#content [data-slot="table"]'));
  assert(h.$('#projectForm [data-slot="input"]'));
  assert(h.$('#requirementForm [data-slot="native-select"]'));
  const ids = [...h.document.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.doesNotMatch(h.$('#content').textContent, /各项目的终端和 Git 操作直接进入上表对应的工作目录|首次使用 Codex 时可能需要登录/);
  assert.equal(h.$('#requirementSlug').required, true);
  assert.equal(h.$('#requirementSlug').maxLength, 64);
  assert.equal(h.$('label[for="requirementSlug"]').control, h.$('#requirementSlug'));
});

test('search, archive filtering and project selection retain their existing actions', async t => {
  const h = await harness(t);
  await h.navigate('/requirements');
  assert.equal(h.document.querySelectorAll('#content [data-action="open-requirement"]').length, 1);
  h.input('#search', 'no match');
  assert.match(h.$('#content').textContent, /没有匹配的任务/);
  h.input('#search', ''); h.click('#archiveFilter');
  assert.equal(h.document.querySelectorAll('#content [data-action="open-requirement"]').length, 2);
  await h.navigate('/projects');
  h.click('[data-action="select-project"][data-id="app"]');
  assert.equal(h.$('[data-action="select-project"][data-id="app"]').getAttribute('aria-pressed'), 'true');
  assert(h.$('#content [data-slot="table"]'));
  assert.equal(h.$('[data-action="new-worktree"]').dataset.id, 'app');
});

test('mixed task directory choices and custom branches submit through the original API', async t => {
  const h = await harness(t);
  h.window.openRequirement(); await settle();
  h.input('#requirementName', 'Billing redesign');
  assert.equal(h.$('#requirementSlug').value, 'billing-redesign');
  h.change('#primaryProject', 'app');
  assert.equal(h.$('#projectPicker-app-selected').checked, true);
  assert.equal(h.$('#projectPicker-app-selected').disabled, true);
  h.change('#projectPicker-app-mode', 'worktree'); await settle();
  h.change('#projectPicker-app-path', '/workspace/task/app');
  h.click('#projectPicker-backend-selected');
  h.change('#projectPicker-backend-mode', 'new'); await settle();
  const branch = h.input('#projectPicker-backend-branch', 'custom/billing');
  assert.equal(h.$('#projectPicker-backend-branch'), branch);
  h.input('#requirementSlug', 'billing-final');
  assert.equal(h.$('#projectPicker-backend-branch').value, 'custom/billing');
  assert.equal(h.$('#requirementSubmit').disabled, false);
  const formData = new h.window.FormData(h.$('#requirementForm'));
  assert.equal(formData.get('name'), 'Billing redesign');
  assert.equal(formData.get('slug'), 'billing-final');
  await h.submit('#requirementForm');
  const request = h.requests.find(r => r.url === '/api/requirements' && r.options.method === 'POST');
  assert.deepEqual(request.body.members, [{ project_id: 'app', mode: 'worktree', path: '/workspace/task/app' }, { project_id: 'backend', mode: 'new', branch: 'custom/billing', source: 'refs/heads/master' }]);
  assert.equal(h.$('#requirementDialog').open, false);
});

test('nested project registration preserves the task draft and closes only the top dialog', async t => {
  const h = await harness(t);
  h.window.openRequirement(); await settle();
  h.input('#requirementName', 'Keep this draft');
  h.click('#registerNewTaskProject');
  assert.equal(h.$('#projectDialog').open, true);
  assert.equal(h.$('#requirementDialog').open, true);
  assert.equal(h.$('#projectEnvironmentSelect').disabled, true);
  h.click('#projectDialog .close-dialog');
  assert.equal(h.$('#projectDialog').open, false);
  assert.equal(h.$('#requirementDialog').open, true);
  assert.equal(h.$('#requirementName').value, 'Keep this draft');
});

test('registering a project and adding it to a task keep their existing request formats', async t => {
  const h = await harness(t);
  h.window.openProject();
  h.input('#projectName', 'New project'); h.input('#projectPath', '/repo/new-project');
  await h.submit('#projectForm');
  assert.deepEqual(h.requests.find(r => r.url === '/api/projects' && r.options.method === 'POST').body, { name: 'New project', path: '/repo/new-project' });
  assert.equal(h.$('#projectDialog').open, false);
  h.window.openRequirementProjects('task');
  assert.equal(h.$('#requirementProjectPicker-app-selected'), null);
  h.click('#requirementProjectPicker-backend-selected');
  assert.equal(h.$('#requirementProjectsSubmit').disabled, false);
  await h.submit('#requirementProjectsForm');
  assert.deepEqual(h.requests.find(r => r.url === '/api/requirements/task/projects').body, { project_ids: ['backend'], members: [{ project_id: 'backend', mode: 'project' }] });
  assert.equal(h.$('#requirementProjectsDialog').open, false);
});

test('Git retains the selected worktree, occupied-branch protection and source tracking', async t => {
  const h = await harness(t);
  await h.window.openGit('app', '/workspace/task/app');
  assert.equal(h.$('#gitWorktree').value, '/workspace/task/app');
  assert.equal(h.$('#gitSwitch option[value="refs/heads/master"]').disabled, true);
  h.change('#gitBranchSource', 'refs/remotes/origin/master');
  assert.equal(h.$('#gitTrack').checked, true);
  assert.equal(h.$('#gitTrack').disabled, false);
  h.input('#gitBranchName', 'feature/billing');
  await h.submit('#gitCreateForm');
  const request = h.requests.find(r => r.options.method === 'POST' && r.url.endsWith('/git'));
  assert.deepEqual(request.body, { action: 'create_branch', name: 'feature/billing', source: 'refs/remotes/origin/master', track: true });
  assert.equal(h.$('#gitWorktree').value, '/workspace/task/app');
  assert.equal(h.$('#gitResult').hidden, false);
});

test('task sync status and quick pull use the task worktree and current branch', async t => {
  const h = await harness(t);
  Object.assign(h.data.projects[0].worktrees[1], { upstream: 'origin/feature/task', sync_available: true, sync_ahead: 2, sync_behind: 1 });
  await h.window.refresh();
  assert.match(h.$('#content').textContent, /待推送 2 · 待拉取 1 · 已分歧/);
  h.click('[data-action="git-task-pull"]'); await settle();
  const request = h.requests.find(r => r.body?.action === 'pull');
  assert.deepEqual(request.body, { action: 'pull', path: '/workspace/task/app', requirement_id: 'task', expected_branch: 'feature/task' });
  assert.equal(h.$('#gitWorktree').disabled, true);
  assert.match(h.$('#gitContext').textContent, /feature\/task/);
});

test('first push selects a remote target and only pushes the task branch', async t => {
  const h = await harness(t);
  h.click('[data-action="git-task-push"]'); await settle();
  assert(!h.requests.some(r => r.body?.action === 'push'));
  assert.equal(h.$('#gitPushName').value, 'feature/task');
  assert.equal(h.$('#gitPushTrack').checked, true);
  h.input('#gitPushName', 'published/task');
  h.click('[data-action="git-push"]'); await settle();
  assert.deepEqual(h.requests.find(r => r.body?.action === 'push').body, { action: 'push', remote: 'origin', name: 'published/task', track: true, path: '/workspace/task/app', requirement_id: 'task', expected_branch: 'feature/task' });
});

test('switching to a remote branch creates a named local branch and keeps task scope', async t => {
  const h = await harness(t);
  await h.window.openGit('app', '/workspace/task/app', 'task');
  h.change('#gitSwitch', 'refs/remotes/origin/master');
  assert.equal(h.$('#gitSwitchName').value, 'master');
  h.input('#gitSwitchName', 'feature/from-main');
  h.click('[data-action="git-switch"]'); await settle();
  assert.deepEqual(h.requests.find(r => r.body?.action === 'switch').body, { action: 'switch', source: 'refs/remotes/origin/master', name: 'feature/from-main', path: '/workspace/task/app', requirement_id: 'task', expected_branch: 'feature/task' });
});

for (const readOnly of [true, false]) test(`merge conflict automatically opens AI in ${readOnly ? 'terminal' : 'sidebar'} mode and can be reopened without duplicate creation`, async t => {
  const h = await harness(t, readOnly);
  h.setIntercept((url, options, body) => {
    const ok = data => ({ ok: true, json: async () => data });
    if (body?.action === 'merge_preview') return ok({ message: 'origin/master → feature/task', output: 'abc source change', source_commit: 'source-head', expected_head: 'target-head' });
    if (body?.action === 'merge') {
      Object.assign(h.data.projects[0].worktrees[1], { operation: 'merge', head: 'target-head', merge_head: 'source-head', conflicts: ['README.md'], dirty: 1 });
      return ok({ message: '合并出现冲突', conflict: true, merge_head: 'source-head', conflicts: ['README.md'] });
    }
    if (url.endsWith('/merge-ai')) return ok({ message: '已打开 Codex 终端' });
    if (url.endsWith('/sessions/new')) return ok({ session: { id: 'merge-session', name: '解决合并冲突', cwd: '/workspace/task/app' }, chat: { id: body.request_id, status: 'starting', busy: true, entries: [], approvals: [] } });
  });
  await h.window.openGit('app', '/workspace/task/app', 'task');
  h.change('#gitMergeSource', 'refs/remotes/origin/master');
  h.click('[data-action="git-merge-preview"]'); await settle();
  assert.match(h.$('#gitMergePreview').textContent, /origin\/master → feature\/task/);
  assert.equal(h.$('[data-action="git-merge"]').disabled, false);
  h.click('[data-action="git-merge"]'); await settle();
  const requests = h.requests.filter(r => r.url.endsWith(readOnly ? '/merge-ai' : '/sessions/new'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.project_id, 'app');
  assert.equal(requests[0].body.merge_head, 'source-head');
  if (readOnly) {
    assert.match(h.$('#gitMergeStatus').textContent, /README.md/);
    h.click('[data-action="git-merge-ai"]'); await settle();
  } else {
    assert.equal(requests[0].body.purpose, 'merge_conflict');
    assert.equal(h.currentSession().session, 'merge-session');
    assert.equal(h.$('#gitDialog').open, false);
    await h.window.launchGitMergeAI();
    h.window.closeSessionHistory(false);
    await settle();
  }
  assert.equal(h.requests.filter(r => r.url.endsWith(readOnly ? '/merge-ai' : '/sessions/new')).length, 1);
});

test('task and project shortcuts open the intended directory in remote browser and editors', async t => {
  const h = await harness(t);
  for (const tool of ['remote', 'vscode', 'idea']) { h.click(`[data-action="project-open-${tool}"]`); await settle(); }
  assert.deepEqual(h.requests.filter(r => r.url === '/api/projects/app/open').map(r => r.body), ['remote', 'vscode', 'idea'].map(tool => ({ tool, path: '/workspace/task/app' })));
  await h.navigate('/projects');
  h.click('[data-action="project-open-vscode"][data-id="app"]'); await settle();
  assert.deepEqual(h.requests.filter(r => r.url === '/api/projects/app/open').at(-1).body, { tool: 'vscode', path: '/repo/app' });
});

test('an AI launch failure preserves merge context and retries the same creation identifier', async t => {
  const h = await harness(t);
  Object.assign(h.data.projects[0].worktrees[1], { operation: 'merge', head: 'target', merge_head: 'source', conflicts: ['README.md'], dirty: 1 });
  await h.window.refresh();
  let fail = true;
  h.setIntercept(url => url.endsWith('/merge-ai') ? { ok: !fail, json: async () => fail ? { error: '终端连接暂不可用' } : { message: '已打开 Codex 终端' } } : undefined);
  h.click('[data-action="git-task-ai"]'); await settle();
  assert.match(h.$('#gitError').textContent, /终端连接暂不可用/);
  assert.match(h.$('#gitMergeStatus').textContent, /README.md/);
  assert.equal(h.$('[data-action="git-merge-ai"]').disabled, false);
  fail = false;
  h.click('[data-action="git-merge-ai"]'); await settle();
  const attempts = h.requests.filter(r => r.url.endsWith('/merge-ai'));
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].body.request_id, attempts[1].body.request_id);
  assert.equal(h.$('#gitMergeActive').hidden, false);
});

test('a busy Git operation blocks dialog cancellation and recovers its controls after failure', async t => {
  const h = await harness(t);
  await h.window.openGit('app', '/workspace/task/app');
  let release;
  h.setIntercept((url, options) => options.method === 'POST' && url.endsWith('/git') ? new Promise(resolve => { release = resolve; }) : undefined);
  const operation = h.window.gitOperation({ action: 'fetch', remote: 'origin' }, '正在获取分支');
  await settle();
  assert.equal(h.$('[data-action="git-reload"]').disabled, true);
  const cancel = new h.window.Event('cancel', { cancelable: true });
  h.$('#gitDialog').dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  release({ ok: false, json: async () => ({ error: '请在终端登录', code: 'authentication_required' }) });
  await operation;
  assert.equal(h.$('#gitError').hidden, false);
  assert.equal(h.$('#gitAuthHelp').hidden, false);
  assert.match(h.$('#gitError').textContent, /请在终端登录/);
  assert.equal(h.$('[data-action="git-reload"]').disabled, false);
  assert.equal(h.$('#gitWorktree').value, '/workspace/task/app');
});

test('creating a worktree keeps both branch modes and their existing request format', async t => {
  const h = await harness(t);
  await h.window.openWorktree('app');
  h.input('#worktreeSlug', 'qa-check');
  assert.equal(h.$('#worktreeBranch').value, 'codex/qa-check');
  assert.match(h.$('#worktreePath').textContent, /\/workspace\/qa-check\/app/);
  h.change('#worktreeMode', 'existing');
  assert.equal(h.$('#worktreeBranch').disabled, true);
  assert.equal(h.$('#worktreeSource').disabled, true);
  assert.equal(h.$('#worktreeExisting').disabled, false);
  h.change('#worktreeExisting', 'release');
  await h.submit('#worktreeForm');
  assert.deepEqual(h.requests.find(r => r.options.method === 'POST' && r.url.endsWith('/worktrees')).body, { slug: 'qa-check', mode: 'existing', branch: 'release', source: '' });
});

test('task and Git text is rendered inertly, including repository names and paths', async t => {
  const h = await harness(t);
  const malicious = '<img src=x onerror=alert(1)>';
  h.data.requirements[0].name = malicious;
  h.data.requirements[0].description = malicious;
  h.data.projects[0].name = malicious;
  await h.window.refresh();
  assert.equal(h.$('#content').querySelector('img'), null);
  assert(h.$('#pageTitle').textContent.includes(malicious));
  await h.window.openGit('app');
  assert.equal(h.$('#gitContent').querySelector('img'), null);
  assert(h.$('#gitTitle').textContent.includes(malicious));
});

test('settings preserve unsaved edits during polling and keep the terminal request format', async t => {
  const h = await harness(t);
  await h.navigate('/settings');
  assert(h.$('#settingsPage [data-slot="card"]'));
  assert.equal(h.$('#terminalCustomFields').hidden, true);
  h.change('#terminalKind', 'custom');
  assert.equal(h.$('#terminalPath').required, true);
  const pathInput = h.input('#terminalPath', ' /my/terminal ');
  h.change('#terminalStyle', 'command'); h.change('#masterSyncTime', '08:45');
  h.data.projects[0].worktrees[0].dirty = 2;
  await h.window.refresh();
  assert.equal(h.$('#terminalPath'), pathInput);
  assert.equal(pathInput.value, ' /my/terminal ');
  assert.equal(h.$('#masterSyncTime').value, '08:45');
  await h.submit('#terminalForm');
  assert.deepEqual(h.requests.find(r => r.url === '/api/settings/terminal' && r.options.method === 'PUT').body, { kind: 'custom', path: '/my/terminal', style: 'command' });
  assert.equal(h.$('#terminalError').hidden, true);
});

test('failed terminal saves keep the draft and show an accessible error', async t => {
  const h = await harness(t);
  await h.navigate('/settings'); h.change('#terminalKind', 'custom');
  h.input('#terminalPath', '/unsaved/terminal');
  h.setIntercept((url, options) => url === '/api/settings/terminal' && options.method === 'PUT' ? { ok: false, json: async () => ({ error: '程序不可用' }) } : undefined);
  await h.submit('#terminalForm');
  assert.equal(h.$('#terminalError').getAttribute('role'), 'alert');
  assert.equal(h.$('#terminalError').hidden, false);
  assert.match(h.$('#terminalError').textContent, /程序不可用/);
  assert.equal(h.$('#terminalPath').value, '/unsaved/terminal');
});

test('daily sync settings and result messages retain their behavior and text safety', async t => {
  const h = await harness(t);
  await h.navigate('/settings');
  assert(h.$('#masterSyncResults [data-slot="table"]'));
  h.data.master_sync.last_run.results[0].message = '<img src=x onerror=alert(1)>';
  await h.window.refresh();
  assert.equal(h.$('#masterSyncResults').querySelector('img'), null);
  assert.match(h.$('#masterSyncResults').textContent, /<img src=x/);
  h.click('#masterSyncEnabled'); h.change('#masterSyncTime', '08:45');
  await h.submit('#masterSyncForm');
  assert.deepEqual(h.requests.find(r => r.url === '/api/settings/master-sync' && r.options.method === 'PUT').body, { enabled: false, time: '08:45' });
});

test('WSL connection and reconnect use the same environment payloads', async t => {
  const h = await harness(t);
  Object.assign(h.environments, { distributions: ['Ubuntu'], platform: 'windows', wsl_supported: true, environments: [{ id: 'local', name: '本机' }, { id: 'wsl-test', name: 'Ubuntu' }] });
  await h.window.loadEnvironments(); await h.navigate('/settings');
  assert.equal(h.$('#addEnvironment').hidden, false);
  h.click('#addEnvironment'); await settle();
  assert.equal(h.$('#environmentDialog').open, true);
  h.input('#environmentUser', ' tester '); h.input('#environmentRoot', ' /home/tester/workspaces '); h.click('#environmentImport');
  await h.submit('#environmentForm');
  assert.deepEqual(h.requests.find(r => r.url === '/api/environments' && r.options.method === 'POST').body, { distro: 'Ubuntu', user: 'tester', root: '/home/tester/workspaces', import_existing: true });
  assert.equal(h.$('#environmentDialog').open, false);
  assert.equal(h.$('#environmentSelect').value, 'wsl-test');
  h.click('#reconnectEnvironment'); await settle();
  assert(h.requests.some(r => r.url === '/api/environments/wsl-test/reconnect' && r.options.method === 'POST'));
});

test('read-only sessions retain history paging, expanded commands and a live output dialog', async t => {
  const h = await harness(t);
  assert(h.$('#requirementSessions [data-slot="table"]'));
  assert.equal(h.$('#requirementSessions [data-session-action="new"]'), null);
  h.click('[data-session-action="details"]'); await settle();
  assert.equal(h.$('#sessionChatForm').hidden, true);
  assert(h.$('#sessionHistoryEntries [data-slot="card"]'));
  const detail = h.$('#sessionHistoryEntries details'); detail.open = true;
  h.click('[data-command-output]');
  assert.equal(h.$('#sessionCommandOutputDialog').open, true);
  assert.equal(h.$('#sessionCommandOutputText').textContent, 'working tree clean');
  h.history[1].output = 'updated output';
  await h.window.loadSessionHistory(false, true);
  assert.equal(h.$('#sessionHistoryEntries details'), detail);
  assert.equal(h.$('#sessionCommandOutputText').textContent, 'updated output');
  h.history[2].text = '更新后的回复';
  await h.window.loadSessionHistory(false, true);
  assert.equal(h.$('#sessionHistoryEntries details').open, true);
  await h.window.loadSessionHistory(true);
  assert.match(h.$('#sessionHistoryEntries').textContent, /更早的记录/);
  assert.equal(h.$('#loadOlderHistory').hidden, true);
  h.click('#closeSessionCommandOutput');
  h.window.closeSessionHistory();
  assert.equal(h.$('#sessionCommandOutputDialog').open, false);
  assert.equal(h.$('#sessionHistoryPanel').hidden, true);
  assert.equal(h.document.activeElement.dataset.sessionAction, 'details');
  assert(!h.requests.some(r => r.url.endsWith('/chat') || r.url.endsWith('/sessions/new')));
});

test('session picker keeps search, pagination, already-linked state and ID linking', async t => {
  const h = await harness(t);
  h.setIntercept(url => url.startsWith('/api/codex/sessions?') ? { ok: true, json: async () => ({ data: url.includes('cursor=') ? [{ id: 'more-session', name: 'More', cwd: '/other' }] : [...h.sessions, { id: 'unlinked', name: 'Unlinked', cwd: '/other' }], nextCursor: url.includes('cursor=') ? null : 'next-page' }) } : undefined);
  h.click('[data-session-action="picker"]'); await settle();
  assert.equal(h.$('[data-session-action="link"][data-session="session-1"]').disabled, true);
  assert.equal(h.$('[data-session-action="link"][data-session="unlinked"]').disabled, false);
  h.input('#sessionSearch', 'Billing work'); await h.submit('#sessionSearchForm');
  assert(h.requests.some(r => r.url.includes('search=Billing+work')));
  h.click('#sessionPickerMore'); await settle();
  assert(h.requests.some(r => r.url.includes('cursor=next-page')));
  assert(h.$('[data-session="more-session"]'));
  assert.equal(h.$('#sessionPickerMore').hidden, true);
  h.input('#sessionLinkID', ' pasted-id '); await h.submit('#sessionLinkForm');
  assert.deepEqual(h.requests.find(r => r.url.endsWith('/sessions') && r.options.method === 'POST').body, { session_id: 'pasted-id' });
  assert.equal(h.$('#sessionDialog').open, false);
});

test('session activity and unread indicators survive refresh and clear when opened', async t => {
  const h = await harness(t, false);
  const indicators = () => h.$('[data-session-indicators="session-1"]').textContent;
  assert.equal(indicators(), ''); // Existing history starts read.
  h.sessions[0].chat_status = 'running';
  await h.window.refreshRequirementSessions('task');
  assert.equal(indicators(), '对话中');
  h.sessions[0].chat_status = 'waiting';
  await h.window.refreshRequirementSessions('task');
  assert.equal(indicators(), '待确认');
  h.sessions[0].chat_status = '';
  h.sessions[0].completed_run = 'background-run';
  await h.window.refreshRequirementSessions('task');
  assert.equal(indicators(), '未读');
  // Recreate the read cache as on page reload; persisted progress still leaves
  // the unseen completion unread.
  h.window.eval('sessionReadMemory.clear()');
  await h.window.refreshRequirementSessions('task');
  assert.equal(indicators(), '未读');
  h.window.openSessionHistory('task', 'session-1');
  await settle();
  assert.equal(indicators(), '');
  const saved = JSON.parse(h.window.localStorage.getItem('workhub:session-read:' + JSON.stringify(['local', 'session-1'])));
  assert.equal(saved.run, 'background-run');
  h.window.closeSessionHistory();
  await h.window.refreshRequirementSessions('task');
  assert.equal(indicators(), '');
  h.sessions[0].completed_run = 'second-background-run';
  await h.window.refreshRequirementSessions('task');
  assert.equal(indicators(), '未读');
});

test('assistant and fallback chat updates immediately refresh session activity', async t => {
  const h = await harness(t, false);
  let opened;
  h.window.WorkHubAssistant = { open(options) { opened = options; }, close() {} };
  h.window.openSessionHistory('task', 'session-1');
  opened.activity('session-1', { id: 'live', status: 'running', busy: true });
  assert.equal(h.$('[data-session-indicators="session-1"]').textContent, '对话中');
  opened.activity('session-1', { id: 'live', status: 'waiting', busy: true });
  assert.equal(h.$('[data-session-indicators="session-1"]').textContent, '待确认');
  opened.activity('session-1', { id: 'live', turn_id: 'turn', status: 'completed', busy: false });
  assert.equal(h.$('[data-session-indicators="session-1"]').textContent, '');
});

test('interactive approval questions keep native values, secret fields and answer requests', async t => {
  const h = await harness(t, false);
  h.window.openSessionHistory('task', 'session-1'); await settle();
  const current = h.currentSession();
  h.window.applyChatState(current, { id: 'approval-run', status: 'waiting', busy: true, entries: [], approvals: [{ id: 'approval-1', title: '选择方案', kind: 'questions', can_accept: true, questions: [{ id: 'method', header: '方案', question: '采用哪个方案？', options: [{ label: 'A', description: '兼容旧数据' }] }, { id: 'secret', header: '测试', question: '填写测试值', isSecret: true }] }] });
  assert.equal(h.$('[data-free-answer-for="secret"]').type, 'password');
  h.change('[data-answer-for="method"]', 'A'); h.input('[data-free-answer-for="secret"]', 'fixture-only');
  await h.submit('#sessionChatApprovals form');
  assert.deepEqual(h.requests.find(r => r.url.endsWith('/chat/approval')).body, { run_id: 'approval-run', approval_id: 'approval-1', decision: 'accept', answers: { method: ['A'], secret: ['fixture-only'] } });
});

test('interactive message shortcuts and new-session drafts keep the existing workflow', async t => {
  const h = await harness(t, false);
  h.window.openSessionHistory('task', 'session-1'); await settle();
  h.input('#sessionChatInput', '  继续检查  ');
  h.$('#sessionChatInput').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  await settle();
  const sent = h.requests.filter(r => r.url.endsWith('/chat') && r.options.method === 'POST');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.text, '继续检查');
  assert(sent[0].body.request_id);
  h.window.closeSessionHistory();
  h.window.openSessionHistory('task');
  assert.match(h.$('#sessionHistoryEntries').textContent, /从这里开始对话/);
  h.input('#sessionChatInput', '保留这份草稿');
  h.window.closeSessionHistory(); h.window.openSessionHistory('task');
  assert.equal(h.$('#sessionChatInput').value, '保留这份草稿');
  assert.equal(h.$('#newSessionProject').value, 'app');
  assert(!h.requests.some(r => r.url.endsWith('/sessions/new')));
});

test('legacy MCP forms preserve drafts when another request arrives and return typed answers', async t => {
  const h=await harness(t,false);
  h.window.openSessionHistory('task','session-1');await settle();
  const current=h.currentSession();
  const approval={id:'mcp',title:'填写配置',details:'请选择配置',kind:'elicitation',can_accept:true,choices:[{id:'decline',label:'拒绝',accepts:false},{id:'accept',label:'提交回答',accepts:true}],elicitation:{mode:'form',server_name:'apix',fields:[{name:'choice',title:'方案',type:'string',required:true,options:[{value:'id-a',label:'方案 A'}]},{name:'enabled',title:'启用',type:'boolean',required:true,default:false},{name:'count',title:'数量',type:'integer',required:true,default:0}]}};
  const chat={id:'run',status:'waiting',busy:true,entries:[],approvals:[approval]};
  h.window.applyChatState(current,chat);
  const field=h.change('select[name="elicitation:choice"]',JSON.stringify('id-a'));
  h.window.applyChatState(current,{...chat,approvals:[approval,{id:'another',title:'另一个请求',kind:'questions',can_accept:true}]});
  assert.equal(h.$('select[name="elicitation:choice"]'),field);
  assert.equal(field.value,JSON.stringify('id-a'));
  h.click('form[data-chat-approval="mcp"] button[value="accept"]');await settle();
  assert.deepEqual(h.requests.find(r=>r.url.endsWith('/chat/approval')).body,{run_id:'run',approval_id:'mcp',decision:'accept',answers:{},content:{choice:'id-a',enabled:false,count:0}});
});


test('task session actions open the assistant-ui mount without launching a terminal', async t => {
  const h = await harness(t, false);
  let opened, closed = 0;
  h.window.WorkHubAssistant = { open(options) { opened = options; }, close() { closed++; } };
  assert(h.$('#assistantChatRoot'));
  const actions = [...h.document.querySelectorAll('#requirementSessions .session-row-actions button')];
  assert.equal(actions[1].textContent, '继续对话');
  actions[1].click();
  await settle();
  assert.equal(opened.task.id, 'task');
  assert.equal(opened.session.id, 'session-1');
  assert.equal(h.$('#sessionHistoryPanel').hasAttribute('data-assistant-ui'), true);
  assert.equal(h.currentSession().assistant, true);
  opened.close();
  assert.equal(closed, 1);
  h.click('[data-session-action="new"]');
  assert.equal(opened.session, null);
  opened.created({ id: 'new-session', name: 'New', cwd: '/workspace/task/app', available: true });
  assert.equal(h.currentSession().session, 'new-session');
  assert(h.$('[data-session="new-session"]'));
  assert(!h.requests.some(r => r.url.endsWith('/resume') || r.url.endsWith('/launch')));
});
