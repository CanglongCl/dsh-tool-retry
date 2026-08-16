/**
 * One-shot self-test launch: run one task through the built CLI's `headless`
 * profile (fresh persisted session, final answer on stdout, exit) with this
 * plugin mounted via the `--patch` overlay and linked into the profile.
 *
 * Usage:
 *   pnpm dev:headless -- "make a tool call, then a failing one"
 * Env: DSH_HARNESS (required absolute checkout), DSH_HOME (default ~/.dsh).
 */
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { harnessHeadlessLaunch } from './harness-cli.ts'
import { resolveHarnessRoot } from './harness-path.ts'
import { materializeProfilePluginLink } from './profile-plugin-link.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = resolveHarnessRoot()
const taskArgs = process.argv.slice(2).filter(argument => argument !== '--')
const task = taskArgs.join(' ').trim()
if (task === '') {
  console.error('dev-headless: pass the one-shot task after `--`')
  process.exit(1)
}
const dshHome = process.env.DSH_HOME?.trim() === '' || process.env.DSH_HOME === undefined
  ? join(homedir(), '.dsh')
  : process.env.DSH_HOME

// 1. Overlay + plugin build.
spawnSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/gen-config.ts')], { cwd: root, stdio: 'inherit' })
const build = spawnSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
if (build.status !== 0) {
  console.error(`dev-headless: plugin build failed (status ${build.status})`)
  process.exit(1)
}

// 2. Development alias inside the headless profile.
const profileLink = materializeProfilePluginLink(root, dshHome, 'headless')
console.log(`dev-headless: source package linked at ${profileLink}`)

// 3. One-shot run (inherits stdout/exit code).
const launch = harnessHeadlessLaunch(harness, join(root, 'cordis.yml'), task)
console.log(`dev-headless: running task via dsh --profile headless (cwd ${root})`)
const run = spawnSync(launch.command, launch.args, { cwd: root, stdio: 'inherit', env: launch.env })
process.exit(run.status ?? 1)
