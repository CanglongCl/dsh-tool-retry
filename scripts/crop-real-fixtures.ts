/**
 * Real-case cropping tool (run by a maintainer, NOT by the commit gate): pull
 * one failing tool call out of a real persisted session log and freeze it as
 * an eval breakpoint — the resumable prefix (task message + the failing step)
 * plus the referenced workspace files snapshotted from the real repositories.
 * Output lands under tests/eval-fixtures-src/real/<name>/; the fixture
 * builder copies it into tests/eval-fixtures/ deterministically.
 *
 * Fidelity contracts enforced here (adversarially reviewed):
 * - the persisted envelope's sourceEventSeqs (original-session ids) is
 *   dropped and seq/time re-assigned contiguously;
 * - machine identity is neutralized EVERYWHERE (prefix events, raw args,
 *   error text, workspace contents): /Users/<user>/ → ~/, P4 client names →
 *   <client>, depot prefixes → //<depot>/;
 * - parallel siblings of the failed call KEEP their results (the cut lands
 *   after the failing step's LAST result) — providers reject a message whose
 *   tool-call blocks outnumber the recorded results;
 * - the prefix carries the failing step PLUS the K preceding steps of the
 *   SAME turn (every event, thinking included): a single-step crop amputates
 *   the evidence the reasoning references and the resumed model re-explores
 *   the workspace cold instead of retrying;
 * - the workspace snapshot is restored to FAILURE-TIME state: the session's
 *   eventual successful edit on the same file is reverse-applied (or the
 *   recorded new_string itself is reversed), so the fileContains grader can
 *   never pass with zero work; unrecoverable post-success states throw;
 * - the success fragment is the first 60-char window of the intended content
 *   that the failure-time file does NOT already contain.
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
  /** Fallback continuation; overridden by the real next user message when
   * nextUserMessageAsContinuation is set (e.g. a dismissed plan review where
   * the user's own words ARE the next instruction). */
  continuation: string
  nextUserMessageAsContinuation?: boolean
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
      expected: '按用户发言修订计划后重新提交 exit_plan_mode 成功。',
    },
    stripPrefix: '/Users/canglong/program/abc-db/',
    workspaceSnapshot: [],
    continuation: 'Your plan was dismissed — the user wants to speak instead. Wait for the user\'s message and respond appropriately.',
    nextUserMessageAsContinuation: true,
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
    continuation: '',
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
    continuation: '',
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
    continuation: '',
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
    continuation: '',
  },
]

function zstdText(path: string): string {
  return execFileSync('zstd', ['-dc', path], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }).toString()
}

