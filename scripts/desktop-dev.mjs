import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Keep the bundled startup page: the business UI comes from Go, and the window
// intentionally does not allow navigation to an unrelated Vite/static dev port.
const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
const child = spawn(process.execPath, [cli, 'dev', '--no-dev-server', '--', '--', ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
