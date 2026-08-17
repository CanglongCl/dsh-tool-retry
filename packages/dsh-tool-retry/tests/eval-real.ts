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
 *      DSH_EVAL_REPEATS (default 3),
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
const REPEATS = Math.max(1, Number(process.env.DSH_EVAL_REPEATS ?? 3))
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
  startedAt: string
  finishedAt: string
  summary: EvalRunSummary
}

interface BatchMeta {
  stamp: string
  model: string
  provider: string
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

for (const name of scenarios) {
  const fixture = loadEvalFixture(join(EVAL_FIXTURES, name))
  const on: EvalRunSummary[] = []
  const off: EvalRunSummary[] = []
  for (let rep = 1; rep <= REPEATS; rep += 1) {
    console.log(`eval:real ${name} arm=on repeat=${rep}/${REPEATS} ...`)
    const startedAt = new Date().toISOString()
    const summary = await runEvalScenario({
      fixture, arm: 'on', model: MODEL, deadlineMs: DEADLINE_MS, deployCalls: [], boomCalls: [],
    })
    on.push(summary)
    records.push({ stamp, scenario: name, arm: 'on', mode: fixture.mode, repetition: rep, model: MODEL, provider: 'deepseek-official', startedAt, finishedAt: new Date().toISOString(), summary })
  }
  for (let rep = 1; rep <= REPEATS; rep += 1) {
    console.log(`eval:real ${name} arm=off repeat=${rep}/${REPEATS} ...`)
    const startedAt = new Date().toISOString()
    const summary = await runEvalScenario({
      fixture, arm: 'off', model: MODEL, deadlineMs: DEADLINE_MS, deployCalls: [], boomCalls: [],
    })
    off.push(summary)
    records.push({ stamp, scenario: name, arm: 'off', mode: fixture.mode, repetition: rep, model: MODEL, provider: 'deepseek-official', startedAt, finishedAt: new Date().toISOString(), summary })
  }
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

// Durable inputs for the report generator: one JSONL line per run + the batch
// identity with the metadata the HTML report records.
for (const record of records) {
  appendFileSync(join(OUT_DIR, 'results.jsonl'), `${JSON.stringify(record)}\n`)
}
const batch: BatchMeta = {
  stamp,
  model: MODEL,
  provider: 'deepseek-official',
  repeats: REPEATS,
  repoHead: repoHead(),
  packages: packageVersions(),
  startedAt: batchStarted,
  finishedAt: new Date().toISOString(),
  scenarios,
}
writeFileSync(join(OUT_DIR, 'batch.json'), `${JSON.stringify(batch, null, 2)}\n`)

console.log('\n==== dsh-tool-retry real-model evaluation ====')
console.log(`model=${MODEL} repeats=${REPEATS} scenarios=${reports.length} repoHead=${batch.repoHead.slice(0, 12)}`)
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
// The eval reports model behavior; exit non-zero only on runner-level failure
// (every run reached completion). Adoption/retry metrics are observations.
const allCompleted = reports.every(report => [...report.arms.on, ...report.arms.off].every(run => run.completed))
process.exit(allCompleted ? 0 : 1)
