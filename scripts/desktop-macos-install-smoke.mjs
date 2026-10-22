import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = path.resolve(process.argv[2]);
const directory = mkdtempSync(path.join(os.tmpdir(), 'work-hub-macos-install-'));
const mount = path.join(directory, 'Mounted');
const installed = path.join(directory, 'Installed with spaces', 'Work Hub.app');
mkdirSync(mount);
let mounted = false;
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 120000 });
try {
  run('/usr/bin/hdiutil', ['verify', installer]);
  run('/usr/bin/hdiutil', ['attach', installer, '-readonly', '-nobrowse', '-mountpoint', mount]);
  mounted = true;
  assert(existsSync(path.join(mount, 'Applications')));
  run('/usr/bin/ditto', [path.join(mount, 'Work Hub.app'), installed]);
  assert(existsSync(path.join(installed, 'Contents/Resources/notices/THIRD-PARTY-NOTICES.txt')));
  const binaries = path.join(installed, 'Contents/MacOS');
  const smoke = fileURLToPath(new URL('desktop-smoke.mjs', import.meta.url));
  const result = run(process.execPath, [smoke, path.join(binaries, 'work-hub-backend'), path.join(binaries, 'work-hub')]);
  console.log(result.trim());
  console.log('macOS DMG integrity, application copy to a new install path, bundled resources and installed lifecycle passed.');
} finally {
  if (mounted) {
    run('/usr/bin/hdiutil', ['detach', mount]);
    mounted = false;
  }
  // Retain nothing under an attached disk image if detaching fails.
  if (!mounted) rmSync(directory, { recursive: true, force: true });
}
