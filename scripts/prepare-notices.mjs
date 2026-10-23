import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { root, run, targets } from './desktop-lib.mjs';

// Include full license texts from the locked frontend, Go and Rust dependencies, including
// build dependencies. No registry paths or developer home directories are shipped.
const frontendOnly = process.argv.includes('--frontend-only');
const sections = [`Work Hub — Third-party notices\nGenerated from package-lock.json${frontendOnly ? '' : ', go.mod/go.sum and src-tauri/Cargo.lock'}.\n`];
const overrides = JSON.parse(readFileSync(path.join(root, 'scripts/licenses/overrides.json')));
function add(name, directory, license, licenseFile, override) {
  const names = readdirSync(directory).filter(file => /^(licen[cs]e|copying|copyright|notice|unlicense)([._-]|$)/i.test(file) && statSync(path.join(directory, file)).isFile());
  if (licenseFile && !names.includes(licenseFile)) names.push(licenseFile);
  if (!names.length && override) {
    sections.push(`\n${'='.repeat(72)}\n${name}\nLicense: ${license}\nSource: ${override.source}\n${readFileSync(path.join(root, 'scripts/licenses', override.file), 'utf8')}\n`);
    return;
  }
  if (!names.length) throw new Error(`No license text found for ${name}`);
  sections.push(`\n${'='.repeat(72)}\n${name}\nLicense: ${license || 'See license text below'}\n`);
  for (const file of names.sort()) sections.push(`\n--- ${path.basename(file)} ---\n${readFileSync(path.resolve(directory, file), 'utf8')}\n`);
}
const npmLock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
for (const [location, pkg] of Object.entries(npmLock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!location || pkg.dev || pkg.devOptional) continue;
  const directory = path.join(root, location);
  const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const fallback = manifest.name.replaceAll("/", "_") + ".txt";
  const override = existsSync(path.join(root, "scripts/licenses", fallback)) ? { file: fallback, source: manifest.homepage || manifest.repository?.url || `https://www.npmjs.com/package/${manifest.name}` } : undefined;
  add(`${manifest.name} ${manifest.version}`, directory, manifest.license, undefined, override);
}
add('shadcn/ui components', path.join(root, 'frontend'), 'MIT', 'shadcn-LICENSE.md');
add('assistant-ui registry components', path.join(root, 'frontend/components/assistant-ui'), 'MIT', 'LICENSE');
if (frontendOnly) {
  process.stdout.write(sections.join(''));
  process.exit(0);
}

const goroot = run('go', ['env', 'GOROOT']);
add('Go standard library', goroot, 'BSD-3-Clause');
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || run('rustc', ['--print', 'host-tuple']);
const target = targets[triple];
const goos = target.platform === 'win32' ? 'windows' : target.platform;
const modules = new Set();
for (const system of goos === 'windows' ? ['windows', 'linux'] : [goos]) {
  const rows = run('go', ['list', '-deps', '-f', '{{with .Module}}{{if not .Main}}{{.Path}}|{{.Version}}|{{.Dir}}{{end}}{{end}}', '.'], { env: { ...process.env, GOOS: system, GOARCH: target.goarch, CGO_ENABLED: '0' } });
  for (const row of rows.split('\n').filter(Boolean)) modules.add(row);
}
for (const row of [...modules].sort()) {
  const [name, version, directory] = row.split('|');
  if (!directory) throw new Error(`Missing module source for ${name}; run go mod download`);
  add(`${name} ${version}`, directory);
}
const metadata = JSON.parse(run('cargo', ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--format-version', '1', '--filter-platform', triple]));
const active = new Set(metadata.resolve.nodes.map(node => node.id));
for (const pkg of metadata.packages.filter(pkg => pkg.source && active.has(pkg.id)).sort((a, b) => a.name.localeCompare(b.name))) {
  add(`${pkg.name} ${pkg.version}`, path.dirname(pkg.manifest_path), pkg.license, pkg.license_file, overrides[`${pkg.name}@${pkg.version}`]);
}
const output = path.join(root, 'src-tauri/notices');
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'THIRD-PARTY-NOTICES.txt'), sections.join(''));
console.log('Prepared frontend, Go and Rust third-party license notices');
