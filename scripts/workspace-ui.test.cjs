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
  const task = { id: 'task', name: 'Billing', slug: 'task', branch: 'feature/task', state: 'ready', path: '/workspace/task', created_at: '2026-10-23T06:00:00Z', primary_project_id: app.id, has_workspace: true, members: [{ project_id: app.id, project_name: app.name, mode: 'worktree', path: app.worktrees[1].path, state: 'ready', worktree: app.worktrees[1] }] };
  const data = { root: '/workspace', projects: [app, backend], requirements: [task, { ...task, id: 'archived', name: 'Archived', state: 'archived' }], terminal: { platform: 'linux', available: true, settings: { kind: 'auto' }, supported_kinds: ['auto', 'custom'], supported_styles: ['command', 'otty'], launcher: '/usr/bin/terminal', message: '终端已就绪' }, master_sync: { settings: { enabled: true, time: '09:00' }, last_run: { date: '2026-10-23', status: 'completed', results: [{ project_name: 'App', status: 'current', message: '已是最新' }] } } };
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
  const dom = new JSDOM(fs.readFileSync(path.join(web, 'index.html'), 'utf8').replace('__SESSION_MODE__', readOnly ? 'read-only' : 'interactive'), { url: 'http://localhost:4317/#/requirements/task', runScripts: 'outside-only', pretendToBeVisual: true });
  const channels = [];
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close(); } });
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
  assert.match(h.$('#content').textContent, /项目工作现场/);
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
  assert.equal(h.$('#sessionScopeLabel').textContent, '全部会话');
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
  assert.equal(h.document.querySelectorAll('.session-browser-item-directory').length, 2);
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
  assert.equal(h.$('#sessionsEnvironment').value, 'remote');
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

test('conversation filters live in the list and only expose environment switching when needed', async t => {
  const h = await harness(t);
  await h.navigate('/sessions');
  assert(h.$('#sessionBrowserScopeBar').closest('.session-browser-list'));
  assert.equal(h.$('#sessionEnvironmentField').hidden, true);
  assert.equal(h.$('#sessionsEnvironment').value, 'local');
  h.environments.environments.push({id: 'wsl-test', name: 'Ubuntu'});
  await h.window.loadEnvironments(); await settle();
  assert.equal(h.$('#sessionEnvironmentField').hidden, false);
  assert.equal(h.$('#sessionsEnvironment').options.length, 2);
  h.environments.environments.pop();
  await h.window.loadEnvironments(); await settle();
  assert.equal(h.$('#sessionEnvironmentField').hidden, true);
});

test('conversation list identifies task, project, branch and active counts and refreshes the selected title', async t => {
  const h = await harness(t, false);
  let updated;
  h.window.WorkHubAssistant = {open() {}, close() {}, updateSession(session) {updated = session;}};
  h.sessions[0].chat_status = 'running';
  h.click('[data-action="task-conversations"]'); await settle();
  assert.match(h.$('#sessionBrowserContext').textContent, /任务 · Billing · 本机/);
  assert.match(h.$('#sessionBrowserCount').textContent, /1 个运行中/);
  assert.match(h.$('[data-conversation-session="session-1"]').textContent, /任务 · Billing.*项目 · App.*feature\/task/);
  h.sessions[0].name = 'Codex generated title';
  h.click('[data-conversation-action="refresh"]'); await settle();
  assert.equal(updated.name, 'Codex generated title');
  assert.match(h.$('[data-conversation-session="session-1"]').textContent, /Codex generated title/);
});

test('global shortcuts restore recent opens, ignore background ordering and jump past saved filters', async t => {
  const h = await harness(t);
  h.sessions.push({id:'outside', name:'Outside task', cwd:'/repo/backend', updated_at:1});
  await h.navigate('/sessions');
  h.click('[data-conversation-session="outside"]'); await settle();
  h.click('[data-conversation-session="session-1"]'); await settle();
  const recent = () => [...h.document.querySelectorAll('#shortcutRecentTitle + ul [data-conversation-shortcut]')].map(b => b.dataset.conversationShortcut);
  assert.deepEqual(recent(), ['session-1', 'outside']);
  h.sessions[1].updated_at = 1999999999;
  await h.window.refreshSessionWorkspace(true); await settle();
  assert.deepEqual(recent(), ['session-1', 'outside']);
  assert.deepEqual(JSON.parse(h.window.localStorage.getItem('workhub:recent-conversations:v1:local')).slice(0, 2), ['session-1', 'outside']);
  h.window.eval('conversationRecent.clear(); renderConversationShortcuts()');
  assert.deepEqual(recent(), ['session-1', 'outside']);
  h.change('#sessionDirectoryFilter', '/workspace/task/app'); await settle();
  h.input('#sessionBrowserSearch', 'no match');
  h.click('[data-conversation-shortcut="outside"]'); await settle();
  assert.equal(h.currentSession().session, 'outside');
  assert.equal(h.$('#sessionDirectoryFilter').value, '');
  assert.equal(h.$('#sessionBrowserSearch').value, '');
  assert.equal(h.$('#sessionScopeLabel').textContent, '全部会话');
  assert.deepEqual(recent(), ['outside', 'session-1']);
  await h.navigate('/projects');
  h.click('[data-conversation-shortcut="session-1"]'); await settle();
  assert.equal(h.currentSession().session, 'session-1');
  assert.equal(h.window.location.hash, '#/sessions');
});

