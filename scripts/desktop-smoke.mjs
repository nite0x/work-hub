import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Run against a freshly prepared native Go binary, or pass the desktop host as
// the second argument to exercise Rust -> launcher -> detached Go as well.
const execute = promisify(execFile);
const binary = path.resolve(process.argv[2]);
const host = process.argv[3] ? path.resolve(process.argv[3]) : null;
const temporary = await mkdtemp(path.join(os.tmpdir(), 'work-hub-desktop-'));
const data = path.join(temporary, "数据 ' & spaces");
const root = path.join(temporary, 'workspaces');
const run = (file, args) => execute(file, args, { timeout: 30000, maxBuffer: 1024 * 1024 });
const start = async (extra = []) => JSON.parse((await run(host || binary,
  [host ? '--backend-info' : '--desktop-start', '--data', data, ...extra])).stdout);
let info;
try {
  info = await start(['--root', root]);
  const credentials = JSON.parse(await readFile(path.join(data, 'service.json'), 'utf8'));
  const health = async () => {
    const response = await fetch(info.url + '/healthz', { headers: { 'X-Worktree-Hub-Instance': credentials.token } });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await health()).pid, info.pid); // launcher already exited; backend survives.
  assert.equal(info.read_only_sessions, true);
  assert.equal(new URL(info.url).hostname, '127.0.0.1');
  assert.equal((await fetch(info.url + '/api/state')).status, 403);
  const headers = { 'X-CSRF-Token': credentials.token, 'Content-Type': 'application/json' };
  assert.equal((await fetch(info.url + '/api/state', { headers })).status, 200);
  assert.equal((await fetch(info.url + '/')).status, 200);
  const reused = await Promise.all(Array.from({ length: 4 }, () => start()));
  assert(reused.every(candidate => candidate.pid === info.pid && candidate.url === info.url));
  await assert.rejects(start(['--root', path.join(temporary, 'different-root')]), /工作区/);
  assert.equal((await health()).pid, info.pid);

  await run(host || binary, ['--stop', '--data', data]);
  await assert.rejects(readFile(path.join(data, 'service.json')));
  // A stale descriptor must not prevent a fresh start. None of its PID or port
  // information may be used to kill an unrelated process.
  await writeFile(path.join(data, 'service.json'), JSON.stringify(credentials));
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => start(['--root', root])));
  info = concurrent[0];
  assert(concurrent.every(candidate => candidate.pid === info.pid));
  assert.notEqual(info.pid, credentials.pid);
  const beforeUpgrade = JSON.parse(await readFile(path.join(data, 'service.json'), 'utf8'));
  assert.equal((await fetch(info.url + '/api/settings/master-sync', { method: 'PUT', headers: { 'X-CSRF-Token': beforeUpgrade.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false, time: '09:25' }) })).status, 200);
  await run(binary, ['--prepare-upgrade', '--data', data]);
  await run(binary, ['--prepare-upgrade', '--data', data]); // installer retries are idempotent.
  info = await start(['--root', root]);
  const afterUpgrade = JSON.parse(await readFile(path.join(data, 'service.json'), 'utf8'));
  const state = await (await fetch(info.url + '/api/state', { headers: { 'X-CSRF-Token': afterUpgrade.token } })).json();
  assert.equal(state.master_sync.settings.time, '09:25');
  assert.equal(state.master_sync.settings.enabled, false);
  await run(binary, ['--prepare-upgrade', '--data', data]);
  info = null;
  console.log('Desktop lifecycle passed: detached survival, authenticated API, reuse, root conflict, safe stop, stale recovery, concurrent startup, idempotent upgrade preparation and retained database.');
} finally {
  if (info) { try { await run(binary, ['--stop', '--data', data]); } catch {} }
  await rm(temporary, { recursive: true, force: true });
}
