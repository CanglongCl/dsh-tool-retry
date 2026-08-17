/**
 * Repo-level wrapper for the real-model evaluation (plan §6): spawns the
 * runner inside the plugin package (its `@deepseek-ai/*` imports resolve
 * through the package's pinned devDependencies). Auto-skips without a key.
 *
 * Usage: DEEPSEEK_API_KEY=... pnpm eval:real [--repeat N] [--concurrency N]
 * (extra argv is forwarded to the runner; a non-numeric/empty env value is a
 * hard error, never a vacuous zero-run success).
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const runner = join(root, 'packages', 'dsh-tool-retry', 'tests', 'eval-real.ts')
for (const variable of ['DSH_EVAL_REPEATS', 'DSH_EVAL_CONCURRENCY']) {
  const value = process.env[variable]
  if (value !== undefined && value.trim() !== '' && (!/^\d+$/u.test(value.trim()) || Number(value.trim()) < 1)) {
    console.error(`eval:real — ${variable}=${JSON.stringify(value)} is not a positive integer`)
    process.exit(1)
  }
}
const result = spawnSync('pnpm', ['exec', 'tsx', runner, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)
