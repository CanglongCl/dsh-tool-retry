/**
 * Real-harness evaluation (plan §6, harness-eval architecture): every run
 * stages the real repository, seeds the verbatim breakpoint prefix into a
 * disposable session store, and spawns the REAL DSH CLI headless with a
 * per-run overlay (the dsh-web-review contract) whose eval-driver plugin
 * RESUMES the seeded session, wakes it neutrally, and reports the turn
 * outcome. The parent harvests the durable session log, grades the retry
 * behaviorally, and appends the record — ON/OFF arms differ only by the
 * tool-retry plugin row (its notice channel included).
 *
 * Env: DEEPSEEK_API_KEY (layered chain; absent = skip), DSH_HARNESS (the
 * checkout whose CLI runs each child), DSH_EVAL_REPEATS/--repeat (1),
 * DSH_EVAL_CONCURRENCY/--concurrency (6), DSH_EVAL_TIMEOUT_MS (3 min).
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// Layered credential chain (process env → repo .env → ~/.dsh/.env); the key
// is inherited by every child CLI process and never printed.
function loadLayeredEnv(): boolean {
  if ((process.env.DEEPSEEK_API_KEY ?? '').trim() !== '') return true
  for (const path of [join(ROOT, '.env'), join(homedir(), '.dsh', '.env')]) {
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const match = /^DEEPSEEK_API_KEY\s*=\s*(.*)$/u.exec(line.trim())
        if (match !== null && match[1] !== undefined && match[1].trim() !== '') {
          process.env.DEEPSEEK_API_KEY = match[1].replace(/^['"]|['"]$/gu, '').trim()
          return true
        }
      }
    } catch { /* next layer */ }
  }
  return false
}
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
import {
  DRIVER_ALIAS,
  DRIVER_PKG,
  EVAL_FIXTURES,
  OUT_DIR,
  PLUGIN_ALIAS,
  PLUGIN_PKG,
  buildSummary,
  collectArtifacts,
  loadScenario,
  revisionsFor,
  seedCheckpoints,
  seedSession,
  spawnRun,
  stageWorkspace,
  writeOverlay,
  type LoadedScenario,
} from './eval-harness-support.ts'

const MODES = ['native', 'code'] as const
const ARMS = ['on', 'off'] as const

function flagValue(name: string, envDefault: string): string {
  const argv = process.argv.slice(2)
  const index = argv.indexOf(`--${name}`)
  return index === -1 || argv[index + 1] === undefined ? envDefault : argv[index + 1]!
}
const REPEATS = Number(flagValue('repeat', process.env.DSH_EVAL_REPEATS ?? '1'))
const CONCURRENCY = Number(flagValue('concurrency', process.env.DSH_EVAL_CONCURRENCY ?? '6'))
// Reasoning effort override: the REAL sessions used max, but the eval runs
// at high (the real value stays recorded per scenario as the fidelity
// reference); DSH_EVAL_REASONING overrides.
const REASONING = (process.env.DSH_EVAL_REASONING ?? 'high') as 'off' | 'high' | 'max'
// Stop-at cuts successful retries in a few steps; the deadline only guards
// wandering/failed retries (a few slow max-reasoning steps).
const DEADLINE_MS = Number(process.env.DSH_EVAL_TIMEOUT_MS ?? 4 * 60 * 1000)
if (!Number.isInteger(REPEATS) || REPEATS < 1 || !Number.isInteger(CONCURRENCY) || CONCURRENCY < 1) {
  console.error('eval:real — --repeat/--concurrency must be positive integers')
  process.exit(1)
}

