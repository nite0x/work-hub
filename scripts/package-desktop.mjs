import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { root, run, desktopVersion, packagePlan, bundleFiles, writeChecksums } from './desktop-lib.mjs';

const plan = packagePlan(process.argv.slice(2), run('rustc', ['--print', 'host-tuple']));
const version = desktopVersion();
const mode = plan.debug ? 'debug' : 'release';
const output = path.join(root, 'dist/desktop', version, plan.target, mode);
if (plan.dryRun) {
  console.log(JSON.stringify({ version, target: plan.target, bundles: plan.bundles, mode, requireSigning: plan.requireSigning, output }, null, 2));
} else {
  const targetDirectory = path.join(root, 'src-tauri/target', plan.target, mode);
  const bundleDirectory = path.join(targetDirectory, 'bundle');
  // Both directories contain generated build output only. A failed rebuild must
  // never leave old installers looking like artifacts of the new source tree.
  rmSync(output, { recursive: true, force: true });
  rmSync(bundleDirectory, { recursive: true, force: true });
  const args = [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--ci', '--target', plan.target, '--bundles', plan.bundles.join(',')];
  if (plan.debug) args.push('--debug');
  if (Object.keys(plan.config).length) args.push('--config', JSON.stringify(plan.config));
  args.push('--', '--locked');
  run(process.execPath, args, { stdio: 'inherit' });
  const artifacts = bundleFiles(bundleDirectory, plan);
  mkdirSync(output, { recursive: true });
  const names = [];
  for (const artifact of artifacts) {
    const name = `work-hub_${version}_${plan.target}${artifact.suffix}`;
    cpSync(artifact.source, path.join(output, name));
    names.push(name);
  }
  for (const [source, name] of [['README.md', 'README.md'], ['src-tauri/notices/THIRD-PARTY-NOTICES.txt', 'THIRD-PARTY-NOTICES.txt']]) {
    cpSync(path.join(root, source), path.join(output, name)); names.push(name);
  }
  if (plan.platform === 'win32') {
    for (const [source, name] of [
      ['scripts/upgrade-windows.ps1', 'Upgrade-WorkHub.ps1'],
      ['scripts/upgrade-windows.cmd', 'Upgrade.cmd'],
      [`src-tauri/binaries/work-hub-backend-${plan.target}.exe`, 'work-hub-upgrade.exe'],
    ]) {
      cpSync(path.join(root, source), path.join(output, name)); names.push(name);
    }
  }
  const files = writeChecksums(output, names);
  const revision = run('git', ['rev-parse', 'HEAD']);
  const modified = Boolean(run('git', ['status', '--porcelain', '--untracked-files=normal']));
  writeFileSync(path.join(output, 'release.json'), JSON.stringify({ version, target: plan.target, mode, backend_version: readFileSync(path.join(root, 'src-tauri/backend-version.txt'), 'utf8').trim(), revision, modified, signing_required: plan.requireSigning, files }, null, 2) + '\n');
  // Cover the manifest itself too; the manifest's file list intentionally has no
  // self-hash. SHA256SUMS is integrity metadata, not a publisher signature.
  writeChecksums(output, [...names, 'release.json']);
  console.log(`Desktop installers: ${output}`);
}
