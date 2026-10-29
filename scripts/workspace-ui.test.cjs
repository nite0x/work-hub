const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MessageChannel } = require('node:worker_threads');
const { JSDOM } = require('jsdom');

const web = path.join(__dirname, '../web');
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

async function harness(t, readOnly = true, {origin = 'http://localhost:4317', pins = {}, storage = {}, storageUnavailable = false, intercept: initialIntercept} = {}) {
  const tree = (path, branch) => ({ path, branch, dirty: 0, status_updated_at: '2026-10-23T06:00:00Z' });
  const app = { id: 'app', name: 'App', folder: 'app', path: '/repo/app', worktrees: [tree('/repo/app', 'master'), tree('/workspace/task/app', 'feature/task')] };
  const backend = { id: 'backend', name: 'Backend', folder: 'backend', path: '/repo/backend', worktrees: [tree('/repo/backend', 'master')] };
  const task = { id: 'task', name: 'Billing', slug: 'task', branch: 'feature/task', state: 'ready', path: '/workspace/task', created_at: '2026-10-23T06:00:00Z', primary_project_id: app.id, has_workspace: true, members: [{ project_id: app.id, project_name: app.name, mode: 'worktree', path: app.worktrees[1].path, state: 'ready', worktree: app.worktrees[1] }] };
  const data = { root: '/workspace', projects: [app, backend], requirements: [task, { ...task, id: 'archived', name: 'Archived', state: 'archived' }], terminal: { platform: 'linux', available: true, settings: { kind: 'auto' }, supported_kinds: ['auto', 'custom'], supported_styles: ['command', 'otty'], launcher: '/usr/bin/terminal', message: '终端已就绪' } };
  const environments = { environments: [{ id: 'local', name: '本机' }], distributions: [], platform: 'linux', wsl_supported: false };
  const sessions = [{ id: 'session-1', name: 'Billing review', cwd: app.worktrees[1].path, updated_at: 1792735200, available: true, source: 'workspace' }];
  const links = new Map([['task', new Set(['session-1'])]]);
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
  const dom = new JSDOM(fs.readFileSync(path.join(web, 'index.html'), 'utf8').replace('__SESSION_MODE__', readOnly ? 'read-only' : 'interactive'), { url: origin + '/#/requirements/task', runScripts: 'outside-only', pretendToBeVisual: true });
  const channels = [];
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close(); } });
  const { window } = dom;
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  if (storageUnavailable) Object.defineProperty(window, 'localStorage', {get() {throw new Error('Storage unavailable');}});
  const document = window.document;
  Object.assign(window, { TextEncoder, TextDecoder, ReadableStream, WritableStream, TransformStream, CSS: { escape: value => value }, MessageChannel: class extends MessageChannel { constructor() { super(); channels.push(this); } }, scrollTo() {}, confirm: () => true });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const requests = [];
  let intercept = initialIntercept;
  window.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url, options, body });
    if (intercept) { const result = await intercept(url, options, body); if (result) return result; }
    let result;
    if (url.startsWith('/api/shortcut-pins?')) {
      const environment = new URL(url, origin).searchParams.get('environment');
      if (options.method === 'PUT' && (!body.initialize || !pins[environment])) pins[environment] = {tasks:body.tasks, directories:body.directories, initialized:true};
      result = pins[environment] || {tasks:[], directories:[], initialized:false};
    }
    else if (url.startsWith('/api/task-inventory')) result = { requirements: data.requirements.map(q => ({ ...q, environment_id: 'local', environment_name: '本机', connected: true })), environments: [{ id: 'local', name: '本机', connected: true }], project_count: data.projects.length };
    else if (url === '/api/environments') result = options.method === 'POST' ? { id: 'wsl-test' } : environments;
    else if (url === '/api/settings/terminal' && options.method === 'PUT') result = data.terminal = { ...data.terminal, settings: body, launcher: body.path || '/usr/bin/terminal', message: '终端已就绪' };
    else if (url === '/api/settings/session-title') {
      if (options.method === 'PUT') data.title_settings = body;
      result = {settings: data.title_settings || {model: ''}, models: [{model:'body-model',displayName:'正文模型'}, {model:'title-model',displayName:'标题模型'}]};
    }
    else if (url.endsWith('/history/events') || url.includes('/chat/events?')) return { ok: true, headers: { get: () => 'text/event-stream' }, body: new ReadableStream({ start(controller) { controller.close(); } }) };
    else if (url.includes('/history')) result = { session: sessions[0], entries: url.includes('cursor=') ? [{ id: 'older', turn_id: 'old-turn', kind: 'assistant', text: '更早的记录' }] : history, next_cursor: url.includes('cursor=') ? null : 'older-page' };
    else if (url.endsWith('/chat/approval') || url.endsWith('/chat')) result = { id: body?.request_id || 'run-1', status: 'idle', busy: false, entries: [], approvals: [] };
    else if (url.endsWith('/resume')) result = { message: '已打开会话终端' };
    else if (url.startsWith('/api/codex/sessions?')) result = { data: sessions.map(s => ({ ...s, updatedAt: s.updated_at })), nextCursor: null };
    else if (/^\/api\/requirements\/[^/]+\/sessions\/[^/]+$/.test(url) && options.method === 'DELETE') {
      links.get(url.split('/')[3])?.delete(url.split('/')[5]); result = {message: '已取消关联'};
    }
    else if (url.endsWith('/sessions') || url.startsWith('/api/sessions?')) {
      const query = new URL(url, 'http://localhost').searchParams;
      const q = data.requirements.find(q => q.id === query.get('task_id'));
      const p = data.projects.find(p => p.id === query.get('project_id'));
      const paths = q ? [q.path, ...q.members.map(m => m.path)] : p ? p.worktrees.map(t => t.path) : null;
      if (options.method === 'POST') { const id = url.split('/')[3]; if (!links.has(id)) links.set(id,new Set()); links.get(id).add(body.session_id); result = {message:'会话已关联'}; }
      else result = { sessions: sessions.filter(s => (q && query.get('linked') === 'true' ? links.get(q.id)?.has(s.id) : !paths || paths.includes(s.cwd)) && (!query.has('cwd') || query.get('cwd') === s.cwd)) };
    }
    else if (url.endsWith('/git')) result = options.method === 'POST' ? { message: '已完成', output: 'fixture result' } : overview(data.projects.find(p => url.includes('/' + p.id + '/')));
    else if (url === '/api/projects' && options.method === 'POST') { data.projects.push({ id: 'new-project', ...body, folder: 'new-project', worktrees: [tree(body.path, 'master')] }); result = { id: 'new-project' }; }
    else if (url === '/api/requirements/task' && options.method === 'PATCH') { Object.assign(data.requirements[0],body); result=data.requirements[0]; }
    else if (url.startsWith('/api/requirements/task/projects/') && options.method === 'DELETE') { data.requirements[0].members = data.requirements[0].members.filter(m => m.project_id !== url.split('/')[5]); result=data.requirements[0]; }
    else if (url.startsWith('/api/requirements/task/projects/') && options.method === 'PUT') { const p=data.projects.find(p => p.id === url.split('/')[5]); const m=data.requirements[0].members.find(m => m.project_id === p.id); const tree=p.worktrees.find(t => t.path === (body.mode === 'project' ? p.path : body.path)); Object.assign(m,{mode:body.mode,path:tree?.path || body.path,worktree:tree}); result=data.requirements[0]; }
    else if (url === '/api/requirements/task/projects'  && options.method === 'POST') { result = { ...task, members: [...task.members, { project_id: backend.id, project_name: backend.name, mode: 'project', path: backend.path, state: 'ready', worktree: backend.worktrees[0] }] }; data.requirements[0] = result; }
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
  return { window, document, $, change, input, data, environments, sessions, links, history, requests, currentSession: () => vm.runInContext('sessionHistoryState', dom.getInternalVMContext()), setIntercept(fn) { intercept = fn; }, click(selector) { $(selector).click(); }, async navigate(route) { const changed = new Promise(resolve => window.addEventListener('hashchange', resolve, { once: true })); window.navigate(route); await changed; await settle(); }, async submit(selector) { $(selector).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle(); } };
}

