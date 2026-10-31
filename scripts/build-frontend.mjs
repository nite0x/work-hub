import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { build as buildModule, context } from 'esbuild';

const watch = process.argv.includes('--watch');

// Go embeds these files, so every binary build must compile the UI first.
await build({ root: fileURLToPath(new URL('../', import.meta.url)), ...(watch ? { build: { watch: {}, emptyOutDir: false } } : {}) });

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
