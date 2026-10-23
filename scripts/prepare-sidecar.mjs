import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopVersion, targets } from './desktop-lib.mjs';

await import('./build-frontend.mjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args, env = {}) => {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return result.stdout.trim();
};
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || run('rustc', ['--print', 'host-tuple']);
const target = targets[triple];
if (!target) throw new Error(`Unsupported desktop target: ${triple}`);
const architecture = target.goarch;
const os = target.platform === 'win32' ? 'windows' : target.platform;

// Content identity prevents a newly built desktop host silently reusing an old
// backend, including local edits which share the same Git commit.
const hash = createHash('sha256');
function fingerprint(directory) {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) fingerprint(relative);
    else if (relative.startsWith('web' + path.sep) || (relative.endsWith('.go') && !relative.endsWith('_test.go'))) {
      hash.update(relative.replaceAll(path.sep, '/'));
      hash.update(readFileSync(path.join(root, relative)));
    }
  }
}
for (const directory of ['internal', 'web']) fingerprint(directory);
for (const file of ['main.go', 'go.mod', 'go.sum']) hash.update(readFileSync(path.join(root, file)));
const version = `${desktopVersion()}-${hash.digest('hex').slice(0, 16)}`;
const output = path.join(root, 'src-tauri', 'binaries');
mkdirSync(output, { recursive: true });
const flags = `-s -w -X worktree-hub/internal/app.BuildVersion=${version}`;
run('go', ['build', '-trimpath', '-ldflags', flags, '-o', path.join(output, `work-hub-backend-${triple}${os === 'windows' ? '.exe' : ''}`), '.'], { GOOS: os, GOARCH: architecture, CGO_ENABLED: '0' });
if (os === 'windows') {
  const agents = path.join(root, 'src-tauri', 'agents');
  // Never carry a helper from a previous target into a new installer.
  const { rmSync } = await import('node:fs');
  rmSync(agents, { recursive: true, force: true });
  mkdirSync(agents, { recursive: true });
  run('go', ['build', '-trimpath', '-ldflags', flags, '-o', path.join(agents, `worktree-hub-linux-${architecture}`), '.'], { GOOS: 'linux', GOARCH: architecture, CGO_ENABLED: '0' });
}
writeFileSync(path.join(root, 'src-tauri', 'backend-version.txt'), version + '\n');
console.log(`Prepared Go backend ${version} for ${triple}`);