for (const readOnly of [true, false]) test(`the production UI mounts before controllers in ${readOnly ? 'read-only' : 'interactive'} mode`, async t => {
  const h = await harness(t, readOnly);
  assert.match(h.$('#content').textContent, /关联项目与工作目录/);
  assert(h.$('#content .task-project-list'));
  assert(h.$('#projectForm [data-slot="input"]'));
  assert(h.$('#requirementForm [data-slot="native-select"]'));
  const ids = [...h.document.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.doesNotMatch(h.$('#content').textContent, /各项目的终端和 Git 操作直接进入上表对应的工作目录|首次使用 Codex 时可能需要登录/);
  assert.equal(h.$('#requirementSlug'), null);
  assert.equal(h.$('#primaryProject'), null);
  assert(h.$('#taskEditForm')); assert(h.$('#taskDirectoryForm'));
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
  h.click('#projectPicker-app-selected');
  assert.equal(h.$('#projectPicker-app-selected').checked, true);
  assert.equal(h.$('#projectPicker-app-selected').disabled, false);
  h.change('#projectPicker-app-mode', 'worktree'); await settle();
  h.change('#projectPicker-app-path', '/workspace/task/app');
  h.click('#projectPicker-backend-selected');
  h.change('#projectPicker-backend-mode', 'new'); await settle();
  const branch = h.input('#projectPicker-backend-branch', 'custom/billing');
  assert.equal(h.$('#projectPicker-backend-branch'), branch);
  h.input('#requirementName', 'Billing final');
  assert.equal(h.$('#projectPicker-backend-branch').value, 'custom/billing');
  assert.equal(h.$('#requirementSubmit').disabled, false);
  const formData = new h.window.FormData(h.$('#requirementForm'));
  assert.equal(formData.get('name'), 'Billing final');
  assert.equal(formData.get('slug'), null);
  await h.submit('#requirementForm');
  const request = h.requests.find(r => r.url === '/api/requirements' && r.options.method === 'POST');
  assert.deepEqual(request.body.members, [{ project_id: 'app', mode: 'worktree', path: '/workspace/task/app' }, { project_id: 'backend', mode: 'new', branch: 'custom/billing', source: 'refs/heads/master' }]);
  assert.equal(h.$('#requirementDialog').open, false);
});

test('existing branch choices create a new task directory and retain selections across modes', async t => {
  const h = await harness(t);
  h.window.openRequirement(); await settle();
  h.input('#requirementName', 'Existing branch');
  h.click('#projectPicker-app-selected'); await settle();
  h.input('#projectPicker-app-branch', 'custom/new');
  h.change('#projectPicker-app-mode', 'existing');
  assert.equal(h.$('#projectPicker-app-branch'), null);
  assert.equal(h.$('#projectPicker-app-source'), null);
  assert.equal(h.$('#requirementSubmit').disabled, true);
  assert.equal(h.$('#projectPicker-app-existingBranch option[value="master"]').disabled, true);
  assert.equal(h.$('#projectPicker-app-existingBranch option[value="feature/task"]').disabled, true);
  assert.equal(h.$('#projectPicker-app-existingBranch option[value="origin/master"]'), null);
  h.change('#projectPicker-app-existingBranch', 'release');
  assert.equal(h.$('#requirementSubmit').disabled, false);
  assert.match(h.$('#workspacePreview').textContent, /\/workspace\/[^/]+\/app（新建 · release）/);
  h.change('#projectPicker-app-mode', 'new');
  assert.equal(h.$('#projectPicker-app-branch').value, 'custom/new');
  h.change('#projectPicker-app-mode', 'existing');
  h.input('#requirementName', 'Renamed task');
  assert.equal(h.$('#projectPicker-app-existingBranch').value, 'release');
  await h.submit('#requirementForm');
  assert.deepEqual(h.requests.find(r => r.url === '/api/requirements' && r.options.method === 'POST').body.members, [{project_id: 'app', mode: 'existing', branch: 'release'}]);
});

test('existing branches can be used when adding a project or replacing its directory', async t => {
  const h = await harness(t);
  h.window.openRequirementProjects('task');
  h.click('#requirementProjectPicker-backend-selected'); await settle();
  h.change('#requirementProjectPicker-backend-mode', 'existing');
  assert.equal(h.$('#requirementProjectsSubmit').disabled, true);
  h.change('#requirementProjectPicker-backend-existingBranch', 'release');
  assert.equal(h.$('#requirementProjectsSubmit').disabled, false);
  assert.match(h.$('#requirementProjectsPreview').textContent, /\/workspace\/task\/backend（新建 · release）/);
  await h.submit('#requirementProjectsForm');
  assert.deepEqual(h.requests.find(r => r.url === '/api/requirements/task/projects').body.members, [{project_id: 'backend', mode: 'existing', branch: 'release'}]);
  h.window.openTaskDirectory('task', 'app'); await settle();
  h.change('#taskDirectoryPicker-app-mode', 'existing');
  h.change('#taskDirectoryPicker-app-existingBranch', 'release');
  assert.equal(h.$('#taskDirectorySubmit').disabled, false);
  assert.match(h.$('#taskDirectoryPreview').textContent, /使用已有分支 release/);
  await h.submit('#taskDirectoryForm');
  const request = h.requests.find(r => r.url === '/api/requirements/task/projects/app' && r.options.method === 'PUT');
  assert.equal(request.body.mode, 'existing');
  assert.equal(request.body.branch, 'release');
  assert.match(request.body.path, /^\/workspace\/task\/app-[a-f0-9]+$/);
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
  h.change('#requirementProjectPicker-backend-mode', 'project');
  assert.equal(h.$('#requirementProjectsSubmit').disabled, false);
  await h.submit('#requirementProjectsForm');
  assert.deepEqual(h.requests.find(r => r.url === '/api/requirements/task/projects').body, { project_ids: ['backend'], members: [{ project_id: 'backend', mode: 'project' }] });
  assert.equal(h.$('#requirementProjectsDialog').open, false);
});

test('folder selection fills the project path, preserves drafts on cancellation and reports failures', async t => {
  const h = await harness(t);
  let result = { path: '/repo/中文 项目' };
  let failed = false;
  h.setIntercept((url) => url === '/api/dialogs/directory' ? { ok: !failed, json: async () => failed ? { error: '无法打开文件夹选择窗口' } : result } : null);
  h.window.openProject();
  h.input('#projectName', 'Keep this name');
  h.click('#chooseProjectDirectory'); await settle();
  assert.equal(h.$('#projectPath').value, result.path);
  assert.equal(h.$('#projectName').value, 'Keep this name');
  assert.equal(h.$('#projectDialog').open, true);
  assert.equal(h.requests.find(r => r.url === '/api/dialogs/directory').options.headers['X-Environment-ID'], 'local');
  assert.equal(h.requests.some(r => r.url === '/api/projects' && r.options.method === 'POST'), false);
  result = { path: '' };
  h.click('#chooseProjectDirectory'); await settle();
  assert.equal(h.$('#projectPath').value, '/repo/中文 项目');
  assert.equal(h.$('#projectError').hidden, true);
  failed = true;
  h.click('#chooseProjectDirectory'); await settle();
  assert.match(h.$('#projectError').textContent, /无法打开/);
  assert.equal(h.$('#projectError').hidden, false);
  assert.equal(h.$('#chooseProjectDirectory').disabled, false);
  assert.equal(h.$('#projectPath').value, '/repo/中文 项目');
});

test('folder selection cannot overlap or put a host path into a WSL project', async t => {
  const h = await harness(t);
  let release;
  const selected = new Promise(resolve => { release = resolve; });
  h.setIntercept(async url => url === '/api/dialogs/directory' ? await selected : null);
  h.window.openProject();
  h.click('#chooseProjectDirectory'); h.click('#chooseProjectDirectory');
  assert.equal(h.$('#chooseProjectDirectory').disabled, true);
  assert.equal(h.$('#projectEnvironmentSelect').disabled, true);
  h.click('#projectDialog .close-dialog');
  assert.equal(h.$('#projectDialog').open, true);
  assert.equal(h.requests.filter(r => r.url === '/api/dialogs/directory').length, 1);
  release({ ok: true, json: async () => ({ path: '' }) }); await settle();
  assert.equal(h.$('#chooseProjectDirectory').disabled, false);
  assert.equal(h.$('#projectEnvironmentSelect').disabled, false);
  h.environments.environments.push({ id: 'wsl-test', name: 'WSL' });
  await h.window.loadEnvironments();
  h.window.openProject(null, 'wsl-test');
  assert.equal(h.$('#chooseProjectDirectory').disabled, true);
  assert.equal(h.$('#projectDirectoryHint').hidden, false);
  h.click('#chooseProjectDirectory'); await settle();
  assert.equal(h.requests.filter(r => r.url === '/api/dialogs/directory').length, 1);
  h.change('#projectEnvironmentSelect', 'local');
  assert.equal(h.$('#chooseProjectDirectory').disabled, false);
  assert.equal(h.$('#projectDirectoryHint').hidden, true);
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
  assert.match(h.$('#content').textContent, /待推 2 · 待拉 1 · 已分歧/);
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
    if (url.endsWith('/sessions/new')) {
      const session = { id: 'merge-session', name: '解决合并冲突', cwd: '/workspace/task/app' };
      h.sessions.push(session);
      h.links.get('task').add(session.id);
      return ok({ session, chat: { id: body.request_id, status: 'starting', busy: true, entries: [], approvals: [] } });
    }
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

test('task cards keep the full path visible and distinguish upstream sync from baseline differences', async t => {
  const h = await harness(t);
  Object.assign(h.data.requirements[0].members[0], { base_ref: 'refs/heads/master', base_commit: 'c2de7c96abcdef' });
  const tree = h.data.projects[0].worktrees[1];
  Object.assign(tree, { upstream: 'origin/feature/task', sync_available: true, sync_ahead: 0, sync_behind: 0, compare_available: true, comparison_ref: 'master', ahead: 1, behind: 0 });
  await h.window.refresh();
  assert.equal(h.$('.task-project-path').textContent, '/workspace/task/app');
  assert.equal(h.$('.task-project-path').closest('details'), null);
  let copied;
  Object.defineProperty(h.window.navigator, 'clipboard', { value: { writeText: async value => { copied = value; } } });
  h.click('.task-project-path'); await settle();
  assert.equal(copied, '/workspace/task/app');
  assert.match(h.$('.task-project .comparison').textContent, /上游 origin\/feature\/task · 已同步/);
  assert.equal(h.$('.task-baseline').textContent, '基线 master · 领先 1');
  assert.match(h.$('.task-baseline').title, /c2de7c96abcdef/);
  assert.equal(h.$('.task-project-details').open, false);
  assert.equal(h.$('.task-project-state time'), null);
  assert(h.$('.task-project-details time'));
  assert.doesNotMatch(h.$('.task-project').textContent, /待推 0|待拉 0|落后 0|创建基线|相对基线/);
  Object.assign(tree, { sync_ahead: 0, sync_behind: 3, ahead: 0, behind: 0 });
  await h.window.refresh();
  assert.match(h.$('.task-project .comparison').textContent, /待拉 3/);
  assert.equal(h.$('.task-baseline').textContent, '基线 master · 与基线一致');
  tree.sync_available = false;
  await h.window.refresh();
  assert.match(h.$('.task-project .comparison').textContent, /不可用，请获取远端/);
  assert.doesNotMatch(h.$('.task-project .comparison').textContent, /已同步/);
});

test('the open split button remembers the chosen tool and retains its worktree after rendering', async t => {
  const h = await harness(t);
  assert.match(h.$('[data-project-open-primary]').textContent, /VS Code 打开/);
  h.click('[data-project-open] summary');
  assert.equal(h.$('[data-project-open] details').open, true);
  h.click('[data-project-open-choice="idea"]'); await settle();
  assert.equal(h.$('[data-project-open] details').open, false);
  assert.equal(h.window.localStorage.getItem('workhub:project-open:v1'), 'idea');
  assert.deepEqual(h.requests.find(r => r.url === '/api/projects/app/open').body, { tool: 'idea', path: '/workspace/task/app' });
  h.window.render();
  assert.match(h.$('[data-project-open-primary]').textContent, /IDEA 打开/);
  h.click('[data-project-open-primary]'); await settle();
  assert.equal(h.requests.filter(r => r.url === '/api/projects/app/open').length, 2);
  h.click('[data-project-open] summary');
  h.$('[data-project-open] summary').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.$('[data-project-open] details').open, false);
  assert.equal(h.document.activeElement, h.$('[data-project-open] summary'));
  h.click('[data-project-open-choice="terminal"]'); await settle();
  assert.deepEqual(h.requests.find(r => r.body?.action === 'terminal').body, { action: 'terminal', path: '/workspace/task/app' });
  h.window.render();
  assert.match(h.$('[data-project-open-primary]').textContent, /终端 打开/);
  assert.equal(h.$('[data-project-open-primary]').dataset.action, 'workspace-terminal');
});

test('task information stays visible and only offers expansion when the description overflows', async t => {
  const h = await harness(t);
  h.data.requirements[0].description = '任务目标\n实现项目卡片精简\n保留完整路径\n统一打开方式';
  await h.window.refresh();
  const description = h.$('#taskDescription');
  const button = h.$('[data-action="task-info-toggle"]');
  assert.equal(h.$('.task-info').tagName, 'SECTION');
  assert.equal(description.closest('details'), null);
  assert.equal(button.hidden, true);
  Object.defineProperties(description, { scrollHeight: {value: 100, configurable: true}, clientHeight: {value: 60, configurable: true} });
  h.window.syncTaskDescription();
  assert.equal(button.hidden, false);
  h.click('[data-action="task-info-toggle"]');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(button.textContent, '收起');
  assert.equal(description.classList.contains('task-description-clamped'), false);
  h.window.render();
  assert.equal(h.$('[data-action="task-info-toggle"]').getAttribute('aria-expanded'), 'true');
  h.click('[data-action="task-info-toggle"]');
  assert.equal(h.$('#taskDescription').classList.contains('task-description-clamped'), true);
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

test('a busy Git operation allows closing its dialog and recovers its controls after failure', async t => {
  const h = await harness(t);
  await h.window.openGit('app', '/workspace/task/app');
  let release;
  h.setIntercept((url, options) => options.method === 'POST' && url.endsWith('/git') ? new Promise(resolve => { release = resolve; }) : undefined);
  const operation = h.window.gitOperation({ action: 'fetch', remote: 'origin' }, '正在获取分支');
  await settle();
  assert.equal(h.$('[data-action="git-reload"]').disabled, true);
  const cancel = new h.window.Event('cancel', { cancelable: true });
  h.$('#gitDialog').dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, false);
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
  h.change('#terminalStyle', 'command');
  h.data.projects[0].worktrees[0].dirty = 2;
  await h.window.refresh();
  assert.equal(h.$('#terminalPath'), pathInput);
  assert.equal(pathInput.value, ' /my/terminal ');
  await h.submit('#terminalForm');
  assert.deepEqual(h.requests.find(r => r.url === '/api/settings/terminal' && r.options.method === 'PUT').body, { kind: 'custom', path: '/my/terminal', style: 'command' });
  assert.equal(h.$('#terminalError').hidden, true);
});

test('title settings select a separate Codex model and retain unsaved edits during polling', async t => {
  const h = await harness(t);
  await h.navigate('/settings');
  assert.equal(h.$('#sessionTitleFields').disabled, false);
  assert.equal(h.$('#sessionTitleModel').value, '');
  h.change('#sessionTitleModel', 'title-model');
  await h.window.refresh(true); await settle();
  assert.equal(h.$('#sessionTitleModel').value, 'title-model');
  await h.submit('#sessionTitleForm');
  assert.deepEqual(h.requests.find(r => r.url === '/api/settings/session-title' && r.options.method === 'PUT').body, {model:'title-model'});
  assert.equal(h.$('#sessionTitleError').hidden, true);
  h.setIntercept((url, options) => url === '/api/settings/session-title' && options.method === 'PUT' ? {ok:false,json:async()=>({error:'模型已不可用'})} : undefined);
  h.change('#sessionTitleModel', 'body-model');
  await h.submit('#sessionTitleForm');
  assert.equal(h.$('#sessionTitleModel').value, 'body-model');
  assert.equal(h.$('#sessionTitleError').getAttribute('role'), 'alert');
  assert.match(h.$('#sessionTitleError').textContent, /模型已不可用/);
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

test('read-only conversations retain history paging, expanded commands and a live output dialog', async t => {
  const h = await harness(t);
  h.click('[data-action="task-conversations"]'); await settle();
  assert.equal(h.$('#newBrowserSession').disabled, true);
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
  assert.equal(h.$('#conversationDialog').open, false);
  assert.equal(h.$('#sessionHistoryPanel').hidden, true);
  assert.equal(h.document.activeElement.dataset.action, 'task-conversations');
  assert(!h.requests.some(r => r.url.endsWith('/chat') || r.url.endsWith('/sessions/new')));
});

test('the global scope picker searches tasks, projects and directories without requiring task association', async t => {
  const h = await harness(t);
  h.sessions.push({ id: 'outside', name: 'Outside conversation', cwd: '/outside' });
  await h.navigate('/sessions');
  h.$('#sessionScopePicker').open = true; await settle();
  h.input('#sessionScopeSearch', '/outside');
  const result = h.$('[data-conversation-scope]');
  assert.equal(JSON.parse(result.dataset.conversationScope).cwd, '/outside');
  result.click(); await settle();
  assert.equal(h.$('#sessionScopePicker').open, false);
  assert.equal(h.$('[data-conversation-session]').dataset.conversationSession, 'outside');
  assert.equal(h.$('#newBrowserSession').disabled, true);
  assert.equal(h.$('#sessionDirectoryField').hidden, true);
  h.click('[data-conversation-action="all"]'); await settle();
  assert.equal(h.document.querySelectorAll('[data-conversation-session]').length, 2);
});

test('background activity and unread completion update navigation without reopening a conversation', async t => {
  const h = await harness(t);
  h.click('[data-action="task-conversations"]'); await settle();
  h.click('[data-conversation-action="close"]');
  const activity = () => h.$('#sessionNavigationStatus').textContent;
  h.sessions[0].chat_status = 'running';
  await h.window.refreshSessionWorkspace(true); assert.equal(activity(), '运行中');
  h.sessions[0].chat_status = 'waiting';
  await h.window.refreshSessionWorkspace(true); assert.equal(activity(), '待确认');
  h.sessions[0].chat_status = ''; h.sessions[0].completed_run = 'background-run';
  await h.window.refreshSessionWorkspace(true); assert.equal(activity(), '有新消息');
  assert.equal(h.$('#conversationDialog').open, false);
  h.window.eval('sessionReadMemory.clear()');
  await h.window.refreshSessionWorkspace(true); assert.equal(activity(), '有新消息');
  h.click('[data-action="task-conversations"]'); await settle();
  assert.equal(activity(), '');
  const seen = JSON.parse(h.window.localStorage.getItem('workhub:session-read:' + JSON.stringify(['local', 'session-1'])));
  assert.equal(seen.run, 'background-run');
  h.click('[data-conversation-action="close"]');
  h.sessions[0].completed_run = 'another-run';
  await h.window.refreshSessionWorkspace(true); assert.equal(activity(), '有新消息');
});

test('assistant activity immediately updates the shared list and navigation', async t => {
  const h = await harness(t, false);
  let opened;
  h.window.WorkHubAssistant = { open(options) { opened = options; }, close() {} };
  h.click('[data-action="task-conversations"]'); await settle();
  opened.activity('session-1', { id: 'live', status: 'running', busy: true });
  assert.equal(h.$('[data-session-indicators="session-1"]').textContent, '运行中');
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

test('message shortcuts and drafts retain their concrete creation directory', async t => {
  const h = await harness(t, false);
  h.window.openSessionHistory('task', 'session-1'); await settle();
  h.input('#sessionChatInput', '  继续检查  ');
  h.$('#sessionChatInput').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  await settle();
  const sent = h.requests.filter(r => r.url.endsWith('/chat') && r.options.method === 'POST');
  assert.equal(sent.length, 1); assert.equal(sent[0].body.text, '继续检查'); assert(sent[0].body.request_id);
  h.click('#newBrowserSession');
  assert.equal(h.$('#sessionBrowserNewDirectory').value, '');
  h.change('#sessionBrowserNewDirectory', '/workspace/task/app');
  assert.match(h.$('#sessionHistoryEntries').textContent, /从这里开始对话/);
  h.input('#sessionChatInput', '保留这份草稿');
  h.window.closeSessionHistory(); h.window.openSessionHistory('task');
  h.change('#sessionBrowserNewDirectory', '/workspace/task/app');
  assert.equal(h.$('#sessionChatInput').value, '保留这份草稿');
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


for (const readOnly of [true, false]) test(`task and project each have one conversation entry in ${readOnly ? 'read-only' : 'interactive'} mode`, async t => {
  const h = await harness(t, readOnly);
  let opened, closed = 0;
  h.window.WorkHubAssistant = { open(options) { opened = options; }, close() { closed++; } };
  assert.equal(h.document.querySelectorAll('[data-action="task-conversations"]').length, 1);
  assert.equal(h.$('#content [data-session-action]'), null);
  assert.equal(h.$('#taskWorkspaceLayout'), null);
  h.click('[data-action="task-conversations"]'); await settle();
  assert.equal(h.$('#conversationDialog').open, true);
  assert.equal(opened.session.id, 'session-1'); assert.equal(opened.readOnly, readOnly);
  assert.equal(h.$('#newBrowserSession').disabled, readOnly);
  const ids = [...h.document.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(new Set(ids).size, ids.length);
  opened.close();
  assert.equal(closed, 1); assert.equal(h.$('#conversationDialog').open, false);
  await h.navigate('/projects');
  h.click('[data-action="select-project"][data-id="app"]');
  assert.equal(h.document.querySelectorAll('[data-action="project-conversations"]').length, 1);
  assert.equal(h.$('tbody [data-session-action]'), null);
  h.click('[data-action="project-conversations"]'); await settle();
  assert.match(h.$('#conversationDialogTitle').textContent, /项目 · App/);
  if (!readOnly) {
    h.click('#newBrowserSession'); h.change('#sessionBrowserNewDirectory', '/repo/app');
    assert.equal(opened.task, undefined); assert.equal(opened.session, null);
    assert.equal(opened.target.cwd, '/repo/app'); assert.equal(opened.target.project_id, 'app');
    opened.created({ id: 'created', name: 'Created', cwd: '/repo/app' });
    assert.equal(h.currentSession().session, 'created');
    assert(h.$('[data-conversation-session="created"]'));
  }
  assert(!h.requests.some(r => r.url.endsWith('/resume') || r.url.endsWith('/launch')));
});

test('the page and modal reuse the same browser and active chat when transferring', async t => {
  const h = await harness(t, false);
  let opens = 0, closes = 0;
  h.window.WorkHubAssistant = { open() { opens++; }, close() { closes++; } };
  h.click('[data-action="task-conversations"]'); await settle();
  const browser = h.$('#sessionBrowser'), panel = h.$('#assistantChatRoot'), current = h.currentSession();
  h.change('#sessionDirectoryFilter', '/workspace/task/app'); await settle();
  const afterFilter = h.currentSession();
  const beforeOpens = opens, beforeCloses = closes;
  const pageChanged = new Promise(resolve => h.window.addEventListener('hashchange', resolve, { once: true }));
  h.click('[data-conversation-action="page"]'); await pageChanged; await settle();
  assert.equal(h.$('#conversationDialog').open, false);
  assert.equal(h.window.location.hash, '#/sessions');
  assert.equal(h.$('#sessionsPage').hidden, false); assert.equal(h.$('#workContent').hidden, true);
  assert.equal(h.$('#sessionPageMount #sessionBrowser'), browser);
  assert.equal(h.$('#assistantChatRoot'), panel); assert.equal(h.currentSession(), afterFilter);
  assert.equal(opens, beforeOpens); assert.equal(closes, beforeCloses);
  assert.equal(h.$('#sessionDirectoryFilter').value, '/workspace/task/app');
  h.click('[data-conversation-action="all"]'); await settle();
  assert.equal(h.$('#sessionScopeLabel').textContent, '全部对话');
  await h.navigate('/requirements/task');
  h.click('[data-action="task-conversations"]'); await settle();
  assert.equal(h.$('#sessionModalMount #sessionBrowser'), browser);
  assert.equal(h.$('#assistantChatRoot'), panel);
  assert.equal(h.$('#sessionDirectoryFilter').value, '/workspace/task/app');
  assert.notEqual(h.currentSession(), current); // The controller registry, not DOM history state, owns drafts.
  assert(!h.requests.some(r => r.url.endsWith('/chat/stop')));
});

test('conversation columns resize without reopening chat and retain their width across hosts', async t => {
  const h = await harness(t, false);
  h.click('[data-action="task-conversations"]'); await settle();
  const browser = h.$('#sessionBrowser'), handle = h.$('#sessionBrowserResize');
  const list = h.$('#sessionBrowserListPane'), body = h.$('.session-browser-body');
  let available = 1000, captured;
  body.getBoundingClientRect = () => ({ width: available });
  list.getBoundingClientRect = () => ({ width: Math.max(220, Math.min(parseFloat(browser.style.getPropertyValue('--conversation-list-width')) || 280, available - 328)) });
  handle.setPointerCapture = id => { captured = id; };
  handle.hasPointerCapture = id => captured === id;
  handle.releasePointerCapture = () => { captured = undefined; };
  const pointer = (type, x, id = 1, button = 0) => {
    const event = new h.window.MouseEvent(type, { clientX: x, button, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: id });
    handle.dispatchEvent(event);
  };
  const panel = h.$('#assistantChatRoot'), session = h.currentSession();
  pointer('pointerdown', 280);
  pointer('pointermove', 400, 2); // Another pointer cannot move this split.
  assert.equal(browser.style.getPropertyValue('--conversation-list-width'), '');
  pointer('pointermove', 400);
  assert.equal(handle.getAttribute('aria-valuenow'), '400');
  assert.equal(captured, 1);
  pointer('pointerup', 400);
  assert.equal(captured, undefined);
  assert(!browser.hasAttribute('data-resizing'));
  assert.equal(h.window.localStorage.getItem('workhub:conversation-list-width:v1'), '400');
  const changed = new Promise(resolve => h.window.addEventListener('hashchange', resolve, { once: true }));
  h.click('[data-conversation-action="page"]'); await changed; await settle();
  assert.equal(browser.style.getPropertyValue('--conversation-list-width'), '400px');
  assert.equal(h.$('#assistantChatRoot'), panel);
  assert.equal(h.currentSession(), session);
  available = 720;
  pointer('pointerdown', 392); pointer('pointermove', 900);
  assert.equal(handle.getAttribute('aria-valuenow'), '392'); // Leave room for the conversation.
  pointer('pointermove', -900);
  assert.equal(handle.getAttribute('aria-valuenow'), '220');
  pointer('pointercancel', -900);
  assert(!browser.hasAttribute('data-resizing'));
  pointer('pointermove', 400);
  assert.equal(handle.getAttribute('aria-valuenow'), '220');
  assert(!h.requests.some(r => r.url.endsWith('/chat/stop')));
});

test('conversation split supports keyboard resizing and leaves narrow-screen navigation intact', async t => {
  const h = await harness(t);
  h.click('[data-action="task-conversations"]'); await settle();
  const browser = h.$('#sessionBrowser'), handle = h.$('#sessionBrowserResize');
  let available = 1000;
  h.$('.session-browser-body').getBoundingClientRect = () => ({ width: available });
  h.$('#sessionBrowserListPane').getBoundingClientRect = () => ({ width: parseFloat(browser.style.getPropertyValue('--conversation-list-width')) || 280 });
  const key = (value, shiftKey = false) => handle.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }));
  key('ArrowRight'); assert.equal(handle.getAttribute('aria-valuenow'), '290');
  key('ArrowLeft', true); assert.equal(handle.getAttribute('aria-valuenow'), '250');
  key('End'); assert.equal(handle.getAttribute('aria-valuenow'), '520');
  key('Home'); assert.equal(handle.getAttribute('aria-valuenow'), '220');
  available = 600;
  key('End'); assert.equal(handle.getAttribute('aria-valuenow'), '220');
  h.click('[data-conversation-action="back"]');
  assert.equal(browser.dataset.pane, 'list');
  assert.equal(h.window.localStorage.getItem('workhub:conversation-list-width:v1'), '220');
});

test('task and project directory unions stay distinct and exact filters exclude subdirectories', async t => {
  const h = await harness(t);
  h.links.get('task').add('task-root');
  h.sessions.push({ id: 'task-root', name: 'Task brief', cwd: '/workspace/task' }, { id: 'main', name: 'Main project', cwd: '/repo/app' }, { id: 'child', name: 'Nested directory', cwd: '/workspace/task/app/src' });
  h.click('[data-action="task-conversations"]'); await settle();
  const ids = () => [...h.document.querySelectorAll('[data-conversation-session]')].map(b => b.dataset.conversationSession).sort();
  assert.deepEqual(ids(), ['session-1', 'task-root']);
  assert.equal(h.document.querySelectorAll('.session-browser-item-directory').length, 1);
  assert.match(h.$('[data-conversation-session="session-1"] .session-browser-item-context').textContent, /App.*feature\/task/);
  h.change('#sessionDirectoryFilter', '/workspace/task'); await settle();
  assert.deepEqual(ids(), ['task-root']); assert.equal(h.$('.session-browser-item-directory'), null);
  h.click('[data-conversation-action="close"]');
  await h.navigate('/projects'); h.click('[data-action="select-project"][data-id="app"]');
  h.click('[data-action="project-conversations"]'); await settle();
  assert.deepEqual(ids(), ['main', 'session-1']);
  h.change('#sessionDirectoryFilter', '/repo/app'); await settle(); assert.deepEqual(ids(), ['main']);
  assert(h.requests.some(r => r.url.includes('project_id=app') && r.url.includes('cwd=%2Frepo%2Fapp')));
});

test('task-root and unattached detached worktree creation use an explicit target without adding task ownership', async t => {
  const h = await harness(t, false);
  h.data.projects[0].worktrees.push({ path: '/repo/detached', detached: true, status_updated_at: '2026-10-24T00:00:00Z' });
  h.setIntercept((url, options, body) => {
    if (url !== '/api/sessions/new') return;
    const session = { id: 'new-' + h.sessions.length, name: body.text, cwd: body.cwd, available: true };
    h.sessions.push(session);
    return { ok: true, json: async () => ({ session, chat: { id: body.request_id, status: 'running', busy: true, entries: [], approvals: [] } }) };
  });
  h.click('[data-action="task-conversations"]'); await settle(); h.click('#newBrowserSession');
  assert.equal(h.$('#sessionHistoryPanel').hidden, true);
  h.change('#sessionBrowserNewDirectory', '/workspace/task'); h.input('#sessionChatInput', '整理任务说明');
  await h.submit('#sessionChatForm');
  const taskRequest = h.requests.find(r => r.url === '/api/sessions/new');
  assert.equal(taskRequest.body.task_id, 'task'); assert.equal(taskRequest.body.cwd, '/workspace/task');
  assert(!taskRequest.body.project_id);
  h.click('[data-conversation-action="close"]');
  await h.navigate('/projects'); h.click('[data-action="select-project"][data-id="app"]'); h.click('[data-action="project-conversations"]'); await settle();
  h.change('#sessionDirectoryFilter', '/repo/detached'); await settle(); h.click('#newBrowserSession');
  assert.equal(h.$('#sessionBrowserNewDirectoryField').hidden, true);
  h.input('#sessionChatInput', '检查游离工作目录'); await h.submit('#sessionChatForm');
  const projectRequest = h.requests.filter(r => r.url === '/api/sessions/new').at(-1);
  assert.equal(projectRequest.body.project_id, 'app'); assert.equal(projectRequest.body.cwd, '/repo/detached');
  assert.equal(projectRequest.body.task_id, undefined);
  assert.notEqual(projectRequest.body.request_id, taskRequest.body.request_id);
  h.click('[data-conversation-action="close"]');
  assert(!h.requests.some(r => r.url.endsWith('/chat/stop')));
});

test('late directory responses cannot replace the latest filter, including switching back to the first directory', async t => {
  const h = await harness(t);
  const pending = [];
  h.setIntercept(url => url.startsWith('/api/sessions?') && url.includes('cwd=') ? new Promise(resolve => pending.push({ url, resolve })) : undefined);
  h.click('[data-action="task-conversations"]'); await settle();
  h.change('#sessionDirectoryFilter', '/workspace/task/app');
  h.change('#sessionDirectoryFilter', '/workspace/task');
  h.change('#sessionDirectoryFilter', '/workspace/task/app');
  assert.equal(pending.length, 3);
  const ok = sessions => ({ ok: true, json: async () => ({ sessions }) });
  pending[2].resolve(ok([{ id: 'latest', name: 'Latest response', cwd: '/workspace/task/app' }])); await settle();
  pending[0].resolve(ok([{ id: 'stale', name: 'Old response', cwd: '/workspace/task/app' }]));
  pending[1].resolve(ok([{ id: 'wrong-dir', name: 'Wrong directory', cwd: '/workspace/task' }])); await settle();
  assert.equal(h.$('[data-conversation-session]').dataset.conversationSession, 'latest');
  assert.equal(h.$('#sessionDirectoryFilter').value, '/workspace/task/app');
});

test('closing the modal preserves task scroll and details across refresh and task navigation', async t => {
  const h = await harness(t);
  h.data.requirements.push({ ...h.data.requirements[0], id: 'other-task', name: 'Other task' });
  h.$('#taskProjectsView').scrollTop = 135; h.$('.task-project-details').open = true;
  h.click('[data-action="task-conversations"]'); await settle(); h.window.render();
  h.click('[data-conversation-action="close"]');
  assert.equal(h.$('#taskProjectsView').scrollTop, 135); assert.equal(h.$('.task-project-details').open, true);
  await h.navigate('/requirements/other-task'); assert.equal(h.$('.task-project-details').open, false);
  await h.navigate('/requirements/task'); assert.equal(h.$('.task-project-details').open, true); assert.equal(h.$('#taskProjectsView').scrollTop, 135);
});

test('scope picker Escape, mobile list navigation and modal cancellation retain the expected focus', async t => {
  const h = await harness(t);
  await h.navigate('/sessions'); h.$('#sessionScopePicker').open = true; await settle();
  h.$('#sessionScopeSearch').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(h.$('#sessionScopePicker').open, false); assert(h.currentSession());
  h.click('[data-conversation-session]'); assert.equal(h.$('#sessionBrowser').dataset.pane, 'detail');
  h.click('[data-conversation-action="back"]'); assert.equal(h.$('#sessionBrowser').dataset.pane, 'list');
  await h.navigate('/requirements/task'); h.click('[data-action="task-conversations"]'); await settle();
  h.$('#conversationDialog').dispatchEvent(new h.window.Event('cancel', { cancelable: true }));
  assert.equal(h.$('#conversationDialog').open, false); assert.equal(h.document.activeElement.dataset.action, 'task-conversations');
});

test('environment switching isolates identical conversation IDs and rejects late responses', async t => {
  const h = await harness(t, false);
  h.environments.environments.push({ id: 'remote', name: 'Remote' });
  await h.window.loadEnvironments();
  let release;
  h.setIntercept((url, options) => {
    if (!url.startsWith('/api/sessions?')) return;
    if (options.headers['X-Environment-ID'] === 'local') return new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ sessions: [{ id: 'session-1', name: 'Remote conversation', cwd: '/remote' }] }) };
  });
  await h.navigate('/sessions');
  const old = release;
  await h.window.selectEnvironment('remote', '/sessions'); await settle();
  assert.equal(h.$('[data-conversation-session]').textContent.includes('Remote conversation'), true);
  old({ ok: true, json: async () => ({ sessions: [{ id: 'session-1', name: 'Late local conversation', cwd: '/local' }] }) }); await settle();
  assert.equal(h.$('[data-conversation-session]').textContent.includes('Remote conversation'), true);
  assert.equal(h.$('#sessionsEnvironment').value, '');
  assert(h.requests.some(r => r.url.startsWith('/api/sessions?') && r.options.headers['X-Environment-ID'] === 'remote'));
});

test('a narrow list does not mark hidden conversation details as read', async t => {
  const h = await harness(t);
  h.click('[data-action="task-conversations"]'); await settle(); h.click('[data-conversation-action="close"]');
  h.sessions[0].completed_run = 'unread-mobile'; await h.window.refreshSessionWorkspace(true);
  h.$('#sessionBrowser').getBoundingClientRect = () => ({ width: 360 });
  h.click('[data-action="task-conversations"]'); await settle();
  assert.equal(h.$('#sessionBrowser').dataset.pane, 'list');
  assert.equal(h.$('#sessionNavigationStatus').textContent, '有新消息');
  h.click('[data-conversation-session="session-1"]');
  assert.equal(h.$('#sessionBrowser').dataset.pane, 'detail'); assert.equal(h.$('#sessionNavigationStatus').textContent, '');
});

test('list loading failures distinguish an unreadable scope from an empty directory and recover on retry', async t => {
  const h = await harness(t);
  let release;
  h.setIntercept(url => url.startsWith('/api/sessions?') ? new Promise(resolve => { release = resolve; }) : undefined);
  h.click('[data-action="task-conversations"]');
  assert.match(h.$('#sessionBrowserEmpty').textContent, /正在读取/);
  release({ ok: false, json: async () => ({ error: 'fixture offline' }) }); await settle();
  assert.equal(h.$('#sessionBrowserError').hidden, false);
  assert.match(h.$('#sessionBrowserEmpty').textContent, /暂时无法读取/);
  h.setIntercept(null); h.click('[data-conversation-action="refresh"]'); await settle();
  assert.equal(h.$('#sessionBrowserError').hidden, true);
  assert(h.$('[data-conversation-session="session-1"]'));
});

test('project refresh never silently widens a saved directory filter while worktrees are unavailable', async t => {
  const h = await harness(t);
  await h.navigate('/projects'); h.click('[data-action="select-project"][data-id="app"]');
  h.click('[data-action="project-conversations"]'); await settle();
  h.change('#sessionDirectoryFilter', '/workspace/task/app'); await settle();
  h.data.projects[0].worktrees = [];
  await h.window.refresh(true);
  assert.equal(h.$('#sessionDirectoryFilter').value, '/workspace/task/app');
  assert.equal(h.$('#sessionDirectoryField').hidden, false);
  assert.match(h.$('#sessionDirectoryFilter').selectedOptions[0].textContent, /目录待核实/);
  await h.window.refreshSessionWorkspace(true);
  assert.equal(h.$('#sessionDirectoryFilter').value, '/workspace/task/app');
  assert(h.requests.filter(r => r.url.startsWith('/api/sessions?')).at(-1).url.includes('cwd=%2Fworkspace%2Ftask%2Fapp'));
});

test('conversation pinning sorts the shared list and the archive filter uses its own query',async t=>{
 const h=await harness(t);
 h.sessions.push({id:'pinned',name:'Pinned conversation',cwd:'/workspace/task/app',updated_at:1,pinned:true});
 await h.navigate('/sessions');
 assert.equal(h.$('[data-conversation-session]').dataset.conversationSession,'pinned');
 h.setIntercept(url=>url.startsWith('/api/sessions?')&&url.includes('archived=true')?{ok:true,json:async()=>({sessions:[{id:'archive',name:'Archived conversation',cwd:'/workspace/task/app',archived:true}]})}:undefined);
 h.$('#sessionBrowserArchived').checked=true;h.$('#sessionBrowserArchived').dispatchEvent(new h.window.Event('change',{bubbles:true}));await settle();
 assert.equal(h.$('[data-conversation-session]').dataset.conversationSession,'archive');
 assert(h.requests.some(r=>r.url.includes('archived=true')));
});

test('session organization events update the same browser without reopening another environment',async t=>{
 const h=await harness(t);await h.navigate('/sessions');
 const notify=(session,action,environment='local')=>h.window.dispatchEvent(new h.window.CustomEvent('workhub:session-managed',{detail:{session,action,environment}}));
 notify({...h.sessions[0],name:'Renamed',pinned:true},'rename');
 assert.match(h.$('[data-conversation-session="session-1"]').textContent,/Renamed/);
 notify({...h.sessions[0],name:'Wrong environment'},'rename','remote');
 assert.doesNotMatch(h.$('#sessionBrowserList').textContent,/Wrong environment/);
 notify({id:'fork',name:'Forked conversation',cwd:'/workspace/task/app'},'fork');
 assert.equal(h.currentSession().session,'fork');
 notify({id:'fork',name:'Forked conversation',cwd:'/workspace/task/app',archived:true},'archive');
 assert.equal(h.$('[data-conversation-session="fork"]'),null);
});

test('conversation filters default to all environments and expose optional filtering when needed', async t => {
  const h = await harness(t);
  await h.navigate('/sessions');
  assert(h.$('#sessionBrowserScopeBar').closest('.session-browser-list'));
  assert.equal(h.$('#sessionEnvironmentField').hidden, true);
  assert.equal(h.$('#sessionsEnvironment').value, '');
  h.environments.environments.push({id: 'wsl-test', name: 'Ubuntu'});
  await h.window.loadEnvironments(); await settle();
  assert.equal(h.$('#sessionEnvironmentField').hidden, false);
  assert.equal(h.$('#sessionsEnvironment').options.length, 3);
  h.environments.environments.pop();
  await h.window.loadEnvironments(); await settle();
  assert.equal(h.$('#sessionEnvironmentField').hidden, true);
});

test('conversation list omits shared context and retains active counts and refreshed titles', async t => {
  const h = await harness(t, false);
  let updated;
  h.window.WorkHubAssistant = {open() {}, close() {}, updateSession(session) {updated = session;}};
  h.sessions[0].chat_status = 'running';
  h.click('[data-action="task-conversations"]'); await settle();
  assert.match(h.$('#sessionBrowserContext').textContent, /任务 · Billing · 本机/);
  assert.match(h.$('#sessionBrowserCount').textContent, /1 个运行中/);
  assert.equal(h.$('[data-conversation-session="session-1"] .session-browser-item-context'), null);
  assert.equal(h.$('.session-browser-item-task'), null);
  assert.equal(h.$('.session-browser-item-directory'), null);
  assert(h.$('[data-session-menu="session-1"] [data-conversation-unlink]'));
  h.sessions[0].name = 'Codex generated title';
  h.click('[data-conversation-action="refresh"]'); await settle();
  assert.equal(updated.name, 'Codex generated title');
  assert.match(h.$('[data-conversation-session="session-1"]').textContent, /Codex generated title/);
});

test('fixed tasks persist and open only explicitly linked conversations', async t => {
  const h = await harness(t);
  h.sessions.push({id:'same-directory', name:'Not linked', cwd:'/workspace/task/app', updated_at:1999999999});
  h.sessions.push({id:'newer', name:'Newest linked', cwd:'/external', updated_at:1899999999});
  h.links.get('task').add('newer');
  assert.match(h.$('#shortcutPinnedTitle').textContent, /固定入口/);
  assert.equal(h.$('#shortcutRecentTitle'), null);
  assert.equal(h.$('[data-task-shortcut-pin="archived"]'), null);
  h.click('[data-task-shortcut-pin="task"]'); await settle();
  assert.deepEqual(JSON.parse(h.window.localStorage.getItem('workhub:pinned-tasks:v1:local')), ['task']);
  assert.match(h.$('[data-task-shortcut="task"]').textContent, /Billing.*App/);
  assert.equal(h.requests.some(r => r.url.endsWith('/manage')), false);
  h.window.eval('taskShortcutPins.clear(); renderConversationShortcuts()');
  assert(h.$('[data-task-shortcut="task"]'));
  h.click('[data-task-shortcut="task"]'); await settle();
  assert.equal(h.window.location.hash, '#/sessions');
  assert.equal(h.$('#sessionScopeLabel').textContent, '任务 · Billing');
  assert.equal(h.currentSession().session, 'newer');
  assert.equal(h.$('[data-conversation-session="same-directory"]'), null);
  assert.equal(h.$('[data-task-shortcut="task"]').getAttribute('aria-current'), 'true');
  h.click('[data-conversation-session="session-1"]'); await settle();
  await h.navigate('/projects');
  h.window.eval('conversationViews.clear()');
  h.click('[data-task-shortcut="task"]'); await settle();
  assert.equal(h.currentSession().session, 'session-1');
  h.change('#sessionDirectoryFilter', '/workspace/task/app'); await settle();
  h.input('#sessionBrowserSearch', 'no match');
  h.click('[data-task-shortcut="task"]'); await settle();
  assert.equal(h.$('#sessionDirectoryFilter').value, '');
  assert.equal(h.$('#sessionBrowserSearch').value, '');
  assert.equal(h.$('#sessionBrowserArchived').checked, false);
  h.$('.conversation-shortcut-row [data-task-shortcut-pin="task"]').focus();
  h.click('.conversation-shortcut-row [data-task-shortcut-pin="task"]'); await settle();
  assert.equal(h.$('[data-task-shortcut="task"]'), null);
  assert.deepEqual(JSON.parse(h.window.localStorage.getItem('workhub:pinned-tasks:v1:local')), []);
  assert.equal(h.document.activeElement, h.$('#taskShortcutPicker summary'));
  h.$('#taskShortcutPicker').open = true;
  h.$('#taskShortcutPicker summary').dispatchEvent(new h.window.KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));
  assert.equal(h.$('#taskShortcutPicker').open, false);
});

test('fixed tasks and directories survive a new origin without browser storage', async t => {
  const pins = {};
  const first = await harness(t, true, {origin:'http://localhost:50101', pins});
  first.click('[data-task-shortcut-pin="task"]');
  first.click('[data-directory-shortcut-pin="/workspace/task/app"]');
  await settle();
  assert.deepEqual(pins.local.tasks, ['task']);
  assert.deepEqual(pins.local.directories, ['/workspace/task/app']);
  const restarted = await harness(t, true, {origin:'http://localhost:50202', pins, storageUnavailable:true});
  assert(restarted.$('[data-task-shortcut="task"]'));
  assert(restarted.$('[data-directory-shortcut="/workspace/task/app"]'));
  restarted.click('.conversation-shortcut-row [data-task-shortcut-pin="task"]');
  restarted.click('.conversation-shortcut-row [data-directory-shortcut-pin="/workspace/task/app"]');
  await settle();
  const again = await harness(t, true, {origin:'http://localhost:50303', pins});
  assert.equal(again.$('[data-task-shortcut="task"]'), null);
  assert.equal(again.$('[data-directory-shortcut="/workspace/task/app"]'), null);
  for (const h of [first, restarted, again]) assert(h.requests.filter(r => r.url.startsWith('/api/shortcut-pins?')).every(r => r.options.headers['X-Environment-ID'] === 'local'));
});

test('legacy pins migrate once and stale browser storage cannot resurrect removed entries', async t => {
  const pins = {};
  const storage = {'workhub:pinned-tasks:v1:local':'["task"]', 'workhub:pinned-directories:v1:local':'["/workspace/task/app"]'};
  const migrated = await harness(t, true, {pins, storage});
  assert(migrated.$('[data-task-shortcut="task"]'));
  assert(migrated.$('[data-directory-shortcut="/workspace/task/app"]'));
  migrated.click('.conversation-shortcut-row [data-task-shortcut-pin="task"]');
  migrated.click('.conversation-shortcut-row [data-directory-shortcut-pin="/workspace/task/app"]');
  await settle();
  const stale = await harness(t, true, {pins, storage});
  assert.equal(stale.$('[data-task-shortcut="task"]'), null);
  assert.equal(stale.$('[data-directory-shortcut="/workspace/task/app"]'), null);
  assert.equal(stale.requests.filter(r => r.url.startsWith('/api/shortcut-pins?') && r.body?.initialize).length, 0);
});

test('pin changes wait for loading, serialize rapid clicks and roll back failed saves', async t => {
  const pins = {local:{tasks:[], directories:[], initialized:true}};
  let releaseLoad;
  const h = await harness(t, true, {pins, intercept:(url, options) => url.startsWith('/api/shortcut-pins?') && !options.method ? new Promise(resolve => {releaseLoad = resolve;}) : undefined});
  h.click('[data-task-shortcut-pin="task"]');
  assert.equal(h.requests.some(r => r.url.startsWith('/api/shortcut-pins?') && r.options.method === 'PUT'), false);
  releaseLoad({ok:true, json:async () => pins.local});
  await settle();
  assert.deepEqual(pins.local.tasks, ['task']);
  h.setIntercept(undefined);
  let releaseSave;
  h.setIntercept((url, options) => url.startsWith('/api/shortcut-pins?') && options.method === 'PUT' && !releaseSave ? new Promise(resolve => {releaseSave = () => {pins.local = {...JSON.parse(options.body), initialized:true}; resolve({ok:true, json:async () => structuredClone(pins.local)});};}) : undefined);
  h.click('[data-directory-shortcut-pin="/repo/app"]');
  await settle();
  h.click('.conversation-shortcut-row [data-task-shortcut-pin="task"]');
  await settle();
  assert.deepEqual(pins.local.tasks, ['task']);
  releaseSave(); await settle();
  assert.deepEqual(pins.local.tasks, []);
  assert.deepEqual(pins.local.directories, ['/repo/app']);
  h.setIntercept((url, options) => url.startsWith('/api/shortcut-pins?') && options.method === 'PUT' ? {ok:false, json:async () => ({error:'disk full'})} : undefined);
  h.click('.conversation-shortcut-row [data-directory-shortcut-pin="/repo/app"]');
  assert.equal(h.$('[data-directory-shortcut="/repo/app"]'), null);
  await settle();
  assert(h.$('[data-directory-shortcut="/repo/app"]'));
  assert.match(h.$('#toastMessage').textContent, /保存固定入口失败.*disk full/);
});

test('shortcut picker searches the complete task list and preserves focus and pin state across refreshes', async t => {
  const h = await harness(t);
  h.data.requirements.push({...h.data.requirements[0], id:'second', name:'Second task'});
  await h.window.refresh(true); await settle();
  h.$('#taskShortcutPicker').open = true; await settle();
  h.click('#taskShortcutPicker [data-task-shortcut-pin="task"]'); await settle();
  assert.equal(h.$('#taskShortcutPicker').open, true);
  assert.equal(h.$('#taskShortcutPicker [data-task-shortcut-pin="task"]').getAttribute('aria-pressed'), 'true');
  assert.match(h.$('.shortcut-picker-caption').textContent, /2 个未归档任务 · 已固定 1 个/);
  h.$('#shortcutSearch').focus();
  h.input('#shortcutSearch', 'Second');
  h.$('#shortcutSearch').setSelectionRange(2, 4);
  h.data.requirements.find(task => task.id === 'second').name = 'Second updated';
  await h.window.refresh(true); await settle();
  assert.equal(h.document.activeElement.id, 'shortcutSearch');
  assert.equal(h.$('#shortcutSearch').value, 'Second');
  assert.equal(h.$('#shortcutSearch').selectionStart, 2);
  assert.equal(h.$('#shortcutSearch').selectionEnd, 4);
  assert.equal(h.$('#taskShortcutPicker [data-task-shortcut-pin="task"]'), null);
  assert(h.$('#taskShortcutPicker [data-task-shortcut-pin="second"]'));
  h.input('#shortcutSearch', 'App');
  assert.equal(h.document.querySelectorAll('#taskShortcutPicker [data-task-shortcut-pin]').length, 2);
  h.input('#shortcutSearch', 'Archived');
  assert.equal(h.$('[data-task-shortcut-pin="archived"]'), null);
  h.$('#shortcutArchived').checked = true;
  h.$('#shortcutArchived').dispatchEvent(new h.window.Event('change', {bubbles:true}));
  assert(h.$('[data-task-shortcut-pin="archived"]').disabled);
  h.input('#shortcutSearch', 'Billing');
  h.click('#taskShortcutPicker [data-task-shortcut-pin="task"]');
  assert.equal(h.$('#taskShortcutPicker [data-task-shortcut-pin="task"]').getAttribute('aria-pressed'), 'false');
  assert.equal(h.$('[data-task-shortcut="task"]'), null);
  await settle();
});

test('fixed directories persist by environment and open exact directory conversations without task ownership', async t => {
  const h = await harness(t, false);
  h.sessions.push({id:'not-linked',name:'Same directory, separate conversation',cwd:'/workspace/task/app'}, {id:'child',name:'Nested',cwd:'/workspace/task/app/src'});
  await h.navigate('/sessions');
  h.click('[data-directory-shortcut-pin="/workspace/task/app"]');
  assert.deepEqual(JSON.parse(h.window.localStorage.getItem('workhub:pinned-directories:v1:local')), ['/workspace/task/app']);
  h.window.eval('directoryShortcutPins.clear(); renderConversationShortcuts()');
  h.click('[data-directory-shortcut="/workspace/task/app"]'); await settle();
  assert.equal(h.$('#sessionScopeLabel').textContent, '目录 · /workspace/task/app');
  assert.equal(h.$('[data-directory-shortcut="/workspace/task/app"]').getAttribute('aria-current'), 'true');
  assert.deepEqual([...h.document.querySelectorAll('[data-conversation-session]')].map(button => button.dataset.conversationSession).sort(), ['not-linked','session-1']);
  assert.equal(h.$('#taskConversationTools').hidden, true);
  assert.equal(h.$('#pinConversationDirectory').getAttribute('aria-pressed'), 'true');
  assert.equal(h.$('#newBrowserSession').disabled, false);
  h.click('#newBrowserSession'); await settle();
  assert.equal(h.currentSession().target.cwd, '/workspace/task/app');
  assert.equal(h.currentSession().target.task_id, undefined);
  assert.equal(h.requests.some(request => request.options.method === 'POST'), false);
  await h.window.selectEnvironment('wsl-test', '/projects'); await settle();
  assert(h.$('[data-directory-shortcut="/workspace/task/app"]'));
  assert.equal(h.window.localStorage.getItem('workhub:pinned-directories:v1:wsl-test'), null);
  await h.window.selectEnvironment('local', '/sessions'); await settle();
  assert(h.$('[data-directory-shortcut="/workspace/task/app"]'));
  h.click('[data-directory-shortcut="/workspace/task/app"]'); await settle();
  h.click('#pinConversationDirectory');
  assert.equal(h.$('[data-directory-shortcut="/workspace/task/app"]'), null);
  assert.deepEqual(JSON.parse(h.window.localStorage.getItem('workhub:pinned-directories:v1:local')), []);
  await settle();
});

test('directory pinning is available from known directory filters and keeps same-name paths distinct', async t => {
  const h = await harness(t);
  await h.navigate('/sessions');
  h.change('#sessionDirectoryFilter', '/repo/app'); await settle();
  assert.equal(h.$('#pinConversationDirectory').hidden, false);
  h.click('#pinConversationDirectory');
  h.click('[data-directory-shortcut-pin="/workspace/task/app"]');
  assert.equal(h.document.querySelectorAll('[data-directory-shortcut]').length, 2);
  assert.match(h.$('[data-directory-shortcut="/repo/app"]').textContent, /app.*\/repo/);
  assert.match(h.$('[data-directory-shortcut="/workspace/task/app"]').textContent, /app.*\/workspace\/task/);
  h.sessions.push({id:'external',name:'External',cwd:'/outside'});
  h.click('[data-conversation-action="all"]'); await settle();
  h.$('#sessionScopePicker').open = true; await settle();
  h.input('#sessionScopeSearch', '/outside');
  h.click('[data-conversation-scope]'); await settle();
  assert.equal(h.$('#pinConversationDirectory').hidden, true);
  assert.equal(h.$('#newBrowserSession').disabled, true);
});

test('fixed tasks switch between task conversations and recover when a saved session is unlinked', async t => {
  const h = await harness(t);
  h.data.requirements.push({...h.data.requirements[0], id:'second', name:'Second task'});
  h.sessions.push({id:'second-session', name:'Second conversation', cwd:'/external', updated_at:1});
  h.links.set('second', new Set(['second-session']));
  await h.window.refresh(true); await settle();
  h.click('[data-task-shortcut-pin="task"]');
  h.click('[data-task-shortcut-pin="second"]');
  h.click('[data-task-shortcut="task"]'); await settle();
  assert.equal(h.currentSession().session, 'session-1');
  h.click('[data-task-shortcut="second"]'); await settle();
  assert.equal(h.currentSession().session, 'second-session');
  h.click('[data-task-shortcut="task"]'); await settle();
  assert.equal(h.currentSession().session, 'session-1');
  h.links.get('task').clear();
  h.click('[data-task-shortcut="task"]'); await settle();
  assert.equal(h.$('#sessionBrowserEmpty').hidden, false);
  assert.match(h.$('#sessionBrowserEmpty').textContent, /这里还没有对话/);
  assert.equal(h.$('#taskConversationTools').hidden, false);
});

test('fixed tasks remain global, retain per-environment storage and hide archived or removed tasks', async t => {
  const h = await harness(t);
  h.click('[data-task-shortcut-pin="task"]');
  await h.window.selectEnvironment('wsl-test', '/projects'); await settle();
  assert(h.$('[data-task-shortcut="task"]'));
  assert(h.$('[data-task-shortcut-pin="task"]'));
  assert.equal(h.window.localStorage.getItem('workhub:pinned-tasks:v1:wsl-test'), null);
  await h.window.selectEnvironment('local', '/projects'); await settle();
  assert(h.$('[data-task-shortcut="task"]'));
  h.data.requirements[0].name = 'Renamed task';
  await h.window.refresh(true); await settle();
  assert.match(h.$('[data-task-shortcut="task"]').textContent, /Renamed task/);
  h.data.requirements[0].state = 'archived';
  await h.window.refresh(true); await settle();
  assert.equal(h.$('[data-task-shortcut="task"]'), null);
  h.data.requirements[0].state = 'ready';
  await h.window.refresh(true); await settle();
  assert(h.$('[data-task-shortcut="task"]'));
  h.data.requirements.shift();
  await h.window.refresh(true); await settle();
  assert.equal(h.$('[data-task-shortcut="task"]'), null);
});

test('compact conversation filters expose active choices, clear together and settings live beside refresh', async t => {
  const h = await harness(t);
  await h.navigate('/sessions');
  assert.equal(h.$('.sidebar-guide'), null);
  assert.equal(h.$('.sidebar nav [data-view="settings"]'), null);
  assert(h.$('.sidebar-footer-actions #refreshControl + [data-view="settings"]'));
  assert(h.$('#sessionScopeAll').closest('#sessionScopePicker'));
  assert(h.$('#sessionDirectoryField').closest('#sessionFilterPicker'));
  assert.equal(h.$('#sessionDirectoryField').hidden, false);
  assert(h.$('#sessionBrowserArchived').closest('#sessionFilterPicker'));
  h.change('#sessionDirectoryFilter', '/workspace/task/app'); await settle();
  h.click('#sessionBrowserArchived'); await settle();
  assert.equal(h.$('#sessionFilterCount').textContent, '2');
  assert.equal(h.$('#sessionFilterCount').hidden, false);
  assert.match(h.$('#sessionActiveFilterLabel').textContent, /app.*已归档/);
  h.click('#sessionClearFilters'); await settle();
  assert.equal(h.$('#sessionDirectoryFilter').value, '');
  assert.equal(h.$('#sessionBrowserArchived').checked, false);
  assert.equal(h.$('#sessionFilterCount').hidden, true);
  h.$('#sessionFilterPicker').open = true;
  h.$('#sessionFilterPicker summary').dispatchEvent(new h.window.KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));
  assert.equal(h.$('#sessionFilterPicker').open, false);
  const settingsChanged = new Promise(resolve => h.window.addEventListener('hashchange', resolve, {once:true}));
  h.click('.sidebar-settings'); await settingsChanged; await settle();
  assert.equal(h.window.location.hash, '#/settings');
  assert.equal(h.$('#settingsPage').hidden, false);
});

test('a late global shortcut response cannot replace a fresh list after switching environments and back', async t => {
  const h = await harness(t);
  let release;
  h.setIntercept(url => /^\/api\/sessions\?(?:refresh=1)?$/.test(url) ? new Promise(resolve => {release = resolve;}) : undefined);
  const pending = h.window.refreshConversationShortcuts(true); await settle();
  h.setIntercept((url, options) => /^\/api\/sessions\?(?:refresh=1)?$/.test(url) ? {ok:true, json:async()=>({sessions:[{id:'session-1', name:options.headers['X-Environment-ID'] === 'wsl-test' ? 'Remote' : 'Fresh local', cwd:'/repo/app', pinned:true}]})} : undefined);
  await h.window.selectEnvironment('wsl-test', '/projects'); await settle();
  await h.window.selectEnvironment('local', '/projects'); await settle();
  assert.match(h.window.eval('conversationItems()[0].name'), /Fresh local/);
  release({ok:true, json:async()=>({sessions:[{id:'session-1', name:'Stale local', cwd:'/repo/app', pinned:true}]})});
  await pending; await settle();
  assert.match(h.window.eval('conversationItems()[0].name'), /Fresh local/);
  assert.doesNotMatch(h.window.eval('conversationItems()[0].name'), /Stale local/);
});

test('project filters retain selection, distinguish directory changes and recover from empty results', async t => {
  const h = await harness(t);
  h.data.projects[0].worktrees[1].dirty = 3;
  h.data.projects[1].error = 'Repository unavailable';
  await h.navigate('/projects');
  assert.equal(h.document.querySelectorAll('.project-list-item').length, 2);
  assert.equal(h.$('.project-list-item [data-action]'), null);
  assert.equal(h.$('.page-heading').hidden, true);
  assert.equal(h.$('#stats').hidden, true);
  assert(h.$('#panelToolbar [data-action="new-project"]'));
  h.click('[data-action="project-filter"][data-filter="dirty"]');
  assert.equal(h.document.querySelectorAll('.project-list-item').length, 1);
  assert.equal(h.$('.project-list-item').dataset.id, 'app');
  assert.match(h.$('#projectDetail').textContent, /3 项改动/);
  h.click('[data-action="select-project"][data-id="app"]');
  assert.equal(h.$('.project-workspace').dataset.pane, 'detail');
  h.click('[data-action="select-project"][data-id="app"]');
  assert.equal(h.$('#projectDetail h2').textContent, 'App');
  h.click('[data-action="project-list"]');
  assert.equal(h.$('.project-workspace').dataset.pane, 'list');
  assert.equal(h.document.activeElement, h.$('.project-list-item'));
  h.click('[data-action="project-filter"][data-filter="error"]');
  assert.equal(h.$('.project-list-item').dataset.id, 'backend');
  assert.match(h.$('#projectDetail').textContent, /Repository unavailable/);
  assert.equal(h.$('[data-action="new-worktree"]').disabled, true);
  h.input('#search', 'no match');
  assert.match(h.$('.project-list-empty').textContent, /没有匹配的项目/);
  h.click('.project-list-empty [data-action="project-filter"]');
  assert.equal(h.$('[data-filter="all"]').getAttribute('aria-pressed'), 'true');
  h.input('#search', '');
  assert.equal(h.document.querySelectorAll('.project-list-item').length, 2);
});

test('project directory controls retain the exact worktree and compact zero-value Git details', async t => {
  const h = await harness(t);
  const tree = h.data.projects[0].worktrees[1];
  Object.assign(tree, { upstream: 'origin/feature/task', sync_available: true, sync_ahead: 0, sync_behind: 0, compare_available: true, comparison_ref: 'main', ahead: 0, behind: 0 });
  await h.navigate('/projects');
  const row = h.$('[data-action="git-open"][data-path="/workspace/task/app"]').closest('tr');
  assert.match(row.querySelector('.comparison').textContent, /已同步/);
  assert.doesNotMatch(row.querySelector('.comparison').textContent, /待推 0|待拉 0/);
  assert.equal(row.querySelector('.project-row-details').open, false);
  assert.match(row.querySelector('.project-row-details').textContent, /与基线一致/);
  h.click('[data-action="git-open"][data-path="/workspace/task/app"]'); await settle();
  assert.equal(h.$('#gitWorktree').value, '/workspace/task/app');
  h.$('#gitDialog').close();
  h.click('[data-project-open-primary][data-path="/workspace/task/app"]'); await settle();
  assert.deepEqual(h.requests.filter(r => r.url === '/api/projects/app/open').at(-1).body, { tool: 'vscode', path: '/workspace/task/app' });
});

test('project directories identify their task, separate local and remote state and recover the selected task in place', async t => {
  const h = await harness(t);
  const tree = h.data.projects[0].worktrees[1];
  Object.assign(tree, {requirements:[{id:'task',name:'Billing'}], missing:true, upstream:'origin/feature/task', sync_available:true});
  await h.navigate('/projects');
  const rows = h.document.querySelectorAll('[data-directory-path]');
  assert.equal(rows[0].querySelector('.project-directory-name').textContent, '主工作目录');
  assert.equal(rows[1].querySelector('.project-directory-name').textContent, 'Billing');
  assert.deepEqual([...h.document.querySelectorAll('#projectDetail th')].map(n => n.textContent), ['工作目录','远程同步','关联任务','本地改动','操作']);
  assert.doesNotMatch(rows[1].querySelector('.project-branch-cell').textContent, /已同步/);
  h.click('.project-directory-filters [data-filter="issues"]');
  assert.equal(h.document.querySelectorAll('[data-directory-path]').length, 1);
  h.click('.project-directory-recovery [data-action="change-task-directory"]'); await settle();
  assert.equal(h.$('#taskDirectoryDialog').open, true);
  assert.match(h.$('#taskDirectoryCurrent').textContent, /App.*\/workspace\/task\/app/);
  h.change('#taskDirectoryPicker-app-mode', 'project');
  await h.submit('#taskDirectoryForm');
  assert.deepEqual(h.requests.find(r => r.url === '/api/requirements/task/projects/app' && r.options.method === 'PUT').body, {project_id:'app',mode:'project'});
  assert.equal(h.data.requirements[0].members[0].path, '/repo/app');
  assert.equal(tree.missing, true);
  assert(!h.requests.some(r => r.options.method === 'DELETE'));
});

test('project recovery explains archived and unassociated directories and retains a per-project issue filter', async t => {
  const h = await harness(t);
  const tree = h.data.projects[0].worktrees[1];
  Object.assign(tree, {requirements:[{id:'archived',name:'Archived'}], missing:true});
  await h.navigate('/projects');
  assert.equal(h.$('.project-directory-recovery [data-action="change-task-directory"]').disabled, true);
  assert.match(h.$('.project-directory-recovery').textContent, /取消归档后可更换目录/);
  tree.requirements = [];
  await h.window.refresh();
  assert.equal(h.$('.project-directory-recovery [data-action="change-task-directory"]'), null);
  assert(h.$('.project-directory-recovery [data-action="new-worktree"]'));
  h.click('.project-directory-filters [data-filter="issues"]');
  h.click('[data-action="select-project"][data-id="backend"]');
  assert.equal(h.$('.project-directory-filters [data-filter="all"]').getAttribute('aria-pressed'), 'true');
  h.click('[data-action="select-project"][data-id="app"]');
  assert.equal(h.$('.project-directory-filters [data-filter="issues"]').getAttribute('aria-pressed'), 'true');
  tree.missing = false;
  await h.window.refresh();
  assert.match(h.$('#projectDetail').textContent, /没有需要处理的工作目录/);
  h.click('.project-detail-empty [data-action="project-directory-filter"]');
  assert.equal(h.document.querySelectorAll('[data-directory-path]').length, 2);
});

test('a shared directory recovery only changes the task selected beside its error', async t => {
  const h = await harness(t);
  const original = h.data.requirements[0];
  const second = {...original, id:'second', name:'Second task', members:original.members.map(m => ({...m}))};
  h.data.requirements.push(second);
  Object.assign(h.data.projects[0].worktrees[1], {missing:true, requirements:[{id:'task',name:'Billing'},{id:'second',name:'Second task'}]});
  h.setIntercept((url, options, body) => {
    if (url === '/api/requirements/second/projects/app' && options.method === 'PUT') {
      Object.assign(second.members[0], {mode:body.mode,path:'/repo/app',worktree:h.data.projects[0].worktrees[0]});
      return {ok:true,json:async()=>structuredClone(second)};
    }
  });
  await h.navigate('/projects');
  h.click('.project-task-recovery [data-action="change-task-directory"][data-id="second"]'); await settle();
  h.change('#taskDirectoryPicker-app-mode', 'project');
  await h.submit('#taskDirectoryForm');
  assert.equal(original.members[0].path, '/workspace/task/app');
  assert.equal(second.members[0].path, '/repo/app');
  assert(h.requests.some(r => r.url === '/api/requirements/second/projects/app' && r.options.method === 'PUT'));
  assert(!h.requests.some(r => r.url === '/api/requirements/task/projects/app' && r.options.method === 'PUT'));
});

test('returning from a task through browser history restores list filters, scroll and the original task focus', async t => {
  const h = await harness(t);
  h.data.projects[0].worktrees[1].dirty = 2;
  await h.navigate('/requirements');
  h.input('#search', 'Billing');
  h.change('#taskStatusFilter', 'dirty');
  h.click('#archiveFilter');
  h.$('main').scrollTop = 260;
  h.click('[data-action="open-requirement"][data-id="task"]'); await settle();
  assert(h.$('.task-project-list'));
  const back = new Promise(resolve => h.window.addEventListener('popstate', resolve, {once:true}));
  h.window.history.back(); await back; await settle();
  assert.equal(h.$('#search').value, 'Billing');
  assert.equal(h.$('#taskStatusFilter').value, 'dirty');
  assert.equal(h.$('#archiveFilter').checked, true);
  assert.equal(h.$('main').scrollTop, 260);
  assert.equal(h.document.activeElement.dataset.id, 'task');
  assert.equal(h.document.activeElement.dataset.environment, 'local');
  await h.window.refresh(true);
  assert.equal(h.$('main').scrollTop, 260);
  await h.navigate('/projects');
  h.input('#search', 'Backend');
  await h.navigate('/requirements');
  assert.equal(h.$('#search').value, 'Billing');
  assert.equal(h.$('main').scrollTop, 260);
});

test('empty search states offer a direct reset without confusing an empty project with a pending scan', async t => {
  const h = await harness(t);
  await h.navigate('/requirements');
  h.input('#search', 'not-found');
  h.click('[data-action="clear-task-filters"]');
  assert.equal(h.$('#search').value, '');
  assert.equal(h.$('#taskStatusFilter').value, 'all');
  assert.equal(h.document.activeElement, h.$('#search'));
  await h.navigate('/projects');
  h.input('#search', 'not-found');
  h.click('[data-action="clear-project-search"]');
  assert.equal(h.$('#search').value, '');
  assert.equal(h.document.querySelectorAll('.project-list-item').length, 2);
  h.data.projects[0].worktrees = [];
  h.data.projects[0].refreshing = false;
  await h.window.refresh();
  assert.match(h.$('.project-detail-empty').textContent, /尚未发现工作目录/);
  assert(h.$('.project-detail-empty [data-action="project-refresh"]'));
  h.data.projects[0].refreshing = true;
  h.data.projects[0].status_updated_at = '';
  await h.window.refresh();
  assert.match(h.$('.project-detail-empty').textContent, /正在发现工作目录/);
});

test('sidebar refresh status stays compact and retains its detailed explanation', async t => {
  const h = await harness(t);
  h.data.status_refreshing = true;
  await h.window.refresh();
  assert.equal(h.$('#syncText').textContent, '更新中…');
  assert.match(h.$('#syncText').title, /当前显示最近结果/);
  assert.equal(h.$('#syncDot').classList.contains('updating'), true);
  h.data.status_refreshing = false;
  await h.window.refresh();
  assert.equal(h.$('#syncText').textContent, '已更新');
  assert.equal(h.$('#syncDot').classList.contains('updating'), false);
});

test('project panes resize with pointer and keyboard, retain their width and respect narrow layouts', async t => {
  const h = await harness(t);
  h.data.projects[0].worktrees[1].dirty = 3;
  await h.navigate('/projects');
  const originalBounds = h.window.HTMLElement.prototype.getBoundingClientRect;
  h.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('project-workspace')) return { width: 1000 };
    if (this.id === 'projectListPane') return { width: parseFloat(h.$('#content').style.getPropertyValue('--project-list-width')) || 248 };
    return originalBounds.call(this);
  };
  assert.equal(h.$('.project-list-item .lucide-chevron-right'), null);
  assert.equal(h.$('.project-change-indicator').textContent, '1 个目录有改动');
  assert.match(h.$('.project-change-indicator').title, /1 个工作目录/);
  const pointer = (target, type, clientX) => {
    const event = new h.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 7 });
    target.dispatchEvent(event);
  };
  pointer(h.$('[data-project-resize]'), 'pointerdown', 248);
  pointer(h.document, 'pointermove', 350);
  assert.equal(h.$('#content').style.getPropertyValue('--project-list-width'), '350px');
  h.window.render(); // A real data change can replace the markup while dragging.
  pointer(h.document, 'pointermove', 390);
  pointer(h.document, 'pointerup', 390);
  assert.equal(h.$('#content').style.getPropertyValue('--project-list-width'), '390px');
  assert.equal(h.window.localStorage.getItem('workhub:project-list-width:v1'), '390');
  assert.equal(h.$('.project-workspace').hasAttribute('data-resizing'), false);
  const key = (key, shiftKey = false) => h.$('[data-project-resize]').dispatchEvent(new h.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  key('ArrowRight');
  assert.equal(h.$('[data-project-resize]').getAttribute('aria-valuenow'), '400');
  key('ArrowLeft', true);
  assert.equal(h.$('#content').style.getPropertyValue('--project-list-width'), '360px');
  key('Home');
  assert.equal(h.$('#content').style.getPropertyValue('--project-list-width'), '200px');
  key('End');
  assert.equal(h.$('#content').style.getPropertyValue('--project-list-width'), '632px');
  await h.navigate('/requirements');
  await h.navigate('/projects');
  assert.equal(h.$('[data-project-resize]').getAttribute('aria-valuenow'), '632');
  Object.defineProperty(h.window, 'innerWidth', { value: 800, configurable: true });
  h.window.dispatchEvent(new h.window.Event('resize'));
  key('Home');
  assert.equal(h.window.localStorage.getItem('workhub:project-list-width:v1'), '632');
  assert.equal(h.requests.filter(r => r.url.endsWith('/open')).length, 0);
});