test('sidebar pins persist through the existing manage API, deduplicate recents and recover from failure', async t => {
  const h = await harness(t, false);
  await h.navigate('/sessions');
  h.setIntercept((url, options, body) => {
    if (!url.endsWith('/manage')) return;
    h.sessions[0].pinned = body.action === 'pin';
    return {ok:true, json:async()=>({session:h.sessions[0]})};
  });
  h.click('[data-shortcut-pin="session-1"]'); await settle();
  assert(h.$('#shortcutPinnedTitle + ul [data-conversation-shortcut="session-1"]'));
  assert.equal(h.$('#shortcutRecentTitle + ul'), null);
  const request = h.requests.find(r => r.url.endsWith('/manage'));
  assert.deepEqual(request.body, {action:'pin'});
  h.click('[data-shortcut-pin="session-1"]'); await settle();
  assert(h.$('#shortcutRecentTitle + ul [data-conversation-shortcut="session-1"]'));
  h.setIntercept(url => url.endsWith('/manage') ? {ok:false, status:503, json:async()=>({error:'稍后重试'})} : undefined);
  h.click('[data-shortcut-pin="session-1"]'); await settle();
  assert.equal(h.$('[data-shortcut-pin="session-1"]').disabled, false);
  assert.equal(h.$('#shortcutPinnedTitle + ul'), null);
  assert.match(h.$('#toast').textContent, /稍后重试/);
});

test('sidebar shortcuts isolate environments, exclude archived sessions and react to hidden-page organization', async t => {
  const h = await harness(t);
  h.sessions[0].pinned = true;
  h.sessions.push({id:'archived-session', name:'Archived pin', cwd:'/repo/app', pinned:true, archived:true});
  await h.window.refreshSessionWorkspace(true); await settle();
  assert(h.$('[data-conversation-shortcut="session-1"]'));
  assert.equal(h.$('[data-conversation-shortcut="archived-session"]'), null);
  h.window.dispatchEvent(new h.window.CustomEvent('workhub:session-managed', {detail:{session:{...h.sessions[0], name:'Renamed while hidden'}, action:'rename', environment:'local'}}));
  assert.match(h.$('#conversationShortcuts').textContent, /Renamed while hidden/);
  h.setIntercept(url => url.startsWith('/api/sessions?') ? {ok:true, json:async()=>({sessions:[{id:'session-1', name:'Remote only', cwd:'/remote', pinned:true}]})} : undefined);
  await h.window.selectEnvironment('wsl-test', '/projects'); await settle();
  assert.match(h.$('#conversationShortcuts').textContent, /Remote only/);
  assert.doesNotMatch(h.$('#conversationShortcuts').textContent, /Renamed while hidden/);
  assert.equal(h.window.localStorage.getItem('workhub:recent-conversations:v1:wsl-test'), null);
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
  h.setIntercept(url => url === '/api/sessions?' ? new Promise(resolve => {release = resolve;}) : undefined);
  const pending = h.window.refreshConversationShortcuts(true); await settle();
  h.setIntercept((url, options) => url === '/api/sessions?' ? {ok:true, json:async()=>({sessions:[{id:'session-1', name:options.headers['X-Environment-ID'] === 'wsl-test' ? 'Remote' : 'Fresh local', cwd:'/repo/app', pinned:true}]})} : undefined);
  await h.window.selectEnvironment('wsl-test', '/projects'); await settle();
  await h.window.selectEnvironment('local', '/projects'); await settle();
  assert.match(h.$('#conversationShortcuts').textContent, /Fresh local/);
  release({ok:true, json:async()=>({sessions:[{id:'session-1', name:'Stale local', cwd:'/repo/app', pinned:true}]})});
  await pending; await settle();
  assert.match(h.$('#conversationShortcuts').textContent, /Fresh local/);
  assert.doesNotMatch(h.$('#conversationShortcuts').textContent, /Stale local/);
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
  assert.match(h.$('#projectDetail').textContent, /3 项修改/);
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
  assert.equal(h.$('.project-change-indicator').textContent, '有修改');
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
