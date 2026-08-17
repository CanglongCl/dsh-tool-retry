/**
 * Repo-level wrapper for the real-model evaluation (plan §6): spawns the
 * runner inside the plugin package (its `@deepseek-ai/*` imports resolve
 * through the package's pinned devDependencies). Auto-skips without a key.
 *
 * Usage: DEEPSEEK_API_KEY=... pnpm eval:real
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const runner = join(root, 'packages', 'dsh-tool-retry', 'tests', 'eval-real.ts')
const result = spawnSync('pnpm', ['exec', 'tsx', runner], { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)