test('task goals save independently and the edit draft survives a polling refresh', async t => {
  const h = await harness(t);
  h.click('.task-info [data-action="edit-task"]');
  h.input('#taskEditName', 'Order approval'); h.input('#taskEditDescription', 'Complete the cross-project workflow.');
  await h.window.refresh();
  assert.equal(h.$('#taskEditName').value, 'Order approval');
  assert.equal(h.$('#taskEditDescription').value, 'Complete the cross-project workflow.');
  await h.submit('#taskEditForm');
  const request = h.requests.find(r => r.url === '/api/requirements/task' && r.options.method === 'PATCH');
  assert.deepEqual(request.body, {name:'Order approval', description:'Complete the cross-project workflow.'});
  assert.equal(h.$('#taskEditDialog').open, false);
  assert.equal(h.$('#pageTitle').textContent, 'Order approval');
  assert.equal(h.$('.task-project-path').textContent, '/workspace/task/app');
});

test('a partially prepared task keeps ready project controls and creation directories usable', async t => {
  const h = await harness(t, false);
  h.data.requirements[0].state = 'partial';
  h.data.requirements[0].has_workspace = false;
  h.data.requirements[0].members.push({project_id:'backend',project_name:'Backend',mode:'new',path:'/workspace/task/backend',state:'failed',error:'fixture failure'});
  await h.window.refresh();
  assert.equal(h.$('[data-action="git-open"][data-id="app"]').disabled, false);
  assert.equal(h.$('[data-action="workspace-terminal"][data-id="app"]').disabled, false);
  assert.equal(h.$('[data-action="retry"]').dataset.project, 'backend');
  h.click('[data-action="task-conversations"]'); await settle(); h.click('#newBrowserSession');
  assert.equal(h.currentSession().target.cwd, '/workspace/task/app');
  assert.deepEqual(Array.from(h.currentSession().target.additional_directories), []);
  assert.equal(h.$('#sessionBrowserAdditionalField').hidden, true);
});

