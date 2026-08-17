/**
 * Real-case cropping tool (run by a maintainer, NOT by the commit gate): pull
 * one failing tool call out of a real persisted session log and freeze it as
 * an eval breakpoint — the resumable prefix (task message + the failing step)
 * plus the referenced workspace files snapshotted from the real repositories.
 * Output lands under tests/eval-fixtures-src/real/<name>/; the fixture
 * builder copies it into tests/eval-fixtures/ deterministically.
 *
 * Usage: pnpm crop:real
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = join(ROOT, 'packages', 'dsh-tool-retry', 'tests', 'eval-fixtures-src', 'real')

interface EventLike {
  type?: string
  data?: Record<string, unknown>
  surfaceOp?: string
}

/** One real bad case to crop. */
interface RealCase {
  name: string
  mode: 'native' | 'code'
  kind: 'deploy' | 'boom' | 'fs' | 'plan'
  sessionPath: string
  /** Error-text marker locating the breakpoint (first match wins). */
  marker: string
  title: string
  description: { input: string; expected: string }
  /** Absolute prefix to strip (machine path neutralization). */
  stripPrefix: string
  /** Real files to snapshot into the fixture workspace (post-strip rel). */
  workspaceSnapshot: { path: string; rel: string }[]
  continuation: string
}

const CASES: RealCase[] = [
  {
    name: 'real-plan-dismissed',
    mode: 'native',
    kind: 'plan',
    sessionPath: '/Users/canglong/.dsh/sessions/--Users-canglong-program-abc-db--/session-236ffe18-0f2a-42d3-9e3b-cd93603d5439/session.jsonl.zstd',
    marker: 'dismissed the plan review',
    title: '计划评审被用户驳回（真实）',
    description: {
      input: '模型提交了一份约 1 万字符的 abc-db Rust 重构计划，用户驳回了计划评审并直接发言。',
      expected: '按用户反馈修订计划后重新提交 exit_plan_mode 成功。',
    },
    stripPrefix: '/Users/canglong/program/abc-db/',
    workspaceSnapshot: [],
    continuation: 'Your plan was dismissed — the user wants to speak instead. Revise the plan per the feedback in the failure result and re-submit it with the smallest change, then report the outcome.',
  },
  {
    name: 'real-edit-stale',
    mode: 'native',
    kind: 'fs',
    sessionPath: '/Users/canglong/.dsh/sessions/--Users-canglong-program-abc-db--/session-b64dc04c-5ee8-4a3c-91c7-e83fa3f26256/session.jsonl.zstd',
    marker: 'old_string was not found',
    title: '长文本 edit 失配（真实）',
    description: {
      input: 'edit 的 old_string 引用了已变化的文件内容（真实 gen_protos.py）。',
      expected: '以最小改动修正 old_string 后编辑成功（文件包含 new_string 片段）。',
    },
    stripPrefix: '/Users/canglong/program/abc-db/',
    workspaceSnapshot: [{ path: '/Users/canglong/program/abc-db/python/src/abc_db/gen_protos.py', rel: 'src/abc_db/gen_protos.py' }],
    continuation: 'That edit failed — the old_string no longer matches the file. Fix it with the smallest change and retry, then report the outcome.',
  },
  {
    name: 'real-edit-unobserved',
    mode: 'native',
    kind: 'fs',
    sessionPath: '/Users/canglong/.dsh/sessions/--Users-canglong-program-abc-db--/session-236ffe18-0f2a-42d3-9e3b-cd93603d5439/session.jsonl.zstd',
    marker: 'edit requires reading',
    title: '未读先改被拒（真实）',
    description: {
      input: '模型在未读取文件的情况下直接 edit（FS_NOT_OBSERVED）。',
      expected: '先读取文件再完成编辑（文件包含 new_string 片段）。',
    },
    stripPrefix: '/Users/canglong/program/abc-db/',
    workspaceSnapshot: [{ path: '/Users/canglong/program/abc-db/python/examples/extract_trainers.py', rel: 'python/examples/extract_trainers.py' }],
    continuation: 'That edit failed because the file was never read. Fix it with the smallest change and retry, then report the outcome.',
  },
  {
    name: 'real-write-overwrite',
    mode: 'native',
    kind: 'fs',
    sessionPath: '/Users/canglong/.dsh/sessions/--Users-canglong-program-abc-db--/session-236ffe18-0f2a-42d3-9e3b-cd93603d5439/session.jsonl.zstd',
    marker: 'cannot overwrite existing',
    title: '未读先写被拒（真实）',
    description: {
      input: '模型在未读取的情况下覆盖已存在的 README.md（FS_NOT_OBSERVED）。',
      expected: '先读取再写入（README.md 包含新内容片段）。',
    },
    stripPrefix: '/Users/canglong/program/abc-db/',
    workspaceSnapshot: [{ path: '/Users/canglong/program/abc-db/README.md', rel: 'README.md' }],
    continuation: 'That write failed because the file was never read. Fix it with the smallest change and retry, then report the outcome.',
  },
  {
    name: 'real-run-code-missing-desc',
    mode: 'code',
    kind: 'boom',
    sessionPath: '/Users/canglong/.dsh/sessions/--Users-canglong-program-dsh-web-review--/session-80eb3b71-05b8-4079-837b-72f2c73863c9/session.jsonl.zstd',
    marker: 'missing required property',
    title: 'PTC：程序缺必填字段（真实）',
    description: {
      input: 'run_code 程序参数缺少必填的 description 字段（INVALID_ARGS，真实程序文本）。',
      expected: '修正后的程序无 error 完成。',
    },
    stripPrefix: '/Users/canglong/program/dsh-web-review/',
    workspaceSnapshot: [],
    continuation: 'That program failed. Fix it with the smallest change, run the corrected program, and report the result.',
  },
]

