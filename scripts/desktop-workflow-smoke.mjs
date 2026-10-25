import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const binary = path.resolve(process.argv[2]);
const keep = process.argv.includes('--keep');
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'work-hub-workflow-')));
const data = path.join(directory, "数据 ' & spaces");
const workspace = path.join(directory, "工作区 ' & spaces");
const bin = path.join(directory, 'tools');
const fixtureFile = path.join(directory, 'codex-fixture.json');
const log = path.join(directory, 'codex-calls.jsonl');
const shellQuote = s => "'" + s.replaceAll("'", "'\"'\"'") + "'";
await mkdir(bin);
const fixtureScript = fileURLToPath(new URL('fixtures/desktop-codex.cjs', import.meta.url));
await writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexec ' + [process.execPath, fixtureScript, fixtureFile].map(shellQuote).join(' ') + ' "$@"\n', { mode: 0o700 });
const env = { ...process.env, PATH: bin + path.delimiter + '/usr/bin:/bin', CODEX_HOME: path.join(directory, 'codex-home'), GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
await writeFile(fixtureFile, JSON.stringify({ sessions: [], items: [], log }));
const run = (file, args, extra = {}) => execute(file, args, { env, timeout: 30000, maxBuffer: 2 * 1024 * 1024, ...extra });
const git = async (cwd, ...args) => (await run('/usr/bin/git', ['-C', cwd, ...args])).stdout.trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let running = false, retained = false;
try {
  const host = JSON.parse((await run(binary, ['--desktop-start', '--data', data, '--root', workspace])).stdout);
  running = true;
  const descriptor = JSON.parse(await readFile(path.join(data, 'service.json'), 'utf8'));
  assert.equal(descriptor.read_only_sessions, false);
  const page = await (await fetch(host.url)).text();
  assert.match(page, /name="session-mode" content="interactive"/);
  assert.match(page, /src="\/features\/sessions\/session-create.js"/);
  const headers = { 'X-CSRF-Token': descriptor.token, 'Content-Type': 'application/json' };
  const request = async (endpoint, method = 'GET', body, expected = 200) => {
    const response = await fetch(host.url + endpoint, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${endpoint}: ${JSON.stringify(result)}`);
    return result;
  };
  await request('/api/settings/master-sync', 'PUT', { enabled: false, time: '09:00' });
  const environment = await request('/api/environments');
  assert.equal(environment.platform, process.platform === 'darwin' ? 'darwin' : process.platform);
  if (process.platform === 'darwin') assert.equal(environment.wsl_supported, false);
  const projects = [];
  for (const name of ["前端 ' & spaces", '后端项目']) {
    const seed = path.join(directory, 'seed-' + projects.length);
    const remote = path.join(directory, 'remote-' + projects.length + '.git');
    const repository = path.join(directory, name);
    await mkdir(seed);
    await git(seed, 'init', '-b', 'master');
    await git(seed, 'config', 'user.name', 'Work Hub Verification');
    await git(seed, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(path.join(seed, 'README.md'), name + '\n');
    await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'baseline');
    await git(directory, 'clone', '--bare', seed, remote);
    await git(directory, 'clone', remote, repository);
    const project = await request('/api/projects', 'POST', { name, path: repository }, 201);
    projects.push({ id: project.id, name, repository, seed, remote });
  }
  const task = await request('/api/requirements', 'POST', { name: 'macOS 完整流程验收', slug: 'macos-verification', description: '隔离的双项目开发任务', primary_project_id: projects[0].id, project_ids: [projects[1].id] }, 201);
  assert.equal(task.state, 'ready'); assert.equal(task.members.length, 2);
  for (const member of task.members) {
    assert(member.path.startsWith(workspace + path.sep));
    assert.equal(await git(member.path, 'branch', '--show-current'), task.branch);
  }
  const primary = task.members.find(m => m.project_id === projects[0].id).path;
  const baseline = await git(primary, 'rev-parse', 'HEAD');
  const project = projects[0];
  await writeFile(path.join(project.seed, 'remote-update.txt'), 'fast forward\n');
  await git(project.seed, 'add', '.'); await git(project.seed, 'commit', '-m', 'remote update');
  await git(project.seed, 'push', project.remote, 'master');
  const action = (body, expected = 200) => request('/api/projects/' + project.id + '/git', 'POST', body, expected);
  await action({ action: 'fetch', remote: 'origin' });
  await action({ action: 'pull', path: project.repository });
  assert.equal(await git(project.repository, 'rev-parse', 'HEAD'), await git(project.seed, 'rev-parse', 'HEAD'));
  assert.equal(await git(primary, 'rev-parse', 'HEAD'), baseline); // task snapshot is preserved.
  await action({ action: 'create_branch', name: 'codex/git-verification', source: 'refs/heads/master' });
  await action({ action: 'switch', source: 'refs/heads/codex/git-verification', path: project.repository });
  await writeFile(path.join(project.repository, 'uncommitted.txt'), 'keep me\n');
  await action({ action: 'switch', source: 'refs/heads/master', path: project.repository }, 409);
  await rm(path.join(project.repository, 'uncommitted.txt'));
  await action({ action: 'switch', source: 'refs/heads/master', path: project.repository });
  await writeFile(path.join(primary, '本地修改.txt'), 'visible in the task\n');
  await request('/api/state?refresh=1');
  let state;
  for (let attempt = 0; attempt < 50; attempt++) {
    state = await request('/api/state');
    const tree = state.projects.find(p => p.id === project.id)?.worktrees.find(t => t.path === primary);
    if (tree?.dirty && !tree.refreshing) break;
    await pause(100);
  }
  assert(state.projects.find(p => p.id === project.id).worktrees.find(t => t.path === primary).dirty > 0);
  if (process.platform === 'darwin') {
    assert.equal(state.terminal.settings.kind, 'macos-terminal');
    assert.equal(state.terminal.available, true);
    assert.equal(state.terminal.codex, true); // discovered from minimal GUI-like PATH.
    assert(!state.terminal.supported_kinds.includes('powershell'));
    await request('/api/settings/terminal', 'PUT', { kind: 'macos-terminal' });
  }
  const session = { id: 'macos-verification-session', name: 'macOS 会话查看验收', preview: '', cwd: primary, createdAt: 1700000000, updatedAt: 1700000001 };
  const items = [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '检查当前项目的 Git 状态。' }] },
    { id: 'command', type: 'commandExecution', command: 'git status --short --branch', cwd: primary, status: 'completed', aggregatedOutput: '## ' + task.branch + '\n?? 本地修改.txt', exitCode: 0, durationMs: 12 },
    { id: 'reply', type: 'agentMessage', text: '已读取本地状态，修改仍保留。<script>这段文字不会执行</script>' },
  ];
  await writeFile(fixtureFile, JSON.stringify({ sessions: [session], items, log }));
  const sessions = await request(`/api/requirements/${task.id}/sessions`);
  assert(sessions.sessions.some(s => s.id === session.id && s.source === 'workspace'));
  const history = await request(`/api/requirements/${task.id}/sessions/${session.id}/history`);
  assert.deepEqual(history.entries.map(e => e.kind), ['user', 'command', 'assistant']);
  assert.equal(history.entries[1].exit_code, 0);
  assert(history.entries[1].output.includes('本地修改.txt'));
  const chat = await request(`/api/requirements/${task.id}/sessions/${session.id}/chat`);
  assert.equal(chat.status, 'idle');
  assert.equal(chat.blocked || '', '');
  // Validation reaches the creation handler; no actual turn is started.
  await request(`/api/requirements/${task.id}/sessions/new`, 'POST', {}, 400);
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert(calls.every(call => !['thread/start', 'turn/start', 'thread/resume'].includes(call.rpc)));
  await request(`/api/requirements/${task.id}/archive`, 'POST', { archived: true });
  for (const member of task.members) assert.equal(await git(member.path, 'branch', '--show-current'), task.branch);
  await request(`/api/requirements/${task.id}/archive`, 'POST', { archived: false });
  const saved = { directory, data, workspace, projects, task, session, primary, url: host.url, pid: host.pid, log };
  await writeFile(path.join(directory, 'test-state.json'), JSON.stringify(saved, null, 2));
  console.log('Workflow passed: two projects, multi-project task, fetch, fast-forward pull, branch switch, dirty guard, worktree status, saved session history, archive/restore.');
  if (keep) { retained = true; console.log('Native UI verification state: ' + path.join(directory, 'test-state.json')); }
} finally {
  if (!retained) {
    if (running) await run(binary, ['--stop', '--data', data]);
    await rm(directory, { recursive: true, force: true });
  }
}