test('changing and detaching a task project use the selected project and retain explicit conversation references', async t => {
  const h = await harness(t);
  h.click('[data-action="change-task-directory"][data-project="app"]'); await settle();
  assert.match(h.$('#taskDirectoryCurrent').textContent, /\/workspace\/task\/app/);
  h.change('#taskDirectoryPicker-app-mode', 'project');
  assert.match(h.$('#taskDirectoryPreview').textContent, /\/repo\/app/);
  await h.submit('#taskDirectoryForm');
  assert.equal(h.$('#taskDirectoryDialog').open, false);
  assert.equal(h.$('.task-project-path').textContent, '/repo/app');
  h.click('[data-action="task-conversations"]'); await settle();
  assert(h.$('[data-conversation-session="session-1"]'));
  h.click('[data-conversation-action="close"]');
  h.click('[data-action="remove-task-project"][data-project="app"]'); await settle();
  assert.equal(h.data.requirements[0].members.length, 0);
  assert.match(h.$('#content').textContent, /尚未关联项目/);
  assert(h.requests.some(r => r.url === '/api/requirements/task/projects/app' && r.options.method === 'DELETE'));
  assert(h.links.get('task').has('session-1'));
});

test('task conversations exclude directory-only matches until linked and unlinking preserves the global session', async t => {
  const h = await harness(t);
  h.sessions.push({id:'directory-only',name:'Another task in the same directory',cwd:'/workspace/task/app'});
  h.click('[data-action="task-conversations"]'); await settle();
  assert.equal(h.$('[data-conversation-session="directory-only"]'), null);
  h.click('#linkTaskConversation'); await settle();
  const link = [...h.document.querySelectorAll('[data-session-action="link"]')].find(b => b.dataset.session === 'directory-only');
  link.click(); await settle();
  assert(h.$('[data-conversation-session="directory-only"]'));
  h.click('[data-conversation-unlink="directory-only"]'); await settle();
  assert.equal(h.$('[data-conversation-session="directory-only"]'), null);
  assert(h.sessions.some(s => s.id === 'directory-only'));
  assert(!h.requests.some(r => r.url.endsWith('/chat/stop')));
});

