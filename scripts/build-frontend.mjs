import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { build as buildModule, context } from 'esbuild';

const watch = process.argv.includes('--watch');

// Go embeds these files, so every binary build must compile the UI first.
await build({ root: fileURLToPath(new URL('../', import.meta.url)), ...(watch ? { build: { watch: {}, emptyOutDir: false } } : {}) });

// Keep Shiki language/theme chunks out of the initial workspace bundle. All
// assets are local and embedded by Go; the viewer loads only when opened.
const viewerOptions = {
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: { 'file-display': 'frontend/workspace/file-display.ts' },
  outdir: 'web/ui/files', bundle: true, splitting: true, format: 'esm',
  target: ['es2022'], minify: true, legalComments: 'linked',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
};
if (watch) {
  const viewer = await context(viewerOptions);
  await viewer.watch();
} else {
  await buildModule(viewerOptions);
}

const tabbarOptions = {
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['frontend/workspace/tabbar.tsx'],
  outfile: 'web/ui/workspace-tabs.js', bundle: true, format: 'iife',
  globalName: 'WorkHubTabbar', target: ['es2022'], jsx: 'automatic',
  minify: true, legalComments: 'linked',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
};
if (watch) {
  const tabbar = await context(tabbarOptions);
  await tabbar.watch();
} else {
  await buildModule(tabbarOptions);
}