function resolveHarnessCli(): string {
  const root = process.env.DSH_HARNESS?.trim()
  if (root === undefined || root === '') {
    throw new Error('eval:real — DSH_HARNESS is required (the checkout whose CLI runs each child)')
  }
  const cli = join(root, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(cli)) throw new Error(`eval:real — harness CLI artifact missing: ${cli}`)
  return cli
}
function repoHead(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

// Provider-key gate over the layered credential chain (nothing is printed).
if (!loadLayeredEnv()) {
  console.log('eval:real SKIPPED — DEEPSEEK_API_KEY resolves nowhere; provider-key gated, not part of the commit gate')
  process.exit(0)
}

const scenarioFilter = flagValue('scenario', '')
const armFilter = flagValue('arm', '')
const modeFilter = flagValue('mode', '')
const scenarios = readdirSync(EVAL_FIXTURES, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .filter(name => scenarioFilter === '' || name === scenarioFilter)
  .sort()
const loadedByName = new Map<string, LoadedScenario>(
  scenarios.map(name => [name, loadScenario(join(EVAL_FIXTURES, name))]))

// Both packages must be built (self-contained libs the child loads).
for (const pkg of [DRIVER_PKG, PLUGIN_PKG]) {
  if (!existsSync(join(pkg, 'lib', 'index.js'))) {
    throw new Error(`eval:real — ${pkg} is not built; run pnpm build first`)
  }
}

const stamp = new Date().toISOString().replaceAll(':', '-')
const batchStarted = new Date().toISOString()
const records: Record<string, unknown>[] = []
const FAILURES: string[] = []

interface Queued {
  name: string
  mode: 'native' | 'code'
  arm: 'on' | 'off'
  rep: number
}
const baseQueue: Queued[] = scenarios.flatMap(name =>
  MODES.filter(mode => modeFilter === '' || mode === modeFilter).flatMap(mode =>
    ARMS.filter(arm => armFilter === '' || arm === armFilter).flatMap(arm =>
      Array.from({ length: REPEATS }, (_, index) => ({ name, mode, arm, rep: index + 1 })))))
// web-review batch parity: a re-run skips records whose immutable experiment
// identity already completed (results.jsonl accumulates across batches).
const finishedExperiments = new Set<string>()
try {
  for (const line of readFileSync(join(OUT_DIR, 'results.jsonl'), 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const record = JSON.parse(line) as { summary?: { status?: string; revisions?: { experiment?: string } } }
    if (record.summary?.status === 'completed' || record.summary?.status === 'cutoff') {
      const id = record.summary.revisions?.experiment
      if (id !== undefined) finishedExperiments.add(id)
    }
  }
} catch { /* no prior results */ }
const queue = baseQueue.filter((queued) => {
  const loaded = loadedByName.get(queued.name)!
  const id = revisionsFor(loaded, queued.mode, queued.arm, REASONING, queued.rep, repoHead()).experiment
  return !finishedExperiments.has(id)
})
console.log(`eval:real ${queue.length} run(s) queued (${baseQueue.length - queue.length} already finished), ${CONCURRENCY} concurrent, harness ${process.env.DSH_HARNESS}`)

interface RunRecord {
  record: Record<string, unknown>
  status: string
}

function runOne(queued: Queued): Promise<RunRecord> {
  const { name, mode, arm, rep } = queued
  const loaded = loadedByName.get(name)!
  const scenario = loaded.scenario
  const model = scenario.model ?? { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: REASONING }
  const sessionId = `${name}-${mode}-${arm}-r${rep}`
  const startedAt = new Date().toISOString()
  const liveRoot = mkdtempSync(join(tmpdir(), 'dsh-tool-retry-eval-run-'))
  const workspaceDir = stageWorkspace(loaded)
  const sessionsRoot = join(liveRoot, 'sessions')
  const runDir = join(OUT_DIR, 'runs', stamp, name, mode, arm, `r${rep}`)
  seedSession(loaded, sessionsRoot, sessionId, workspaceDir)
  if (arm === 'on') seedCheckpoints(loaded, sessionId)
  const dshHome = join(liveRoot, 'dsh-home')
  mkdirSync(dshHome, { recursive: true })
  // Profile-local dev aliases (the same loading model as the dev profile).
  const aliasDir = join(dshHome, 'profiles', 'headless', 'node_modules')
  mkdirSync(dirname(join(aliasDir, ...DRIVER_ALIAS.split('/'))), { recursive: true })
  symlinkSync(DRIVER_PKG, join(aliasDir, ...DRIVER_ALIAS.split('/')), 'dir')
  if (arm === 'on') {
    mkdirSync(dirname(join(aliasDir, ...PLUGIN_ALIAS.split('/'))), { recursive: true })
    symlinkSync(PLUGIN_PKG, join(aliasDir, ...PLUGIN_ALIAS.split('/')), 'dir')
  }
  const wake = scenario.continuation.trim() === ''
    ? { kind: 'empty' as const }
    : { kind: 'user' as const, text: scenario.continuation }
  const overlayPath = writeOverlay(liveRoot, {
    sessionId, arm, mode, provider: model.provider, model: model.model,
    reasoningEffort: REASONING, wake,
    grader: { kind: scenario.kind, mode, checks: scenario.successChecks ?? [] },
  }, sessionsRoot)
  const bin = resolveHarnessCli()
  return spawnRun(bin, workspaceDir, overlayPath, dshHome, mode, DEADLINE_MS + 30_000).then((outcome) => {
    collectArtifacts(sessionsRoot, workspaceDir, sessionId, runDir)
    let status: 'completed' | 'cutoff' | 'timeout' | 'error' = 'completed'
    if (outcome.timedOut) status = 'timeout'
    else if (outcome.exitCode !== 0) status = 'error'
    else if (outcome.stdout.includes('STOP-AT-SUCCESS')) status = 'cutoff'
    const events = existsSync(join(runDir, 'session.jsonl'))
      ? readFileSync(join(runDir, 'session.jsonl'), 'utf8').split('\n').filter(line => line.trim() !== '')
        .map(line => JSON.parse(line) as never)
      : []
    const summary = buildSummary(loaded, mode, arm, sessionId, events, workspaceDir, status as 'completed' | 'timeout' | 'error', { repetition: rep, repoHead: repoHead() }, REASONING)
    if (outcome.exitCode !== 0 && outcome.exitCode !== null) {
      writeFileSync(join(runDir, 'stdout.txt'), outcome.stdout)
      writeFileSync(join(runDir, 'stderr.txt'), outcome.stderr)
    }
    const record = {
      stamp, scenario: name, arm, mode, repetition: rep,
      model: model.model, provider: model.provider, reasoning: REASONING,
      runDir: join('runs', stamp, name, mode, arm, `r${rep}`),
      startedAt, finishedAt: new Date().toISOString(), summary,
    }
    writeFileSync(join(runDir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`)
    rmSync(liveRoot, { recursive: true, force: true })
    return { record, status }
  }).catch((error: unknown): RunRecord => {
    const summary = buildSummary(loaded, mode, arm, sessionId, [], workspaceDir, 'error', { repetition: rep, repoHead: repoHead() }, REASONING)
    const record = {
      stamp, scenario: name, arm, mode, repetition: rep,
      model: model.model, provider: model.provider, reasoning: REASONING,
      runDir: join('runs', stamp, name, mode, arm, `r${rep}`),
      startedAt, finishedAt: new Date().toISOString(), summary,
    }
    writeFileSync(join(runDir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`)
    writeFileSync(join(runDir, 'stderr.txt'), `orchestration-error: ${String(error)}\n`)
    rmSync(liveRoot, { recursive: true, force: true })
    return { record, status: 'error' }
  })
}

let cursor = 0
const workers = Array.from({ length: CONCURRENCY }, async () => {
  while (true) {
    const index = cursor
    cursor += 1
    const queued = queue[index]
    if (queued === undefined) return
    const { name, mode, arm, rep } = queued
    let attempt = 0
    let outcome: RunRecord
    while (true) {
      attempt += 1
      outcome = await runOne(queued)
      if (outcome.status !== 'error' || attempt >= 2) break
      console.log(`eval:real ${name}/${mode} arm=${arm} repeat=${rep}/${REPEATS} attempt ${attempt} errored — retrying once`)
    }
    records.push(outcome.record)
    if (outcome.status === 'error') FAILURES.push(`${name}/${mode}/${arm}/r${rep}`)
    appendFileSync(join(OUT_DIR, 'results.jsonl'), `${JSON.stringify(outcome.record)}\n`)
    const s = outcome.record.summary as { status: string }
    console.log(`eval:real ${name}/${mode} arm=${arm} repeat=${rep}/${REPEATS} done (${s.status})`)
  }
})
await Promise.all(workers)

if (records.length === 0) {
  console.error('eval:real — batch produced ZERO run records; nothing to report')
  process.exit(1)
}
if (FAILURES.length > 0) {
  console.error(`eval:real — errored runs: ${FAILURES.join(', ')}`)
  process.exit(1)
}

writeFileSync(join(OUT_DIR, 'batch.json'), `${JSON.stringify({
  stamp,
  model: 'deepseek-v4-flash',
  provider: 'deepseek-official',
  reasoning: REASONING,
  stopAt: 'idle',
  repeats: REPEATS,
  repoHead: repoHead(),
  startedAt: batchStarted,
  finishedAt: new Date().toISOString(),
  scenarios,
  packages: {},
}, null, 2)}\n`)
console.log(`\nrecords: ${join(OUT_DIR, 'results.jsonl')} (stamp ${stamp})`)
console.log('next: pnpm eval:report')
process.exit(0)
