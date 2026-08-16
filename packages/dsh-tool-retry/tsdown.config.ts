/**
 * tsdown config for the dsh-tool-retry node-only package.
 *
 * Node half: bundles `src/index.ts` into lib/index.js (self-contained ESM —
 * every @deepseek-ai import is inlined, so the Loader can import the package
 * from outside the harness without a local node_modules). The post-build gate
 * rejects any surviving bare import.
 */
import type { UserConfig } from 'tsdown'

export default [
  {
    entry: ['src/index.ts'],
    tsconfig: 'tsconfig.node.json',
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
    deps: {
      // The Loader artifact is intentionally self-contained: DSH helpers and
      // their dependency graph are all inlined.
      alwaysBundle: () => true,
      onlyBundle: false,
    },
  },
] satisfies UserConfig[]
