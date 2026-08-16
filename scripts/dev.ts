/**
 * One-command dev: prepare the harness checkout once, regenerate the launch
 * overlay, then run the built CLI (Web profile) with this package linked into
 * the profile. The plugin is node-only, so there is no client bundle watch:
 * node-half changes take effect on the next Web process restart.
 *
 * Usage:
 *   pnpm dev                 — full dev loop (web)
 *   pnpm dev -- --setup-only — harness prep only (install + build)
 * Env: DSH_HARNESS (required absolute checkout), DSH_WEB_PORT (default 3090),
 *      DSH_WEB_HOST (default 127.0.0.1).
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { harnessWebLaunch } from './harness-cli.ts'
import { resolveHarnessRoot } from './harness-path.ts'
import { materializeProfilePluginLink } from './profile-plugin-link.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = resolveHarnessRoot()
const port = process.env.DSH_WEB_PORT ?? '3090'
const host = process.env.DSH_WEB_HOST ?? '127.0.0.1'
const setupOnly = process.argv.includes('--setup-only')
const buildStampPath = join(root, '.artifacts', 'harness-build.json')
const dshHome = process.env.DSH_HOME?.trim() === '' || process.env.DSH_HOME === undefined
  ? join(homedir(), '.dsh')
  : process.env.DSH_HOME

/** Exact Harness commit whose generated artifacts must match this checkout. */
function harnessHead(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: harness, encoding: 'utf8' })
  if (result.status !== 0 || result.stdout.trim() === '') {
    throw new Error(`dev: cannot resolve Harness HEAD at ${harness}: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

const head = harnessHead()

/** Harness readiness: current-commit stamp plus the built CLI artifact. */
function harnessReady(): boolean {
  let stamp: { harness?: string; head?: string } = {}
  try {
    stamp = JSON.parse(readFileSync(buildStampPath, 'utf8')) as typeof stamp
  } catch {
    return false
  }
  return stamp.harness === harness
    && stamp.head === head
    && existsSync(join(harness, 'node_modules'))
    && existsSync(join(harness, 'apps/cli/lib/bin.js'))
}

// 1. Generate the profile-local package alias overlay.
spawnSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/gen-config.ts')], { cwd: root, stdio: 'inherit' })

// 2. Commit-aware harness prep.
if (!harnessReady()) {
  console.log(`dev: Harness artifacts do not match ${head.slice(0, 12)} — installing and rebuilding`)
  for (const args of [['install', '--frozen-lockfile'], ['build']]) {
    const result = spawnSync('pnpm', args, { cwd: harness, stdio: 'inherit' })
    if (result.status !== 0) {
      console.error(`dev: harness step "pnpm ${args.join(' ')}" failed (status ${result.status})`)
      process.exit(1)
    }
  }
  mkdirSync(dirname(buildStampPath), { recursive: true })
  writeFileSync(buildStampPath, `${JSON.stringify({ harness, head }, null, 2)}\n`)
}
if (setupOnly) {
  console.log('dev: harness ready.')
  process.exit(0)
}

// 3. Build this plugin's node half before linking it.
const build = spawnSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
if (build.status !== 0) {
  console.error(`dev: plugin build failed (status ${build.status})`)
  process.exit(1)
}

const profileLink = materializeProfilePluginLink(root, dshHome)
console.log(`dev: source package linked at ${profileLink}`)

// 4. Built CLI with the plugin overlay; cwd = this repo so the session
// workspace root defaults to the user's project.
const launch = harnessWebLaunch(harness, join(root, 'cordis.yml'), host, port)
console.log(`dev: starting dsh web on http://${host}:${port} (cwd ${root})`)
const web = spawn(launch.command, launch.args, { cwd: root, stdio: 'inherit', env: launch.env })

let stopping = false
const stop = (): void => {
  stopping = true
  web.kill('SIGTERM')
}
web.once('error', (error) => {
  if (stopping) return
  console.error(`dev: dsh web failed to start: ${String(error)}`)
  stop()
  process.exitCode = 1
})
web.once('exit', (code, signal) => {
  if (stopping) return
  console.error(`dev: dsh web exited unexpectedly (${signal ?? `status ${code ?? 'unknown'}`})`)
  stop()
  process.exitCode = code === null || code === 0 ? 1 : code
})
process.on('SIGINT', () => { stop(); process.exit(130) })
process.on('SIGTERM', () => { stop(); process.exit(0) })