/** Neutralize machine identity in one string (case prefix first). */
function scrubText(value: string, stripPrefix: string): string {
  return value
    .replaceAll(stripPrefix, '')
    .replaceAll(/\/Users\/[A-Za-z0-9._-]+\//gu, '~/')
    .replaceAll('canglong.dai_CanglongdeMacBook-Pro_8089', '<client>')
    .replaceAll('//ABC_Project/', '//<depot>/')
}

function scrub(value: unknown, stripPrefix: string): unknown {
  if (typeof value === 'string') return scrubText(value, stripPrefix)
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

/** The next human user/message strictly after an index. */
function nextUserMessage(events: EventLike[], fromIndex: number): EventLike | undefined {
  for (let index = fromIndex + 1; index < events.length; index += 1) {
    const event = events[index]!
    if (event.type !== 'user/message') continue
    const source = (event.data as { source?: { kind?: string } } | undefined)?.source
    if (source?.kind === 'user') return event
  }
  return undefined
}

function textOf(message: EventLike | undefined): string {
  return ((message?.data?.content as { type?: string; text?: string }[] | undefined) ?? [])
    .filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
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
  const rawArguments = (toolCall.data as { arguments?: string }).arguments ?? ''
  const errorBlock = (breakResult.data?.message as { content?: { content?: { text?: string }[] }[] }).content?.[0]
  const errorText = (errorBlock?.content ?? []).map(part => part.text ?? '').join('\n')

  // FULL-PREFIX crop: the breakpoint is the failing tool/result, and the
  // prefix is EVERYTHING the model saw before it — every turn, every step,
  // every thinking block, every tool call and result. Nothing above the cut
  // is lost (the earlier K-steps crop amputated the evidence the reasoning
  // references and made the resumed model re-explore). Two artifact classes
  // are dropped, both lossless for the model: streaming delta chunks (their
  // content lives intact inside the assistant/message blocks) and event
  // types the pinned session library cannot restore (steering/message — a
  // newer-harness event). The cut lands after the failing step's LAST
  // result, so every tool-call block of that message keeps its result and
  // the provider transcript stays valid; the open step/turn tail is closed
  // by the harness's own interrupted-turn repair at resume.
  const DROPPED_EVENTS = new Set(['assistant/chunk', 'text-chunks', 'reasoning-chunks', 'tool-call-chunks', 'steering/message'])
  let cutPoint = breakResultIndex
  for (let index = breakResultIndex + 1; index < events.length; index += 1) {
    const event = events[index]!
    if (event.type !== 'tool/result') break
    const data = event.data as { turn?: number; step?: number }
    if (data.turn === turn && data.step === step) cutPoint = index
    else break
  }
  // events[0] is the real session header line — the crop synthesizes its own.
  const prefix = events.slice(1, cutPoint + 1)
    .filter(event => event.type !== undefined && !DROPPED_EVENTS.has(event.type))
  if (prefix.length === 0) throw new Error(`empty prefix for ${caseDef.name}`)
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
  // The committed prefix is zstd-compressed (full sessions are large); the
  // fixture builder decompresses it deterministically.
  const prefixText = `{"type":"session","version":0,"id":"${caseDef.name}-prefix","createdAt":1,"cwd":"/workspace","delegationDepth":0}\n`
    + `${scrubbed.map(event => JSON.stringify(event)).join('\n')}\n`
  writeFileSync(join(dir, 'session-prefix.jsonl.zstd'),
    execFileSync('zstd', ['-19', '-q', '-c'], { input: prefixText, maxBuffer: 512 * 1024 * 1024 }))
  const workspaceFiles = caseDef.workspaceSnapshot
    .filter(snapshot => existsSync(snapshot.path))
    .map(snapshot => ({ path: snapshot.rel, content: String(scrub(readFileSync(snapshot.path, 'utf8'), caseDef.stripPrefix)) }))
  const scrubbedArgs = String(scrub(rawArguments, caseDef.stripPrefix))
  const continuation = caseDef.nextUserMessageAsContinuation === true
    ? (textOf(nextUserMessage(events, breakResultIndex)).trim() || caseDef.continuation)
    : caseDef.continuation

  // fs success check: after the retry the file must contain the intended new
  // content. The workspace snapshot must be the file AT THE BREAKPOINT, never
  // the post-session state where a later successful retry already applied the
  // content — a fileContains grader over an already-correct file would pass
  // with zero work and make the eval dishonest. Failure-time state recovery:
  // first reverse the session's OWN later successful edit on the same file
  // (its new_string → old_string), then fall back to reversing the recorded
  // failed call itself; anything unrecoverable throws (re-crop required).
  let successChecks: { kind: 'fileContains'; path: string; fragment: string }[] = []
  if (caseDef.kind === 'fs' && workspaceFiles.length > 0) {
    let parsed: { new_string?: string; old_string?: string; content?: string; file_path?: string }
    try {
      parsed = JSON.parse(scrubbedArgs) as { new_string?: string; old_string?: string; content?: string; file_path?: string }
    } catch {
      throw new Error(`fs case ${caseDef.name} has no JSON-parseable arguments`)
    }
    const intended = parsed.new_string ?? parsed.content ?? ''
    const target = workspaceFiles.find(file => file.path === caseDef.workspaceSnapshot[0]?.rel)
    if (target === undefined || intended === '') throw new Error(`fs case ${caseDef.name} missing workspace target or intended content`)

    // Reverse the session's later successful edit/write on the same file, if any.
    const failedPath = parsed.file_path ?? ''
    let laterEdit: { new_string: string; old_string: string } | undefined
    let laterWrite: { content: string } | undefined
    for (let index = breakResultIndex + 1; index < events.length; index += 1) {
      const event = events[index]!
      if (event.type !== 'tool/call') continue
      const data = event.data as { callId?: string; name?: string; arguments?: string }
      if (data.name !== 'edit' && data.name !== 'write') continue
      let callArgs: { file_path?: string; new_string?: string; old_string?: string; content?: string }
      try {
        callArgs = JSON.parse(String(scrub(data.arguments ?? '', caseDef.stripPrefix))) as typeof callArgs
      } catch {
        continue
      }
      if (callArgs.file_path !== failedPath) continue
      const result = events.slice(index + 1).find(candidate =>
        candidate.type === 'tool/result'
        && ((candidate.data?.message as { content?: { toolCallId?: string; isError?: boolean }[] } | undefined)
          ?.content?.[0]?.toolCallId) === data.callId)
      const isError = (result?.data?.message as { content?: { isError?: boolean }[] } | undefined)?.content?.[0]?.isError
      if (isError === true) continue
      if (data.name === 'edit' && callArgs.new_string !== undefined && callArgs.old_string !== undefined) {
        laterEdit = { new_string: callArgs.new_string, old_string: callArgs.old_string }
      } else if (data.name === 'write' && callArgs.content !== undefined) {
        laterWrite = { content: callArgs.content }
      }
      break
    }

    let failureState = target.content
    if (laterEdit !== undefined && failureState.includes(laterEdit.new_string)) {
      if (failureState.split(laterEdit.new_string).length - 1 !== 1) {
        throw new Error(`cannot reverse later edit for ${caseDef.name}: new_string present ${failureState.split(laterEdit.new_string).length - 1}x`)
      }
      failureState = failureState.replace(laterEdit.new_string, laterEdit.old_string)
    } else if (laterWrite !== undefined && failureState.includes(laterWrite.content)) {
      if (failureState !== laterWrite.content) {
        // The write landed and the file diverged further: failure-time state
        // is unrecoverable from the current snapshot.
        throw new Error(`cannot recover failure-time state for ${caseDef.name}: a later successful write landed in the snapshot`)
      }
      // Content-equal no-op rewrite: the snapshot IS the failure-time state.
    } else if (failureState.includes(intended)) {
      const occurrences = failureState.split(intended).length - 1
      if (parsed.new_string !== undefined && parsed.old_string !== undefined && occurrences === 1) {
        // Reverse the recorded failed call itself: failure-time state =
        // new_string swapped back to the old_string it had tried to match.
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
      turn,
      step,
      rawArguments: scrubbedArgs,
      errorText: String(scrub(errorText, caseDef.stripPrefix)),
    }],
    continuation,
    ...workspaceFiles.length > 0 ? { workspaceFiles } : {},
    ...successChecks.length > 0 ? { successChecks } : {},
  }, null, 2)}\n`)
  console.log(`=== ${caseDef.name}: call ${callId} turn ${turn} step ${step}, args ${rawArguments.length} chars, prefix ${scrubbed.length} events`)
  console.log(`    error: ${errorText.slice(0, 120)}`)
  console.log(`    continuation: ${continuation.slice(0, 120).replace(/\n/gu, ' | ')}`)
  console.log(`    files: ${workspaceFiles.map(file => file.path).join(', ') || 'none'}`)
}

for (const caseDef of CASES) {
  cropOne(caseDef)
}
