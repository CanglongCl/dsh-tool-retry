/**
 * Child-process eval runner (dsh-web-review batch pattern): ONE run per
 * process, spawned by the eval:real parent pool. The record JSON goes to
 * stdout (the parent appends it to results.jsonl); progress/status goes to
 * stderr. Environment carries the run identity and model options.
 *
 * Usage (internal): node --import tsx eval-run.ts
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { loadEvalFixture, runEvalScenario } from './support/real-eval-runner.ts'

const EVAL_FIXTURES = fileURLToPath(new URL('./eval-fixtures', import.meta.url))

const SCENARIO = process.env.DSH_EVAL_CHILD_SCENARIO ?? ''
const ARM = process.env.DSH_EVAL_CHILD_ARM as 'on' | 'off' | undefined
const REP = Number(process.env.DSH_EVAL_CHILD_REP ?? '1')
const MODEL = process.env.DSH_EVAL_CHILD_MODEL ?? 'deepseek-v4-flash'
const REASONING = (process.env.DSH_EVAL_CHILD_REASONING ?? 'high') as 'off' | 'high' | 'max'
const STOP_AT = (process.env.DSH_EVAL_CHILD_STOP_AT ?? 'retry-success') as 'idle' | 'retry-success'
const DEADLINE_MS = Number(process.env.DSH_EVAL_CHILD_DEADLINE_MS ?? 3 * 60 * 1000)
const STAMP = process.env.DSH_EVAL_CHILD_STAMP ?? 'unknown'
const REPO_HEAD = process.env.DSH_EVAL_CHILD_REPO_HEAD ?? 'unknown'
const RUN_DIR = process.env.DSH_EVAL_CHILD_RUN_DIR ?? ''

if (SCENARIO === '' || ARM === undefined || (ARM !== 'on' && ARM !== 'off')) {
  console.error('eval-run: DSH_EVAL_CHILD_SCENARIO/DSH_EVAL_CHILD_ARM are required')
  process.exit(2)
}

const fixture = loadEvalFixture(join(EVAL_FIXTURES, SCENARIO))
const startedAt = new Date().toISOString()
const summary = await runEvalScenario({
  fixture,
  arm: ARM,
  model: MODEL,
  reasoningEffort: REASONING,
  deadlineMs: DEADLINE_MS,
  stopAt: STOP_AT,
  deployCalls: [],
  boomCalls: [],
  runDir: RUN_DIR,
  revision: { repetition: REP, repoHead: REPO_HEAD },
  sessionIdSuffix: `-${ARM}-r${REP}`,
})
const record = {
  stamp: STAMP,
  scenario: SCENARIO,
  arm: ARM,
  mode: fixture.mode,
  repetition: REP,
  model: MODEL,
  provider: 'deepseek-official',
  reasoning: REASONING,
  // RELATIVE to .artifacts/eval — the report generator joins it against
  // EVAL_DIR (an absolute runDir would survive path.join and point at a
  // nonexistent path; the absolute form only serves the write below).
  runDir: join('runs', STAMP, SCENARIO, ARM, `r${REP}`),
  startedAt,
  finishedAt: new Date().toISOString(),
  summary,
}
if (RUN_DIR !== '') {
  writeFileSync(join(RUN_DIR, 'record.json'), `${JSON.stringify(record, null, 2)}\n`)
}
console.error(`eval:real ${SCENARIO} arm=${ARM} repeat=${REP} done (${summary.status})`)
console.log(JSON.stringify(record))