test('new conversation access includes only the additional projects explicitly selected', async t => {
  const h = await harness(t, false);
  h.data.requirements[0].members.push({project_id:'backend',project_name:'Backend',mode:'project',path:'/repo/backend',state:'ready',worktree:h.data.projects[1].worktrees[0]});
  await h.window.refresh();
  h.click('[data-action="task-conversations"]'); await settle(); h.click('#newBrowserSession');
  h.change('#sessionBrowserNewDirectory', '/workspace/task/app');
  assert.equal(h.$('#sessionBrowserAdditionalField').hidden, false);
  assert.deepEqual(Array.from(h.currentSession().target.additional_directories), ['/repo/backend']);
  h.click('[data-additional-directory="/repo/backend"]');
  assert.deepEqual(Array.from(h.currentSession().target.additional_directories), []);
  assert.equal(h.document.querySelectorAll('[data-additional-directory="/workspace/task"]').length, 0);
});

test('creating from the task list opens the saved task without a transient not-found page', async t => {
  const h = await harness(t);
  await h.navigate('/requirements');
  const renders = [];
  const render = h.window.render;
  h.window.render = () => { render(); renders.push(h.$('#content').textContent); };
  h.window.openRequirement(); await settle();
  h.input('#requirementName', 'Reuse a checkout');
  h.click('#projectPicker-app-selected');
  h.change('#projectPicker-app-mode', 'project');
  await h.submit('#requirementForm'); await settle();
  assert.equal(h.$('#pageTitle').textContent, 'Reuse a checkout');
  assert(!renders.some(text => text.includes('这个任务不存在')));
});


