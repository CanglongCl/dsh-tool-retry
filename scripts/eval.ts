/**
 * Repo-level wrapper for the real-harness evaluation: spawns the harness-eval
 * orchestrator (scripts/eval-harness.ts) — the REAL DSH CLI runs each break
 * point resume (the dsh-web-review runner contract). Auto-skips without a
 * key; DSH_HARNESS is required for the child CLI.
 *
 * Usage: DSH_HARNESS=<harness> pnpm eval:real [--repeat N] [--concurrency N]
 *        [--scenario name] [--arm on|off] [--mode native|code]
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
for (const variable of ['DSH_EVAL_REPEATS', 'DSH_EVAL_CONCURRENCY', 'DSH_EVAL_TIMEOUT_MS']) {
  const value = process.env[variable]
  if (value !== undefined && value.trim() !== '' && (!/^\d+$/u.test(value.trim()) || Number(value.trim()) < 1)) {
    console.error(`eval:real — ${variable}=${JSON.stringify(value)} is not a positive integer`)
    process.exit(1)
  }
}
const result = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'scripts', 'eval-harness.ts'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
