import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

/**
 * Test config: node environment for the whole suite. Unit tests run the
 * plugin over a FakeFs + a real Cordis context; the integration spec drives a
 * real agent loop with a scripted mock adapter and the local filesystem.
 * Source imports carry explicit `.ts` extensions (tsdown contract), so the
 * paths plugin resolves them like the harness's own vitest setup does.
 */
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    environment: 'node',
    include: ['packages/*/tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**'],
  },
})