test('all conversations include environment tags and duplicate IDs open in their own environment without switching', async t => {
  const h = await harness(t, false);
  h.environments.environments.push({id: 'remote', name: 'WSL · Ubuntu'});
  await h.window.loadEnvironments();
  h.setIntercept((url, options) => {
    if (url.startsWith('/api/sessions?') && options.headers['X-Environment-ID'] === 'remote') return {ok: true, json: async () => ({sessions: [{...h.sessions[0], name: 'WSL review'}]})};
  });
  await h.navigate('/sessions');
  const entries = [...h.document.querySelectorAll('[data-conversation-session]')];
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].dataset.conversationSession, entries[1].dataset.conversationSession);
  assert.match(h.$('[data-conversation-session][data-environment="local"]').textContent, /本机/);
  assert.match(h.$('[data-conversation-session][data-environment="remote"]').textContent, /WSL · Ubuntu/);
  h.click('[data-conversation-session][data-environment="remote"]'); await settle();
  assert.equal(h.currentSession().environment, 'remote');
  assert.equal(h.currentSession().session, 'session-1');
  assert.equal(h.$('#projectEnvironment').value, 'local');
  assert.equal(h.window.location.search, '');
  assert(h.requests.some(r => r.url.endsWith('/history') && r.options.headers['X-Environment-ID'] === 'remote'));
  h.input('#sessionChatInput', 'continue remotely'); await h.submit('#sessionChatForm');
  assert(h.requests.some(r => r.url.endsWith('/chat') && r.options.method === 'POST' && r.options.headers['X-Environment-ID'] === 'remote'));
  h.change('#sessionsEnvironment', 'remote'); await settle();
  assert.equal(h.document.querySelectorAll('[data-conversation-session]').length, 1);
  assert.equal(h.$('[data-conversation-session]').dataset.environment, 'remote');
  assert.equal(h.$('#projectEnvironment').value, 'local');
  h.click('[data-conversation-action="clear-filters"]'); await settle();
  assert.equal(h.$('#sessionsEnvironment').value, '');
  assert.equal(h.document.querySelectorAll('[data-conversation-session]').length, 2);
});

