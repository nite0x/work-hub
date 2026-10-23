import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// Go embeds these files, so every binary build must compile the UI first.
await build({ root: fileURLToPath(new URL('../', import.meta.url)) });
