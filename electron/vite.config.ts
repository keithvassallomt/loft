import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';

// Renderer-only Vite build. base:'./' makes asset URLs relative so the bundle
// loads over file:// inside Electron. Main + preload stay on esbuild/tsc.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer/hub'),
  base: './',
  plugins: [svelte({ configFile: resolve(__dirname, 'svelte.config.js') })],
  build: {
    outDir: resolve(__dirname, 'dist/renderer/hub'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'src/renderer/hub/index.html') },
  },
});