test('environment filtering rejects late results and a failed environment retains successful results', async t => {
  const h = await harness(t);
  h.environments.environments.push({id: 'remote', name: 'WSL'});
  await h.window.loadEnvironments();
  const pending = [];
  h.setIntercept((url, options) => {
    if (url.startsWith('/api/sessions?') && options.headers['X-Environment-ID'] === 'remote') return new Promise(resolve => pending.push(resolve));
  });
  await h.navigate('/sessions');
  assert(h.$('[data-conversation-session][data-environment="local"]'));
  h.change('#sessionsEnvironment', 'local'); await settle();
  for (const resolve of pending) resolve({ok: true, json: async () => ({sessions: [{id: 'late', name: 'Late remote', cwd: '/remote'}]})});
  await settle();
  assert.doesNotMatch(h.$('#sessionBrowserList').textContent, /Late remote/);
  h.setIntercept((url, options) => url.startsWith('/api/sessions?') && options.headers['X-Environment-ID'] === 'remote' ? {ok: false, json: async () => ({error: 'offline fixture'})} : undefined);
  h.change('#sessionsEnvironment', ''); await settle();
  assert(h.$('[data-conversation-session][data-environment="local"]'));
  assert.match(h.$('#sessionBrowserError').textContent, /WSL.*offline fixture/);
  h.setIntercept(null); h.click('[data-conversation-action="refresh"]'); await settle();
  assert.equal(h.$('#sessionBrowserError').hidden, true);
});

test('cross-environment scopes, task shortcuts and creation targets preserve ownership without changing project environment', async t => {
  const h = await harness(t, false);
  h.environments.environments.push({id: 'remote', name: 'WSL'});
  const remoteTask = {...structuredClone(h.data.requirements[0]), id: 'remote-task', name: 'Remote task', environment_id: 'remote', environment_name: 'WSL'};
  const remoteData = {...h.data, requirements: [remoteTask]};
  h.setIntercept((url, options) => {
    if (url.startsWith('/api/task-inventory')) return {ok: true, json: async () => ({requirements: [...h.data.requirements.map(q => ({...q, environment_id: 'local'})), remoteTask], environments: h.environments.environments, project_count: 4})};
    if (url === '/api/state' && options.headers['X-Environment-ID'] === 'remote') return {ok: true, json: async () => remoteData};
    if (url.startsWith('/api/sessions?') && options.headers['X-Environment-ID'] === 'remote') return {ok: true, json: async () => ({sessions: [{id: 'remote-session', name: 'Remote task session', cwd: '/workspace/task/app'}]})};
  });
  await h.window.loadEnvironments(); await h.window.refresh(true); await h.navigate('/sessions');
  h.input('#sessionScopeSearch', 'Remote task');
  const scope = h.$('[data-conversation-scope]');
  assert.equal(JSON.parse(scope.dataset.conversationScope).environment, 'remote');
  scope.click(); await settle();
  assert.equal(h.currentSession().environment, 'remote');
  const pin = [...h.document.querySelectorAll('[data-task-shortcut-pin]')].find(b => b.textContent.includes('Remote task'));
  assert(pin); pin.click(); await settle();
  const shortcut = [...h.document.querySelectorAll('[data-task-shortcut]')].find(b => b.textContent.includes('Remote task'));
  assert(shortcut); shortcut.click(); await settle();
  assert.equal(h.currentSession().environment, 'remote');
  h.click('#newBrowserSession'); await settle();
  const choices = [...h.$('#sessionBrowserNewDirectory').options];
  assert(choices.some(o => o.textContent.includes('WSL')));
  h.change('#sessionBrowserNewDirectory', choices.find(o => o.textContent.includes('/workspace/task/app')).value); await settle();
  assert.equal(h.currentSession().environment, 'remote');
  assert.equal(h.$('#projectEnvironment').value, 'local');
  assert.equal(h.$('#linkTaskConversation').dataset.environment, 'remote');
});

test('cross-environment assistant callbacks and read markers remain isolated for the same session ID', async t => {
  const h = await harness(t, false);
  h.environments.environments.push({id: 'remote', name: 'WSL'});
  await h.window.loadEnvironments();
  let opened;
  h.window.WorkHubAssistant = {open(options) {opened = options;}, close() {}, updateSession() {}};
  h.setIntercept((url, options) => url.startsWith('/api/sessions?') && options.headers['X-Environment-ID'] === 'remote' ? {ok: true, json: async () => ({sessions: [{...h.sessions[0], name: 'Remote duplicate'}]})} : undefined);
  await h.navigate('/sessions');
  h.click('[data-conversation-session][data-environment="remote"]'); await settle();
  assert.equal(opened.environment, 'remote');
  await opened.request('/api/sessions/session-1/chat', {method: 'POST', body: '{}'});
  assert.equal(h.requests.at(-1).options.headers['X-Environment-ID'], 'remote');
  opened.managed({...h.sessions[0], name: 'Remote renamed'}, 'rename');
  assert.match(h.$('[data-conversation-session][data-environment="remote"]').textContent, /Remote renamed/);
  assert.doesNotMatch(h.$('[data-conversation-session][data-environment="local"]').textContent, /Remote renamed/);
  const localKey = 'workhub:session-read:' + JSON.stringify(['local', 'session-1']);
  const remoteKey = 'workhub:session-read:' + JSON.stringify(['remote', 'session-1']);
  assert(h.window.localStorage.getItem(localKey));
  assert(h.window.localStorage.getItem(remoteKey));
  const localRead = h.window.localStorage.getItem(localKey);
  opened.activity('session-1', {id: 'remote-run', status: 'completed', busy: false, turn_id: 'remote-turn'});
  assert.equal(h.window.localStorage.getItem(localKey), localRead);
  assert.doesNotMatch(h.$('[data-conversation-session][data-environment="local"]').textContent, /有新消息/);
});


test('polling keeps the selected remote conversation while another environment responds first', async t => {
  const h = await harness(t);
  h.environments.environments.push({id: 'remote', name: 'WSL'});
  await h.window.loadEnvironments();
  let delay = false;
  const pending = [];
  h.setIntercept((url, options) => {
    if (!url.startsWith('/api/sessions?') || options.headers['X-Environment-ID'] !== 'remote') return;
    const response = {ok: true, json: async () => ({sessions: [{id: 'remote-session', name: 'Remote selected', cwd: '/remote'}]})};
    return delay ? new Promise(resolve => pending.push(() => resolve(response))) : response;
  });
  await h.navigate('/sessions');
  h.click('[data-conversation-session][data-environment="remote"]'); await settle();
  assert.equal(h.currentSession().environment, 'remote');
  delay = true;
  const refresh = h.window.refreshSessionWorkspace(true); await settle();
  assert.equal(h.currentSession().environment, 'remote');
  assert.equal(h.currentSession().session, 'remote-session');
  pending.forEach(resolve => resolve()); await refresh; await settle();
  assert.equal(h.currentSession().environment, 'remote');
  assert.equal(h.currentSession().session, 'remote-session');
});

test('conversation status filters combine with search and react to activity without changing the open chat', async t => {
  const h = await harness(t, false);
  h.window.WorkHubAssistant = {open() {}, close() {}};
  h.sessions[0].chat_status = 'running';
  h.sessions.push({id:'waiting', name:'Approval needed', cwd:'/repo/backend', chat_status:'waiting'}, {id:'failed', name:'Failed check', cwd:'/external', chat_status:'failed'});
  await h.navigate('/sessions');
  const selected = h.currentSession().session;
  h.click('[data-conversation-status="running"]');
  assert.equal(h.document.querySelectorAll('[data-conversation-session]').length, 1);
  assert.equal(h.$('[data-conversation-session]').dataset.conversationSession, 'session-1');
  assert.equal(h.$('[data-status-count="running"]').textContent, '1');
  assert.equal(h.$('[data-status-count="waiting"]').textContent, '1');
  h.input('#sessionBrowserSearch', 'Backend');
  assert.match(h.$('#sessionBrowserList').textContent, /没有匹配的对话/);
  assert.equal(h.$('#sessionSearchClear').hidden, false);
  h.click('[data-conversation-status="waiting"]');
  assert.equal(h.$('[data-conversation-session]').dataset.conversationSession, 'waiting');
  assert.equal(h.currentSession().session, selected);
  h.window.browserSessionActivity('waiting', {id:'approval', status:'completed', busy:false, turn_id:'done'});
  assert.equal(h.$('[data-conversation-session]'), null);
  assert.match(h.$('#sessionBrowserList').textContent, /清除搜索与筛选/);
  h.click('[data-conversation-action="reset-list"]'); await settle();
  assert.equal(h.$('#sessionBrowserSearch').value, '');
  assert.equal(h.$('[data-conversation-status="all"]').getAttribute('aria-pressed'), 'true');
  assert.equal(h.document.querySelectorAll('[data-conversation-session]').length, 3);
  assert.equal(h.currentSession().session, selected);
  assert.equal(h.document.activeElement.id, 'sessionBrowserSearch');
  h.click('[data-conversation-status="unread"]');
  assert.equal(h.$('[data-conversation-session]').dataset.conversationSession, 'waiting');
  assert(h.$('.session-browser-unread-dot'));
  assert.doesNotMatch(h.$('#sessionNavigationStatus').getAttribute('aria-label'), /3 个会话运行中/);
});

