/**
 * Keyless CLI smoke (the harness-eval gate): one REAL DSH CLI run through the
 * eval-driver plugin with a scripted mock adapter — proving resume + neutral
 * wake + harvest boundary + grading against the real harness composition
 * without any provider key. The scripted retry mirrors the real-session fix
 * for real-edit-stale (read, then two checkpoint edits re-pointing
 * old_string and swapping in the ground-truth fix).
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DRIVER_PKG,
  EVAL_FIXTURES,
  PLUGIN_PKG,
  computeRetrySuccess,
  loadScenario,
  seedCheckpoints,
  seedSession,
  sessionLogPath,
  spawnRun,
  stageWorkspace,
  writeOverlay,
  type RunRow,
} from './eval-harness-support.ts'

/** Scripted chunk builders (the same protocol the driver's MockAdapter consumes). */
function textResponse(text: string): Record<string, unknown>[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): Record<string, unknown> => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}
function toolCallResponse(id: string, name: string, args: Record<string, unknown>): Record<string, unknown>[] {
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id, argumentsDelta: argumentsJson.slice(5) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

const jsonEsc = (value: string): string => value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\n/gu, '\\n')

const loaded = loadScenario(join(EVAL_FIXTURES, 'real-edit-stale'))
const scenario = loaded.scenario
const block = scenario.blocks[0]!
const args = JSON.parse(block.rawArguments) as Record<string, unknown>
const fix = scenario.successChecks![0]!.fragment!
const fileFirstLine = scenario.workspaceFiles![0]!.content.split('\n')[0]!
const script = [
  toolCallResponse('sm_read', 'read', { file_path: 'src/abc_db/gen_protos.py' }),
  toolCallResponse('sm_edit1', 'editPreviousToolCalling', {
    call_id: block.callId,
    old_string: jsonEsc(String(args.old_string)),
    new_string: jsonEsc(fileFirstLine),
  }),
  toolCallResponse('sm_edit2', 'editPreviousToolCalling', {
    call_id: block.callId,
    old_string: jsonEsc(String(args.new_string)),
    new_string: jsonEsc(fix),
  }),
  textResponse('done'),
]

const sessionId = 'smoke-real-edit-stale-native-on-r1'
const liveRoot = mkdtempSync(join(tmpdir(), 'dsh-tool-retry-eval-smoke-'))
const workspaceDir = stageWorkspace(loaded)
const sessionsRoot = join(liveRoot, 'sessions')
seedSession(loaded, sessionsRoot, sessionId, workspaceDir)
seedCheckpoints(loaded, sessionId)
const dshHome = join(liveRoot, 'dsh-home')
const { mkdirSync, symlinkSync } = await import('node:fs')
mkdirSync(dshHome, { recursive: true })
const aliasDir = join(dshHome, 'profiles', 'headless', 'node_modules')
for (const [alias, target] of [
  ['@dsh-tool-retry-dev/eval-runner', DRIVER_PKG],
  ['@dsh-tool-retry-dev/plugin', PLUGIN_PKG],
] as const) {
  mkdirSync(dirname(join(aliasDir, ...alias.split('/'))), { recursive: true })
  symlinkSync(target, join(aliasDir, ...alias.split('/')), 'dir')
}
const overlayPath = writeOverlay(liveRoot, {
  sessionId,
  arm: 'on',
  mode: 'native',
  provider: 'mock',
  model: 'mock',
  reasoningEffort: '',
  wake: { kind: 'empty' },
  mockScript: script,
}, sessionsRoot)

const harnessRoot = process.env.DSH_HARNESS
if (harnessRoot === undefined || harnessRoot === '') throw new Error('smoke: DSH_HARNESS is required')
const bin = join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js')
const outcome = await spawnRun(bin, workspaceDir, overlayPath, dshHome, 'native', 180_000)
const logPath = sessionLogPath(sessionsRoot, workspaceDir, sessionId)
const harvested = join(liveRoot, 'harvested.jsonl')
const { copyFileSync } = await import('node:fs')
if (existsSync(logPath)) copyFileSync(logPath, harvested)

const events = existsSync(harvested)
  ? readFileSync(harvested, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as RunRow)
  : []
const postBreak = events.slice(loaded.seededRows)
const retrySuccess = computeRetrySuccess(scenario, 'native', postBreak, workspaceDir)
const toolNames = postBreak.filter(event => event.type === 'tool/call').map(event => event.data.name ?? '')
const postBreakTypes = postBreak.map(event => event.type)
const lastEnd = [...events].reverse().find(event => event.type === 'turn/end') as { data?: { reason?: unknown } } | undefined
const requestHeader = events.find(event => event.type === 'request/header') as
  { data?: { header?: { tools?: { name?: string }[] } } } | undefined
const hasBash = (requestHeader?.data?.header?.tools ?? []).some(tool => tool.name === 'bash')

console.log(JSON.stringify({
  exitCode: outcome.exitCode,
  timedOut: outcome.timedOut,
  harvestedEvents: events.length,
  postBreakEvents: postBreak.length,
  toolNames,
  retrySuccess,
  hasBash,
  postBreakTypes,
  lastEndReason: JSON.stringify(lastEnd?.data?.reason),
  stderrTail: outcome.stderr.slice(-300),
}, null, 2))

const failed = outcome.exitCode !== 0
  || events.length === 0
  || !retrySuccess
  || !toolNames.includes('editPreviousToolCalling')
  || !hasBash
rmSync(liveRoot, { recursive: true, force: true })
if (failed) {
  console.error('smoke FAILED')
  process.exit(1)
}
console.log('smoke PASSED — real CLI resume + neutral wake + harvest + grading + bash tool present')
