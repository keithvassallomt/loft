import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Add the Svelte plugin so `.svelte` imports compile under Vitest. Env stays 'node'
// for the whole suite; the one component test opts into jsdom via its first-line
// `// @vitest-environment jsdom` docblock (environmentMatchGlobs was removed in Vitest 4).
//
// `resolve.conditions: ['browser']` is required so Vite picks svelte's client build
// (index-client.js) instead of the default server/SSR build (index-server.js) — without
// it, `mount()` throws `lifecycle_function_unavailable` under Vitest. This is the standard
// fix documented by @testing-library/svelte for Vitest + Svelte 5.
//
// `globals: true` lets @testing-library/svelte's own auto-cleanup (it feature-detects a
// global `beforeEach`/`afterEach`) register itself when serviceRow.test.ts imports render();
// without it, DOM from one `it()` leaks into the next. Scoped per test file by Vitest's
// module isolation, so it has no effect on the other (non-Svelte) test files.
export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: {
    conditions: ['browser'],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
});