test('conversation keyboard browsing, search reset and filtering preserve the expected focus', async t => {
  const h = await harness(t);
  h.sessions.push({id:'older', name:'Older discussion', cwd:'/repo/backend', updated_at:1});
  await h.navigate('/sessions');
  const key = (node, value) => node.dispatchEvent(new h.window.KeyboardEvent('keydown', {key:value, bubbles:true, cancelable:true}));
  const search = h.$('#sessionBrowserSearch');
  search.focus(); key(search, 'ArrowDown');
  assert.equal(h.document.activeElement.dataset.conversationSession, 'session-1');
  key(h.document.activeElement, 'End');
  assert.equal(h.document.activeElement.dataset.conversationSession, 'older');
  h.window.browserSessionActivity('older', {id:'live', status:'waiting', busy:true});
  assert.equal(h.document.activeElement.dataset.conversationSession, 'older');
  key(h.document.activeElement, 'Home');
  assert.equal(h.document.activeElement.dataset.conversationSession, 'session-1');
  h.input('#sessionBrowserSearch', 'no results'); search.focus(); key(search, 'Escape');
  assert.equal(search.value, '');
  assert.equal(h.document.activeElement, search);
  h.$('#sessionFilterPicker').open = true; await settle();
  const directory = h.$('#sessionDirectoryFilter'); directory.focus();
  h.change('#sessionDirectoryFilter', '/repo/backend'); await settle();
  assert.equal(h.document.activeElement, directory);
  key(directory, 'Escape');
  assert.equal(h.$('#sessionFilterPicker').open, false);
  assert.equal(h.document.activeElement, h.$('#sessionFilterPicker summary'));
  h.click('[data-conversation-session="older"]'); await settle();
  h.click('[data-conversation-action="back"]');
  assert.equal(h.document.activeElement.dataset.conversationSession, 'older');
});

test('conversation date groups keep pinned records unique, handle year boundaries and expose exact timestamps', async t => {
  const h = await harness(t);
  const now = new Date(2026, 0, 3, 12).getTime();
  const session = (id, day, pinned = false) => ({id, name:id, cwd:'/repo/app', updated_at:new Date(2026, 0, day, 10).getTime() / 1000, pinned});
  const markup = h.window.WorkHubUI.conversationList({sessions:[session('today', 3), session('yesterday', 2), session('last-year', 0), session('pinned-old', -20, true), session('old', -20)], showDirectory:false, now});
  const root = h.document.createElement('div'); root.innerHTML = markup;
  assert.deepEqual([...root.querySelectorAll('.session-browser-group')].map(n => n.getAttribute('aria-label')), ['已固定','今天','昨天','近 7 天','更早']);
  assert.equal(root.querySelectorAll('[data-conversation-session="pinned-old"]').length, 1);
  assert.equal(root.querySelector('[data-conversation-session="today"] time').textContent, '10:00');
  assert.match(root.querySelector('[data-conversation-session="last-year"] time').textContent, /2025/);
  assert(root.querySelector('time').getAttribute('datetime'));
  assert(root.querySelector('time').title);
});


test('task status filters surface pending recovery, unpushed commits and Git operations', async t => {
  const h=await harness(t);
  const member=h.data.requirements[0].members[0];
  member.worktree.sync_ahead=2;
  member.worktree.operation='merge';member.worktree.conflicts=['file.txt'];
  await h.window.refresh(true);
  assert.match(h.$('.task-signal-filters').textContent,/待推送 · 1/);
  h.click('[data-action="task-project-filter"][data-filter="push"]');
  assert.equal(h.document.querySelectorAll('.task-project').length,1);
  h.click('[data-action="task-project-filter"][data-filter="dirty"]');
  assert.equal(h.document.querySelectorAll('.task-project').length,0);
  h.click('[data-action="task-project-filter"][data-filter="all"]');
  member.state='pending';await h.window.refresh(true);
  assert(h.$('[data-action="retry"][data-project="app"]'));
  await h.navigate('/requirements');
  h.change('#taskStatusFilter','push');
  assert.equal(h.document.querySelectorAll('[data-action="open-requirement"]').length,1);
  h.change('#taskStatusFilter','dirty');
  assert.match(h.$('#content').textContent,/没有匹配/);
});

test('a missing task directory exposes recovery in place and preserves project context when changing it', async t => {
  const h = await harness(t);
  const member = h.data.requirements[0].members[0];
  Object.assign(member.worktree, {missing: true, upstream: 'origin/feature/task', sync_available: true});
  await h.window.refresh();
  assert.match(h.$('.task-directory-overview').textContent, /1 个关联项目.*0 个目录可打开.*1 个目录需要处理/);
  const notice = h.$('.task-directory-notice');
  assert.match(notice.textContent, /工作目录已丢失/);
  assert.equal(h.$('[data-project-open-primary]').disabled, true);
  assert.doesNotMatch(h.$('.task-project-state').textContent, /已同步|无未提交改动/);
  h.click('.task-directory-notice [data-action="change-task-directory"]'); await settle();
  assert.equal(h.$('#taskDirectoryDialog').open, true);
  h.change('#taskDirectoryPicker select[id$="-mode"]', 'project');
  await h.submit('#taskDirectoryForm');
  const request = h.requests.find(r => r.url === '/api/requirements/task/projects/app' && r.options.method === 'PUT');
  assert.deepEqual(request.body, {project_id: 'app', mode: 'project'});
  assert.equal(h.$('[data-project-open-primary]').dataset.path, '/repo/app');
  assert.equal(h.$('[data-project-open-primary]').disabled, false);
  assert.match(h.$('.task-directory-overview').textContent, /1 个目录可打开/);
  assert.equal(h.$('.task-directory-notice'), null);
});

test('archived tasks explain disabled directory recovery and unchecked directories do not imply clean work', async t => {
  const h = await harness(t);
  const member = h.data.requirements[0].members[0];
  member.worktree.status_updated_at = '';
  await h.window.refresh();
  assert.match(h.$('.task-directory-overview').textContent, /0 个目录可打开.*1 个目录正在检查/);
  assert.doesNotMatch(h.$('.task-project-state').textContent, /无未提交改动/);
  assert.equal(h.$('.task-directory-notice [data-action="change-task-directory"]'), null);
  h.data.requirements[0].state = 'archived';
  member.worktree.missing = true;
  await h.window.refresh();
  assert.equal(h.$('.task-directory-notice [data-action="change-task-directory"]').disabled, true);
  assert.match(h.$('.task-directory-notice').textContent, /取消归档后可处理目录/);
});

test('read-only changes show working and staged files as inert text and reject late file results', async t => {
  const h=await harness(t);
  let release;
  h.setIntercept(url=>{
    if(!url.includes('/changes?'))return;
    const params=new URL(url,'http://localhost').searchParams;
    if(!params.has('file'))return {ok:true,json:async()=>({branch:'feature/task',files:[{path:'file.txt',index:'M',working:'M'},{path:'new.txt',index:'?',working:'?',untracked:true}]})};
    if(params.get('file')==='new.txt')return new Promise(resolve=>{release=resolve;});
    return {ok:true,json:async()=>({text:params.get('mode')==='index'?'+staged':'<script>inert</script>',truncated:false})};
  });
  h.click('[data-action="changes-open"]');await settle();
  assert.equal(h.$('#changesDialog').open,true);
  assert.equal(h.$('#changesText script'),null);
  assert.match(h.$('#changesText').textContent,/<script>inert/);
  h.click('[data-change-file="new.txt"]');await settle();
  h.change('#changesMode','index');await settle();
  assert.equal(h.document.querySelectorAll('[data-change-file]').length,1);
  assert.equal(h.$('#changesText').textContent,'+staged');
  release({ok:true,json:async()=>({text:'old untracked result',truncated:false})});await settle();
  assert.equal(h.$('#changesText').textContent,'+staged');
});

test('task review archives explicitly and only sends selected cleanable directories with their preview', async t => {
  const h=await harness(t);
  let cleaned=false;
  const item={project_id:'app',project_name:'App',path:'/workspace/task/app',branch:'feature/task',current:true,dirty:0,unpushed:0,shared:[],fingerprint:'checked-head'};
  h.setIntercept((url,options)=>{
    if(url.endsWith('/archive')&&options.method==='POST'){h.data.requirements[0].state='archived';return {ok:true,json:async()=>({message:'archived'})};}
    if(url.endsWith('/review'))return {ok:true,json:async()=>({task:h.data.requirements[0],items:cleaned?[]:[{...item,cleanable:h.data.requirements[0].state==='archived',reasons:h.data.requirements[0].state==='archived'?[]:['请先归档任务']}]})};
    if(url.includes('/cleanup/')){cleaned=true;return {ok:true,json:async()=>({message:'cleaned'})};}
  });
  h.click('[data-action="task-review"]');await settle();
  assert.equal(h.$('[data-cleanup-index]').disabled,true);
  h.click('#taskReviewArchive');await settle();
  assert.equal(h.data.requirements[0].state,'archived');
  assert.equal(h.$('[data-cleanup-index]').disabled,false);
  h.$('[data-cleanup-index]').checked=true;h.$('[data-cleanup-index]').dispatchEvent(new h.window.Event('change',{bubbles:true}));
  h.click('#taskReviewClean');await settle();
  const request=h.requests.find(r=>r.url.includes('/cleanup/'));
  assert.deepEqual(request.body,{path:item.path,fingerprint:'checked-head'});
  assert.match(h.$('#taskReviewItems').textContent,/没有需要检查/);
  assert(!h.requests.some(r=>r.body?.action==='delete_branch'));
});

test('a Git network operation keeps refreshing and does not overwrite a different project after closing', async t => {
  const h=await harness(t);
  await h.window.openGit('app','/workspace/task/app');
  let release;
  h.setIntercept((url,options)=>options.method==='POST'&&url==='/api/projects/app/git'?new Promise(resolve=>{release=resolve;}):undefined);
  const pending=h.window.gitOperation({action:'fetch',remote:'origin'},'Background fetch');
  await settle();
  assert.equal(h.$('#gitDialog .close-dialog').disabled,false);
  assert.equal(h.$('#refreshButton').disabled,false);
  h.click('#gitDialog .close-dialog');
  await h.window.openGit('backend','/repo/backend');
  assert.match(h.$('#gitTitle').textContent,/Backend/);
  await h.window.refresh();
  release({ok:true,json:async()=>({message:'App fetch completed'})});
  await pending;await settle();
  assert.match(h.$('#gitTitle').textContent,/Backend/);
  assert.equal(h.$('#gitError').hidden,true);
});

test('project search preserves checked projects and expanded configuration through refresh and submission', async t => {
  const h = await harness(t);
  h.window.openRequirement(); await settle();
  h.input('#requirementName', 'Searchable workspace');
  h.click('#projectPicker-app-selected'); await settle();
  const configuration = h.$('[data-picker-project="app"]');
  configuration.open = true;
  configuration.dispatchEvent(new h.window.Event('toggle'));
  h.input('#projectPickerSearch', 'Backend');
  assert.equal(h.$('[data-picker-search-text][data-project-id="app"]').hidden, true);
  assert.equal(h.$('#projectPicker-app-selected').checked, true);
  await h.window.refresh();
  assert.equal(h.$('#projectPicker-app-selected').checked, true);
  h.input('#projectPickerSearch', '');
  assert.equal(h.$('[data-picker-project="app"]').open, true);
  await h.submit('#requirementForm');
  const request = h.requests.find(r => r.url === '/api/requirements' && r.options.method === 'POST');
  assert.deepEqual(request.body.project_ids, ['app']);
  assert.equal(request.body.members[0].project_id, 'app');
});

test('searchable native fields preserve disabled state, validation and controller change events', async t => {
  const h = await harness(t);
  h.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  await h.window.openGit('app', '/workspace/task/app'); await settle();
  [...h.document.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === '分支').click();
  await settle();
  const source = h.$('#gitBranchSource');
  let trigger = h.$('[data-select-trigger="gitBranchSource"]');
  assert.equal(source.style.getPropertyValue('display'), 'none');
  assert.equal(trigger.getAttribute('aria-label'), '来源分支');
  trigger.click(); await settle();
  assert(h.$('[cmdk-input]'));
  const option = [...h.document.querySelectorAll('[cmdk-item]')].find(item => item.textContent.includes('origin/master'));
  option.click(); await settle();
  assert.equal(source.value, 'refs/remotes/origin/master');
  assert.equal(h.$('#gitTrack').disabled, false);
  assert.equal(h.$('#gitTrack').checked, true);
  source.disabled = true; await settle();
  assert.equal(h.$('[data-select-trigger="gitBranchSource"]').disabled, true);
  source.disabled = false; source.value = ''; await settle();
  const invalid = new h.window.Event('invalid', {cancelable: true});
  source.dispatchEvent(invalid); await settle();
  trigger = h.$('[data-select-trigger="gitBranchSource"]');
  assert.equal(invalid.defaultPrevented, true);
  assert.equal(trigger.getAttribute('aria-invalid'), 'true');
  assert.equal(h.document.activeElement, trigger);
});

test('Radix action menus route through the original project context', async t => {
  const h = await harness(t);
  const trigger = h.$('button[aria-label="App 更多操作"]');
  trigger.dispatchEvent(new h.window.MouseEvent('pointerdown', {bubbles: true, button: 0}));
  await settle();
  assert(h.$('[role="menu"]'));
  [...h.document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === 'Git 操作').click();
  await settle();
  assert.equal(h.$('#gitDialog').open, true);
  assert.equal(h.$('#gitWorktree').value, '/workspace/task/app');
  assert.equal(h.$('#gitWorktree').disabled, true);
});

test('failed conversation refresh retains cached results but a new directory never inherits them', async t => {
  const h = await harness(t);
  h.click('[data-action="task-conversations"]'); await settle();
  assert(h.$('[data-conversation-session="session-1"]'));
  h.setIntercept(url => url.startsWith('/api/sessions?') ? {ok:false,json:async()=>({error:'fixture offline'})} : undefined);
  await h.window.refreshSessionWorkspace(true); await settle();
  assert(h.$('[data-conversation-session="session-1"]'));
  assert.match(h.$('#sessionBrowserCount').textContent, /部分结果未更新/);
  assert.match(h.$('#sessionBrowserError').textContent, /保留上次结果/);
  h.change('#sessionDirectoryFilter', '/workspace/task/app'); await settle();
  assert.equal(h.$('[data-conversation-session="session-1"]'), null);
  assert.match(h.$('#sessionBrowserCount').textContent, /数量暂不可用/);
  assert.doesNotMatch(h.$('#sessionBrowserCount').textContent, /0 个对话/);
  assert.equal(h.$('#sessionBrowserList').textContent, '');
});
