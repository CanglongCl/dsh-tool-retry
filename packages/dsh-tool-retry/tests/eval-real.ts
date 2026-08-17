/**
 * Real-model evaluation (plan §6), runnable via `pnpm eval:real` (the
 * repo-level wrapper spawns this file) or `pnpm exec tsx
 * packages/dsh-tool-retry/tests/eval-real.ts`. Auto-skips (exit 0) when no
 * DEEPSEEK_API_KEY resolves from the layered credential chain (process env →
 * repository .env → ~/.dsh/.env).
 *
 * For every breakpoint fixture (eval-fixtures/) × arm (ON/OFF) × N repeats,
 * the runner resumes the recorded prefix through the published persistence
 * backend and lets the real model continue from the breakpoint. Each run
 * appends one record to .artifacts/eval/results.jsonl and the batch identity
 * (stamp, model, git head, package versions) to .artifacts/eval/batch.json —
 * the input of `pnpm eval:report`, which renders the persistent HTML report.
 *
 * Env: DEEPSEEK_API_KEY (resolved through the layered chain; absent = skip),
 *      DSH_EVAL_MODEL (default deepseek-v4-flash),
 *      DSH_EVAL_REASONING (default high; off|high|max),
 *      DSH_EVAL_STOP_AT (default retry-success; idle = full convergence),
 *      DSH_EVAL_REPEATS (default 1; also --repeat N),
 *      DSH_EVAL_CONCURRENCY (default 4; also --concurrency N),
 *      DSH_EVAL_TIMEOUT_MS (per-arm deadline, default 15 min).
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from './support/credential-env.ts'
import { loadEvalFixture, runEvalScenario, type EvalRunSummary } from './support/real-eval-runner.ts'

const EVAL_FIXTURES = fileURLToPath(new URL('./eval-fixtures', import.meta.url))
const OUT_DIR = fileURLToPath(new URL('../../../.artifacts/eval', import.meta.url))
const MODEL = process.env.DSH_EVAL_MODEL ?? 'deepseek-v4-flash'
const REASONING = (process.env.DSH_EVAL_REASONING ?? 'high') as 'off' | 'high' | 'max'
if (!['off', 'high', 'max'].includes(REASONING)) {
  console.error(`eval:real — DSH_EVAL_REASONING must be off|high|max, got ${JSON.stringify(REASONING)}`)
  process.exit(1)
}
function flagValue(name: string, envDefault: string): string {
  const argv = process.argv.slice(2)
  const index = argv.indexOf(`--${name}`)
  return index === -1 || argv[index + 1] === undefined ? envDefault : argv[index + 1]!
}
const STOP_AT = (process.env.DSH_EVAL_STOP_AT ?? 'retry-success')
if (STOP_AT !== 'idle' && STOP_AT !== 'retry-success') {
  console.error(`eval:real — DSH_EVAL_STOP_AT must be idle|retry-success, got ${JSON.stringify(STOP_AT)}`)
  process.exit(1)
}
// web-review parity: runs are configurable, 1 repeat per scenario by default,
// and the queue drains over a bounded worker pool (DSH_EVAL_CONCURRENCY).
const REPEATS = Number(flagValue('repeat', process.env.DSH_EVAL_REPEATS ?? '1'))
const CONCURRENCY = Number(flagValue('concurrency', process.env.DSH_EVAL_CONCURRENCY ?? '4'))
if (!Number.isInteger(REPEATS) || REPEATS < 1 || !Number.isInteger(CONCURRENCY) || CONCURRENCY < 1) {
  console.error(`eval:real — --repeat/--concurrency (or DSH_EVAL_REPEATS/DSH_EVAL_CONCURRENCY) must be positive integers, got ${JSON.stringify({ repeat: REPEATS, concurrency: CONCURRENCY })}`)
  process.exit(1)
}
const DEADLINE_MS = Number(process.env.DSH_EVAL_TIMEOUT_MS ?? 15 * 60 * 1000)

// Provider-key gate over the layered credential chain (nothing is printed).
if (!loadLayeredEnv()) {
  console.log('eval:real SKIPPED — DEEPSEEK_API_KEY resolves nowhere (process env, repo .env, ~/.dsh/.env); provider-key gated, not part of the commit gate')
  process.exit(0)
}

/** Best-effort repository HEAD (committed metadata for the report). */
function repoHead(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

/** Installed published-package versions the runtime resolved against. */
function packageVersions(): Record<string, string> {
  const names = [
    '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-session-persistence-jsonl',
  ]
  const versions: Record<string, string> = {}
  for (const name of names) {
    try {
      // The published deps live in the plugin package's node_modules (they
      // are its pinned devDependencies, not the repo root's).
      const manifest = JSON.parse(readFileSync(
        fileURLToPath(new URL(`../../node_modules/${name}/package.json`, import.meta.url)), 'utf8')) as { version?: string }
      versions[name] = manifest.version ?? 'unknown'
    } catch {
      versions[name] = 'unknown'
    }
  }
  return versions
}

const scenarios = readdirSync(EVAL_FIXTURES, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort()

interface RunRecord {
  stamp: string
  scenario: string
  arm: 'on' | 'off'
  mode: 'native' | 'code'
  repetition: number
  model: string
  provider: string
  reasoning: string
  /** Per-run artifact dir relative to .artifacts/eval (full session.jsonl). */
  runDir: string
  startedAt: string
  finishedAt: string
  summary: EvalRunSummary
}

interface BatchMeta {
  stamp: string
  model: string
  provider: string
  reasoning: string
  stopAt: string
  repeats: number
  repoHead: string
  packages: Record<string, string>
  startedAt: string
  finishedAt: string
  scenarios: string[]
}

interface ScenarioReport {
  scenario: string
  mode: 'native' | 'code'
  model: string
  repeats: number
  arms: {
    on: EvalRunSummary[]
    off: EvalRunSummary[]
  }
  medians: {
    onRetryStepOutputTokens: number
    offRetryStepOutputTokens: number
    tokenSavingsPercent: number
    onAdoptionRate: number
    onRetrySuccessRate: number
    offRetrySuccessRate: number
    noticeCount: number
    noticeBytes: number
  }
}

mkdirSync(OUT_DIR, { recursive: true })
const stamp = new Date().toISOString().replaceAll(':', '-')
const batchStarted = new Date().toISOString()
const records: RunRecord[] = []
const reports: ScenarioReport[] = []

// One queued unit of work: a scenario × arm × repetition triple.
interface Queued {
  name: string
  arm: 'on' | 'off'
  rep: number
}
const queue: Queued[] = scenarios.flatMap(name =>
  (['on', 'off'] as const).flatMap(arm =>
    Array.from({ length: REPEATS }, (_, index) => ({ name, arm, rep: index + 1 }))))
console.log(`eval:real ${queue.length} run(s) queued, ${CONCURRENCY} concurrent`)

// Bounded worker pool over a shared cursor (the dsh-web-review batch
// pattern): each worker claims the next unit until the queue drains. Every
// run owns an independent temp root, a suffixed session id, and its own
// checkpoint dir, so same-scenario runs execute safely in parallel.
let cursor = 0
const workers = Array.from({ length: CONCURRENCY }, async () => {
  while (true) {
    const index = cursor
    cursor += 1
    const queued = queue[index]
    if (queued === undefined) return
    const { name, arm, rep } = queued
    const fixture = loadEvalFixture(join(EVAL_FIXTURES, name))
    const startedAt = new Date().toISOString()
    const runDir = join(OUT_DIR, 'runs', stamp, name, arm, `r${rep}`)
    const summary = await runEvalScenario({
      fixture, arm, model: MODEL, reasoningEffort: REASONING, deadlineMs: DEADLINE_MS,
      stopAt: STOP_AT, deployCalls: [], boomCalls: [], runDir,
      revision: { repetition: rep, repoHead: repoHead() },
      sessionIdSuffix: `-${arm}-r${rep}`,
    })
    const record: RunRecord = {
      stamp, scenario: name, arm, mode: fixture.mode, repetition: rep, model: MODEL, provider: 'deepseek-official',
      reasoning: REASONING, runDir: join('runs', stamp, name, arm, `r${rep}`),
      startedAt, finishedAt: new Date().toISOString(), summary,
    }
    records.push(record)
    writeFileSync(join(runDir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`)
    appendFileSync(join(OUT_DIR, 'results.jsonl'), `${JSON.stringify(record)}\n`)
    console.log(`eval:real ${name} arm=${arm} repeat=${rep}/${REPEATS} done (${summary.status})`)
  }
})
await Promise.all(workers)

for (const name of scenarios) {
  const fixture = loadEvalFixture(join(EVAL_FIXTURES, name))
  const on = records.filter(record => record.scenario === name && record.arm === 'on').map(record => record.summary)
  const off = records.filter(record => record.scenario === name && record.arm === 'off').map(record => record.summary)
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)] ?? 0
  }
  const onTokens = median(on.map(run => run.retryStepOutputTokens))
  const offTokens = median(off.map(run => run.retryStepOutputTokens))
  reports.push({
    scenario: name,
    mode: fixture.mode,
    model: MODEL,
    repeats: REPEATS,
    arms: { on, off },
    medians: {
      onRetryStepOutputTokens: onTokens,
      offRetryStepOutputTokens: offTokens,
      tokenSavingsPercent: offTokens > 0 ? Math.round((1 - onTokens / offTokens) * 1000) / 10 : 0,
      onAdoptionRate: on.filter(run => run.adopted).length / REPEATS,
      onRetrySuccessRate: on.filter(run => run.retrySuccess).length / REPEATS,
      offRetrySuccessRate: off.filter(run => run.retrySuccess).length / REPEATS,
      noticeCount: median(on.map(run => run.noticeCount)),
      noticeBytes: median(on.map(run => run.noticeBytes)),
    },
  })
}

// Durable inputs for the report generator: the batch identity with the
// metadata the HTML report records (per-run JSONL lines were appended live
// by the workers).
const batch: BatchMeta = {
  stamp,
  model: MODEL,
  provider: 'deepseek-official',
  reasoning: REASONING,
  stopAt: STOP_AT,
  repeats: REPEATS,
  repoHead: repoHead(),
  packages: packageVersions(),
  startedAt: batchStarted,
  finishedAt: new Date().toISOString(),
  scenarios,
}
writeFileSync(join(OUT_DIR, 'batch.json'), `${JSON.stringify(batch, null, 2)}\n`)

console.log('\n==== dsh-tool-retry real-model evaluation ====')
console.log(`model=${MODEL} reasoning=${REASONING} stopAt=${STOP_AT} repeats=${REPEATS} scenarios=${reports.length} repoHead=${batch.repoHead.slice(0, 12)}`)
for (const mode of ['native', 'code'] as const) {
  const group = reports.filter(report => report.mode === mode)
  if (group.length === 0) continue
  console.log(`\n[${mode}]`)
  console.log('scenario                  tokenSave%  adopt%  retryOK(on)  retryOK(off)  notices  noticeBytes')
  for (const report of group) {
    const m = report.medians
    console.log(
      `${report.scenario.padEnd(24)} ${String(m.tokenSavingsPercent).padStart(9)} `
      + `${String(Math.round(m.onAdoptionRate * 100)).padStart(6)} `
      + `${String(Math.round(m.onRetrySuccessRate * 100)).padStart(11)} `
      + `${String(Math.round(m.offRetrySuccessRate * 100)).padStart(12)} `
      + `${String(m.noticeCount).padStart(7)} ${String(m.noticeBytes).padStart(11)}`,
    )
  }
}
console.log(`\nrecords: ${join(OUT_DIR, 'results.jsonl')} (stamp ${stamp})`)
console.log('next: pnpm eval:report')
// The eval reports model behavior; exit non-zero on runner-level failure
// (an errored run — provider rejections included — or a vacuous empty
// batch). Cutoff/timeout runs are observations either way.
if (reports.length === 0) {
  console.error('eval:real — batch produced ZERO run records; nothing to report (check --repeat/--concurrency and the scenario list)')
  process.exit(1)
}
const errored = reports.flatMap(report => [...report.arms.on, ...report.arms.off])
  .filter(run => run.status === 'error')
if (errored.length > 0) {
  for (const run of errored) console.error(`eval:real — errored run: ${run.scenario}/${run.arm} (${run.status})`)
  process.exit(1)
}
process.exit(0)
