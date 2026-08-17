/**
 * Real-API e2e (plan §5.6), runnable directly via `pnpm e2e:real` (the
 * repo-level wrapper spawns this file) or `pnpm exec tsx packages/dsh-tool-retry/tests/e2e-real.ts`.
 * One native and one PTC session over the published DeepSeek provider
 * adapter, entirely on public npm deps — no harness checkout involved.
 * Auto-skips (exit 0) when DEEPSEEK_API_KEY is absent; the commit gate never
 * runs it with a key.
 *
 * Each arm boots the real agent loop, lets the model make a failing
 * long-argument call, and verifies the PLUGIN MECHANISM from the persisted
 * session: the checkpoint store (by-id + previous/ + history.jsonl) and the
 * failure notice after the tool result. Whether the model actually adopted
 * the replay path (editPreviousToolCalling in native mode; a checkpoint
 * read + AsyncFunction re-run in code mode) is reported, not gated.
 *
 * Env: DEEPSEEK_API_KEY (required to run; absent = skip),
 *      DSH_E2E_MODEL (default deepseek-v4-flash),
 *      DSH_E2E_TIMEOUT_MS (per-arm deadline, default 15 min).
 */

import { rmSync } from 'node:fs'
import { runRealArm } from './support/real-e2e-runner.ts'

const MODEL = process.env.DSH_E2E_MODEL ?? 'deepseek-v4-flash'
const DEADLINE_MS = Number(process.env.DSH_E2E_TIMEOUT_MS ?? 15 * 60 * 1000)

// Provider-key gate: absent key = clean skip (the plan's auto-skip contract).
if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY.trim() === '') {
  console.log('e2e:real SKIPPED — DEEPSEEK_API_KEY is not set (provider-key gated, not part of the commit gate)')
  process.exit(0)
}

const native = await runRealArm({
  mode: 'native',
  sessionId: 'e2e-real-native',
  model: MODEL,
  deadlineMs: DEADLINE_MS,
  deployCalls: [],
  task:
    'Call the `deploy` tool once with config.kind set to "invalid" and a long multi-line template string '
    + 'inside config.template. The call will fail and the harness will save your arguments, then show you '
    + 'a notice with the call id. Apply the SMALLEST fix to the saved call and replay it in ONE '
    + 'editPreviousToolCalling call using that call id (change only config.kind to "valid"). Do not '
    + 'regenerate the whole arguments.',
})
rmSync(native.workspace, { recursive: true, force: true })

const ptc = await runRealArm({
  mode: 'code',
  sessionId: 'e2e-real-ptc',
  model: MODEL,
  deadlineMs: DEADLINE_MS,
  boomCalls: [],
  task:
    'In one run_code program, call tools.boom({ value: "v1-marker" }) and return its value. The program '
    + 'will fail and the harness will save the whole program, then show you a notice with the checkpoint '
    + 'path. In a NEW run_code program apply a small correction: read the saved checkpoint at the path '
    + 'from the notice with tools.read, JSON.parse it, replace the fragment "v1-" + "marker" with '
    + '"v2-good" on the parsed program text, then run the corrected program through the AsyncFunction '
    + 'constructor and return its value. Do not rewrite the program from scratch.',
})
rmSync(ptc.workspace, { recursive: true, force: true })

console.log(JSON.stringify({ model: MODEL, results: [native, ptc] }, null, 2))
// Mechanism failure is a hard error; model adoption is a reported observation.
const mechanismHeld = [native, ptc].every(result => result.checkpointed && result.noticeIds.length > 0)
process.exit(mechanismHeld ? 0 : 1)
