import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const installer = path.resolve(process.argv[2]);
const directory = mkdtempSync(path.join(os.tmpdir(), 'work-hub-installed-'));
const data = path.join(directory, 'data');
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 60000 });
const name = run('dpkg-deb', ['-f', installer, 'Package']).trim();
const files = run('dpkg-deb', ['-c', installer]);
assert(files.includes('/usr/bin/work-hub-backend'));
assert(files.includes('/THIRD-PARTY-NOTICES.txt'));
const backend = '/usr/bin/work-hub-backend';
try {
  run('sudo', ['dpkg', '-i', installer]);
  const start = () => JSON.parse(run('/usr/bin/work-hub', ['--backend-info', '--data', data, '--root', path.join(directory, 'workspaces')]));
  const info = start();
  const descriptor = JSON.parse(readFileSync(path.join(data, 'service.json')));
  let response = await fetch(info.url + '/api/settings/terminal', { method: 'PUT', headers: { 'X-CSRF-Token': descriptor.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'auto' }) });
  assert.equal(response.status, 200);
  assert.throws(() => run('sudo', ['dpkg', '-i', installer])); // Do not replace a live user's package.
  run(backend, ['--prepare-upgrade', '--data', data]);
  run('sudo', ['dpkg', '-i', installer]);
  const upgraded = start();
  const credentials = JSON.parse(readFileSync(path.join(data, 'service.json')));
  response = await fetch(upgraded.url + '/api/state', { headers: { 'X-CSRF-Token': credentials.token } });
  assert.equal((await response.json()).terminal.settings.kind, 'auto');
  run(backend, ['--prepare-upgrade', '--data', data]);
  run('sudo', ['dpkg', '--remove', name]);
  assert(existsSync(path.join(data, 'worktree-hub.db')));
  console.log('Linux package contents, active-process upgrade guard, saved settings and uninstall retention passed.');
} finally {
  if (existsSync(backend)) { try { run(backend, ['--prepare-upgrade', '--data', data]); } catch {} }
}
