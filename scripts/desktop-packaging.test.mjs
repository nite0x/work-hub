import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopVersion, targets, packagePlan, bundleFiles, writeChecksums } from './desktop-lib.mjs';

test('installer plans select native platform formats and reject accidental cross-OS builds', () => {
  for (const [triple, definition] of Object.entries(targets)) {
    const plan = packagePlan(['--target', triple], triple, {});
    assert.deepEqual(plan.bundles, definition.bundles);
  }
  assert.throws(() => packagePlan(['--target', 'x86_64-pc-windows-msvc'], 'aarch64-apple-darwin', {}), /corresponding operating/);
  assert.throws(() => packagePlan(['--target', 'universal-apple-darwin'], 'aarch64-apple-darwin', {}), /Unsupported/);
  assert.throws(() => packagePlan(['--target'], 'aarch64-apple-darwin', {}), /requires/);
  assert.throws(() => packagePlan([], 'aarch64-apple-darwin', { CARGO_TARGET_DIR: '/other-output' }), /CARGO_TARGET_DIR/);
});

test('signed builds fail before compilation when publisher credentials are incomplete', () => {
  const mac = 'aarch64-apple-darwin', win = 'x86_64-pc-windows-msvc';
  assert.throws(() => packagePlan(['--require-signing'], mac, {}), /SIGNING_IDENTITY/);
  assert.throws(() => packagePlan(['--require-signing'], mac, { APPLE_SIGNING_IDENTITY: '-' }), /Developer ID/);
  assert.throws(() => packagePlan(['--require-signing'], mac, { APPLE_SIGNING_IDENTITY: 'Developer ID Application: Test' }), /notarization/);
  assert.throws(() => packagePlan(['--require-signing'], win, {}), /THUMBPRINT/);
  const plan = packagePlan(['--require-signing'], win, { WORK_HUB_WINDOWS_CERTIFICATE_THUMBPRINT: 'fixture' });
  assert.equal(plan.config.bundle.windows.digestAlgorithm, 'sha256');
  assert.equal(plan.config.bundle.windows.certificateThumbprint, 'fixture');
});

test('version drift is rejected and every exported installer has integrity metadata', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'work-hub-package-'));
  try {
    mkdirSync(path.join(directory, 'src-tauri'));
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    writeFileSync(path.join(directory, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '../package.json' }));
    writeFileSync(path.join(directory, 'src-tauri/Cargo.toml'), '[package]\nversion = "1.2.3"\n');
    assert.equal(desktopVersion(directory), '1.2.3');
    writeFileSync(path.join(directory, 'src-tauri/Cargo.toml'), '[package]\nversion = "1.2.2"\n');
    assert.throws(() => desktopVersion(directory), /versions must match/);
    mkdirSync(path.join(directory, 'dmg'));
    writeFileSync(path.join(directory, 'dmg/test.dmg'), 'abc');
    assert.equal(bundleFiles(directory, { bundles: ['dmg'] }).length, 1);
    assert.throws(() => bundleFiles(directory, { bundles: ['nsis'] }));
    writeFileSync(path.join(directory, 'dmg/stale.dmg'), 'stale');
    assert.throws(() => bundleFiles(directory, { bundles: ['dmg'] }), /Expected one fresh/);
    writeFileSync(path.join(directory, 'installer'), 'abc');
    assert.equal(writeChecksums(directory, ['installer'])[0].sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.match(readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8'), /  installer\n$/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