function zstdText(path: string): string {
  return execFileSync('zstd', ['-dc', path], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }).toString()
}

function scrub(value: unknown, stripPrefix: string): unknown {
  if (typeof value === 'string') return value.replaceAll(stripPrefix, '')
  if (Array.isArray(value)) return value.map(item => scrub(item, stripPrefix))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrub(item, stripPrefix)
    }
    return out
  }
  return value
}

/** Crop one real case into a resumable breakpoint prefix + scenario.json. */
function cropOne(caseDef: RealCase): void {
  const events = zstdText(caseDef.sessionPath).split('\n').filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as EventLike)
  const breakResultIndex = events.findIndex((event) => {
    if (event.type !== 'tool/result') return false
    const block = (event.data?.message as { content?: { isError?: boolean; content?: { text?: string }[] }[] } | undefined)
      ?.content?.[0]
    if (block?.isError !== true) return false
    return (block.content ?? []).map(part => part.text ?? '').join('').includes(caseDef.marker)
  })
  if (breakResultIndex === -1) throw new Error(`breakpoint "${caseDef.marker}" not found in ${caseDef.name}`)
  const breakResult = events[breakResultIndex]!
  const callId = ((breakResult.data?.message as { content?: { toolCallId?: string }[] }).content?.[0]?.toolCallId) ?? ''
  let toolCall: EventLike | undefined
  let assistantMessage: EventLike | undefined
  let stepStart: EventLike | undefined
  for (let index = breakResultIndex - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (toolCall === undefined && event.type === 'tool/call' && event.data?.callId === callId) toolCall = event
    if (assistantMessage === undefined && event.type === 'assistant/message') {
      const message = event.data?.message as { content?: { type?: string }[] } | undefined
      if (message?.content?.some(block => block.type === 'tool-call')) assistantMessage = event
    }
    if (stepStart === undefined && event.type === 'step/start') stepStart = event
    if (toolCall !== undefined && assistantMessage !== undefined && stepStart !== undefined) break
  }
  if (toolCall === undefined || assistantMessage === undefined || stepStart === undefined) {
    throw new Error(`breakpoint context incomplete for ${caseDef.name}`)
  }
  const turn = (toolCall.data as { turn?: number }).turn ?? 1
  const step = (toolCall.data as { step?: number }).step ?? 1
  const task = events.find(event =>
    event.type === 'user/message' && (event.data as { turn?: number }).turn === turn)
    ?? events.find(event => event.type === 'user/message')
  if (task === undefined) throw new Error(`no task message for ${caseDef.name}`)
  const rawArguments = (toolCall.data as { arguments?: string }).arguments ?? ''
  const errorBlock = (breakResult.data?.message as { content?: { content?: { text?: string }[] }[] }).content?.[0]
  const errorText = (errorBlock?.content ?? []).map(part => part.text ?? '').join('\n')

  const prefix = [
    { type: 'turn/start', data: { turn } },
    task,
    { type: 'step/start', data: { turn, step } },
    assistantMessage,
    toolCall,
    breakResult,
    { type: 'step/end', data: { turn, step } },
  ]
  const scrubbed = prefix.map((event, index) => {
    // The persisted envelope references the ORIGINAL session's event ids
    // (sourceEventSeqs must point at earlier events of the SAME log); the
    // cropped log cannot satisfy that, so drop the envelope provenance —
    // seq/time are re-assigned below, surfaceOp is kept for surface folding.
    const cleaned = scrub(event, caseDef.stripPrefix) as Record<string, unknown>
    delete cleaned.sourceEventSeqs
    return {
      ...cleaned,
      seq: index,
      time: index + 1,
    }
  })
  const dir = join(OUT, caseDef.name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session-prefix.jsonl'),
    `{"type":"session","version":0,"id":"${caseDef.name}-prefix","createdAt":1,"cwd":"/workspace","delegationDepth":0}\n`
    + `${scrubbed.map(event => JSON.stringify(event)).join('\n')}\n`)
  const workspaceFiles = caseDef.workspaceSnapshot
    .filter(snapshot => existsSync(snapshot.path))
    .map(snapshot => ({ path: snapshot.rel, content: readFileSync(snapshot.path, 'utf8') }))
  const scrubbedArgs = String(scrub(rawArguments, caseDef.stripPrefix))
  // fs success check: after the retry the file must contain the intended new
  // content. The workspace snapshot must be the file AT THE BREAKPOINT, never
  // the post-session state where a later successful retry already applied the
  // content — a fileContains grader over an already-correct file would pass
  // with zero work and make the eval dishonest. Failure-time state recovery:
  // an edit whose new_string is still present once is reversed back to its
  // old_string; anything unrecoverable throws (a maintainer must re-crop).
  let successChecks: { kind: 'fileContains'; path: string; fragment: string }[] = []
  if (caseDef.kind === 'fs' && workspaceFiles.length > 0) {
    let parsed: { new_string?: string; old_string?: string; content?: string }
    try {
      parsed = JSON.parse(scrubbedArgs) as { new_string?: string; old_string?: string; content?: string }
    } catch {
      throw new Error(`fs case ${caseDef.name} has no JSON-parseable arguments`)
    }
    const intended = parsed.new_string ?? parsed.content ?? ''
    const target = workspaceFiles.find(file => file.path === caseDef.workspaceSnapshot[0]?.rel)
    if (target === undefined || intended === '') throw new Error(`fs case ${caseDef.name} missing workspace target or intended content`)
    let failureState = target.content
    if (failureState.includes(intended)) {
      const occurrences = failureState.split(intended).length - 1
      if (parsed.new_string !== undefined && parsed.old_string !== undefined && occurrences === 1) {
        // Reverse the later successful edit: failure-time state = new_string
        // swapped back to the old_string that the rejected call had matched.
        failureState = failureState.replace(intended, parsed.old_string)
      } else {
        throw new Error(`cannot recover failure-time state for ${caseDef.name}: snapshot already contains the intended content (${occurrences}x)`)
      }
    }
    target.content = failureState
    // Pick the first 60-char window of the intended content that the
    // failure-time file does NOT already contain (the shared heading can
    // make the first window degenerate, e.g. a README rewrite).
    let fragment = intended.slice(0, 60)
    for (let offset = 60; offset < intended.length && failureState.includes(fragment); offset += 60) {
      fragment = intended.slice(offset, offset + 60)
    }
    if (failureState.includes(fragment)) {
      throw new Error(`degenerate success check for ${caseDef.name}: every 60-char window of the intended content is already present`)
    }
    successChecks = [{ kind: 'fileContains', path: target.path, fragment }]
  }
  writeFileSync(join(dir, 'scenario.json'), `${JSON.stringify({
    name: caseDef.name,
    mode: caseDef.mode,
    kind: caseDef.kind,
    title: caseDef.title,
    description: caseDef.description,
    blocks: [{
      callId,
      tool: (toolCall.data as { name?: string }).name ?? 'unknown',
      rawArguments: scrubbedArgs,
      errorText: String(scrub(errorText, caseDef.stripPrefix)),
    }],
    continuation: caseDef.continuation,
    ...workspaceFiles.length > 0 ? { workspaceFiles } : {},
    ...successChecks.length > 0 ? { successChecks } : {},
  }, null, 2)}\n`)
  const taskText = ((task.data?.content as { type?: string; text?: string }[]) ?? [])
    .filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
  console.log(`=== ${caseDef.name}: call ${callId} turn ${turn} step ${step}, args ${rawArguments.length} chars`)
  console.log(`    task: ${taskText.slice(0, 200).replace(/\n/gu, ' | ')}`)
  console.log(`    error: ${errorText.slice(0, 120)}`)
  console.log(`    files: ${workspaceFiles.map(file => file.path).join(', ') || 'none'}`)
}

for (const caseDef of CASES) {
  cropOne(caseDef)
}
