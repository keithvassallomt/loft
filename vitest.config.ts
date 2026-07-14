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
// `globals: true` injects describe/it/expect/beforeEach as true globals suite-wide —
// required because @testing-library/svelte gates its auto-cleanup on a global `beforeEach`;
// the other test files already import these explicitly, so the injected globals are just
// unused shadow bindings there.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ['browser'],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
});
