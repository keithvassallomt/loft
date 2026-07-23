import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';

// Renderer-only Vite build. base:'./' makes asset URLs relative so the bundle
// loads over file:// inside Electron. Main + preload stay on esbuild/tsc.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer/hub'),
  base: './',
  define: {
    __LOFT_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0-dev'),
  },
  // .mjs, not .js: package.json has no "type": "module" (main is CommonJS, and it must stay
  // that way — Electron would parse dist/main and the cjs-bundled preloads as ESM), so a .js
  // file holding ESM made Node re-parse it and warn MODULE_TYPELESS_PACKAGE_JSON on every
  // build and test run. The extension states the module type instead.
  plugins: [svelte({ configFile: resolve(__dirname, 'svelte.config.mjs') })],
  build: {
    outDir: resolve(__dirname, 'dist/renderer/hub'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'src/renderer/hub/index.html') },
  },
});
