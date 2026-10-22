import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const targets = {
  'aarch64-apple-darwin': { platform: 'darwin', goarch: 'arm64', bundles: ['dmg'] },
  'x86_64-apple-darwin': { platform: 'darwin', goarch: 'amd64', bundles: ['dmg'] },
  'x86_64-pc-windows-msvc': { platform: 'win32', goarch: 'amd64', bundles: ['nsis'] },
  'x86_64-unknown-linux-gnu': { platform: 'linux', goarch: 'amd64', bundles: ['deb', 'appimage'] },
};

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'], ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return result.stdout?.trim();
}

export function desktopVersion(directory = root) {
  const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json')));
  const config = JSON.parse(readFileSync(path.join(directory, 'src-tauri/tauri.conf.json')));
  const cargo = readFileSync(path.join(directory, 'src-tauri/Cargo.toml'), 'utf8');
  const cargoVersion = cargo.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version) || config.version !== '../package.json' || cargoVersion !== pkg.version) {
    throw new Error('package.json and Cargo.toml versions must match; tauri.conf.json must use ../package.json');
  }
  return pkg.version;
}

export function packagePlan(args, host, env = process.env) {
  let target, debug = false, requireSigning = false, dryRun = false;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--target': target = args[++i]; if (!target) throw new Error('--target requires a triple'); break;
      case '--debug': debug = true; break;
      case '--require-signing': requireSigning = true; break;
      case '--dry-run': dryRun = true; break;
      default: throw new Error(`Unknown packaging argument: ${args[i]}`);
    }
  }
  target ||= host;
  const definition = targets[target];
  if (!definition) throw new Error(`Unsupported installer target: ${target}`);
  if (targets[host]?.platform !== definition.platform) throw new Error('Build installers on the corresponding operating system');
  if (env.CARGO_TARGET_DIR) throw new Error('desktop:package uses src-tauri/target; unset CARGO_TARGET_DIR');
  const config = {};
  if (definition.platform === 'darwin' && requireSigning) {
    if (!env.APPLE_SIGNING_IDENTITY || env.APPLE_SIGNING_IDENTITY === '-') throw new Error('A Developer ID APPLE_SIGNING_IDENTITY is required');
    const notary = env.APPLE_API_ISSUER && env.APPLE_API_KEY && env.APPLE_API_KEY_PATH
      || env.APPLE_ID && env.APPLE_PASSWORD && env.APPLE_TEAM_ID;
    if (!notary) throw new Error('Apple notarization credentials are required');
  }
  if (definition.platform === 'win32') {
    if (env.WORK_HUB_WINDOWS_CERTIFICATE_THUMBPRINT) {
      config.bundle = { windows: { certificateThumbprint: env.WORK_HUB_WINDOWS_CERTIFICATE_THUMBPRINT, digestAlgorithm: 'sha256', timestampUrl: 'http://timestamp.digicert.com', tsp: true } };
    } else if (requireSigning) throw new Error('WORK_HUB_WINDOWS_CERTIFICATE_THUMBPRINT is required');
  }
  if (definition.platform === 'linux' && requireSigning) throw new Error('--require-signing applies to macOS and Windows; Linux artifacts use SHA256SUMS');
  return { target, ...definition, debug, requireSigning, dryRun, config };
}

export function bundleFiles(bundleDirectory, plan) {
  const result = [];
  for (const kind of plan.bundles) {
    const directory = path.join(bundleDirectory, kind);
    const suffix = { dmg: '.dmg', nsis: '-setup.exe', deb: '.deb', appimage: '.AppImage' }[kind];
    const files = readdirSync(directory).filter(name => name.endsWith(suffix) && statSync(path.join(directory, name)).isFile());
    if (files.length !== 1) throw new Error(`Expected one fresh ${kind} installer, found ${files.length}`);
    result.push({ kind, source: path.join(directory, files[0]), suffix });
  }
  return result;
}

export function writeChecksums(directory, names) {
  const files = names.sort().map(name => {
    const contents = readFileSync(path.join(directory, name));
    return { name, size: contents.length, sha256: createHash('sha256').update(contents).digest('hex') };
  });
  writeFileSync(path.join(directory, 'SHA256SUMS'), files.map(f => `${f.sha256}  ${f.name}\n`).join(''));
  return files;
}
