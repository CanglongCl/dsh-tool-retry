/**
 * dsh-tool-retry eval driver: the one-shot headless runner that RESUMES a
 * pre-seeded breakpoint session inside the REAL harness composition, wakes
 * the resumed loop with a neutral (empty plugin) message or the recorded
 * real user message, drives the session to quiescence, flushes the durable
 * log, and exits with the turn outcome. Mirrors @deepseek-ai/dsh-headless
 * and dsh-web-review's eval runner-plugin with `agents.resume` instead of
 * `agents.create` — the three-delta reuse contract of the eval plan.
 * @module dsh-tool-retry-eval-driver
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import { MockAdapter } from './mock-adapter.ts'

/** Stable Cordis plugin name (the overlay row id). */
export const name = 'dsh-tool-retry-eval-runner'

/** Core services required before the resume can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'llm', 'tools']

/** Plugin config, populated by the per-run overlay. */
export interface Config {
  /** The pre-seeded session id to resume (its log already exists on disk). */
  sessionId: string
  /** JSON wake spec: { kind: 'empty' } or { kind: 'user', text } — the
   * ONLY injected input after the breakpoint (plan scenarios carry the
   * user's real follow-up message; everything else wakes neutrally). */
  wake: string
  provider: string
  model: string
  reasoningEffort?: string
  /** JSON chunk-array script for the keyless smoke's mock adapter. */
  mock?: string
  /** JSON retry-success criterion { kind, mode, checks } — the driver cuts
   * the run the moment it passes (stop-at), so successful retries end in a
   * few steps instead of waiting for the turn to converge. */
  grader: string
  /** JSON start spec: { kind: 'resume', sessionId } (the breakpoint corpus)
   * or { kind: 'fresh', task } (minimal live scenarios — the failure happens
   * IN this run, so the plugin's notice channel fires for real). */
  start: string
  /** 'true' mounts the deterministic eval_target tool (minimal live scenario:
   * version 'v1' throws, anything else writes OK-<version> to target-result.txt). */
  targetTool: string
  /** JSON { rejectCount?, feedback? } — scripted plan-review answers: the
   * first rejectCount live reviews are rejected with the recorded user's
   * feedback, later reviews auto-approve. */
  planReview: string
}

export const Config: z<Config> = z.object({
  sessionId: z.string().required(),
  wake: z.string().required(),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  mock: z.string(),
  grader: z.string(),
  start: z.string(),
  targetTool: z.string(),
  planReview: z.string(),
})

/** Process-facing effects of one run (mirrors the headless bundle). */
interface RunnerIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  exit(code: number): void
}

function fail(io: RunnerIo, message: string): void {
  io.stderr.write(`dsh-tool-retry-eval: ${message}\n`)
  io.exit(1)
}

interface GraderSpec {
  kind: 'deploy' | 'boom' | 'fs' | 'plan'
  mode: 'native' | 'code'
  checks: { kind: 'fileExists' | 'fileContains' | 'writeSucceeded'; path: string; fragment?: string }[]
}

/** The retry-success criterion over post-break events + the live workspace
 * (ported from the parent grader; fs checks run against process.cwd(), the
 * staged workspace the child was spawned in). */
function evaluateRetrySuccess(agent: { session: { events: readonly unknown[] } }, firstSeq: number, spec: GraderSpec): boolean {
  interface Row {
    seq: number
    type: string
    data: {
      callId?: string
      name?: string
      arguments?: string
      message?: { content?: { toolCallId?: string; content?: { type?: string; text?: string }[]; isError?: boolean }[] }
    }
  }
  const postBreak = agent.session.events.filter(event => (event as Row).seq > firstSeq) as unknown as Row[]
  const callNamesById = new Map(postBreak
    .filter(event => event.type === 'tool/call')
    .map(event => [event.data.callId, event.data.name ?? '']))
  const directOk = (toolName: string): boolean => postBreak.some(event =>
    event.type === 'tool/result'
    && event.data.message?.content?.some(block =>
      callNamesById.get(block.toolCallId) === toolName && block.isError !== true) === true)
  const resultTexts = postBreak
    .filter(event => event.type === 'tool/result')
    .map(event => (event.data.message?.content?.[0]?.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('\n'))
  const fsChecksPass = spec.checks.every((check) => {
    const path = join(process.cwd(), check.path)
    if (check.kind === 'fileExists') return existsSync(path)
    if (check.kind === 'writeSucceeded') {
      const writeCallIds = postBreak
        .filter(event => event.type === 'tool/call' && event.data.name === 'write'
          && (event.data.arguments ?? '').includes(`"${check.path}"`))
        .map(event => event.data.callId)
      return postBreak.some(event =>
        event.type === 'tool/result'
        && event.data.message?.content?.some(block =>
          writeCallIds.includes(block.toolCallId) && block.isError !== true) === true)
        || resultTexts.some(text => text.includes('Replayed write'))
    }
    if (check.fragment === undefined) return false
    try {
      return readFileSync(path, 'utf8').includes(check.fragment)
    } catch {
      return false
    }
  })
  switch (spec.kind) {
    case 'deploy':
      return false
    case 'boom':
      return spec.mode === 'native' ? false : directOk('run_code')
    case 'fs':
      return spec.mode === 'native' ? fsChecksPass : directOk('run_code') && fsChecksPass
    case 'plan':
      return spec.mode === 'native'
        ? directOk('exit_plan_mode') || resultTexts.some(text => text.includes('plan accepted: true'))
        : directOk('run_code')
  }
}

/** The last turn's outcome (only 'completed' exits 0). */
function lastReason(session: { events: readonly { type: string; data?: { reason?: { kind?: string } } }[] }): string {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]!
    if (event.type === 'turn/end') return event.data?.reason?.kind ?? 'unknown'
  }
  return 'unknown'
}

const fsWrite = async (path: string, content: string): Promise<void> => {
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  writeFileSync(join(process.cwd(), path), content)
}
const fsRead = async (path: string): Promise<string> => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  try {
    return readFileSync(join(process.cwd(), path), 'utf8')
  } catch {
    return ''
  }
}

/** The deterministic minimal-scenario tools:
 * - eval_target: version is a NUMBER; 1 is rejected by the body (the
 *   marker-failure class), any other number writes OK-<version>. The
 *   INVALID_ARGS class comes from the same tool's schema (a string version
 *   violates the number type).
 * - eval_edit: mimics the fs edit tool's stale-old_string rejection — the
 *   body throws exactly like FS_EDIT_NOT_FOUND when old_string is absent
 *   from the workspace file, and applies the literal edit otherwise. */
function registerTargetTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'eval_target',
    description: 'Submit a numeric version marker for the evaluation target.',
    parameters: { version: { type: 'number', required: true, description: 'The numeric version marker to submit.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `target ok: ${String(value.ok)}` }],
    },
    async execute(args) {
      const version = Number(args.version)
      if (version === 1) throw new Error('target rejected version 1')
      await fsWrite('target-result.txt', `OK-${version}\n`)
      return { ok: true }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'eval_submit',
    description: 'Submit a service configuration; the body rejects any config whose mode is not \"prod\".',
    parameters: { config: { type: 'object', required: true, additionalProperties: true, description: 'The full configuration object to submit (structured JSON — one field of it is wrong and must be fixed).' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `submit ok: ${String(value.ok)}` }],
    },
    async execute(args) {
      const config = args.config as { mode?: string }
      if (config.mode !== 'prod') throw new Error('config rejected: mode must be "prod"')
      await fsWrite('target-result.txt', `OK-${config.mode}\n`)
      return { ok: true }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'eval_plan',
    description: 'Submit a long markdown plan for review; the body rejects any plan that still says the runtime stays on Python 2.',
    parameters: { plan: { type: 'string', required: true, description: 'The complete plan, as markdown.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `plan ok: ${String(value.ok)}` }],
    },
    async execute(args) {
      const plan = String(args.plan)
      if (plan.includes('继续使用 Python 2 运行时')) {
        throw new Error('plan rejected: the runtime must be Rust')
      }
      await fsWrite('target-result.txt', 'OK-plan\n')
      return { ok: true }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'eval_config',
    description: 'Submit a long service configuration; the body rejects any config whose maxRetries is below 5.',
    parameters: { config: { type: 'object', required: true, additionalProperties: true, description: 'The full configuration object (one short field of it is wrong and must be fixed).' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `config ok: ${String(value.ok)}` }],
    },
    async execute(args) {
      const config = args.config as { maxRetries?: number }
      if (Number(config.maxRetries) < 5) throw new Error('config rejected: maxRetries must be at least 5')
      await fsWrite('target-result.txt', 'OK-retries\n')
      return { ok: true }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'eval_deploy',
    description: 'Deploy a service with a long note; the ARGUMENT SCHEMA rejects any call whose replicas is not a number.',
    parameters: {
      notes: { type: 'string', required: true, description: 'A long deployment note kept verbatim for the record.' },
      replicas: { type: 'number', required: true, description: 'The replica count (a number).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `deploy ok: ${String(value.ok)}` }],
    },
    async execute(args) {
      await fsWrite('target-result.txt', `OK-deploy-${String(args.replicas)}\n`)
      return { ok: true }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'eval_edit',
    description: 'Apply a literal edit to a workspace file; fails when old_string is not in the file (like the fs edit tool).',
    parameters: {
      file_path: { type: 'string', required: true, description: 'The workspace file to edit.' },
      old_string: { type: 'string', required: true, description: 'The literal text to replace.' },
      new_string: { type: 'string', required: true, description: 'The literal replacement.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `edit ok: ${String(value.ok)}` }],
    },
    async execute(args) {
      const filePath = String(args.file_path)
      const oldString = String(args.old_string)
      const newString = String(args.new_string)
      const content = await fsRead(filePath)
      if (!content.includes(oldString)) {
        throw new Error(`old_string was not found in "${filePath}"`)
      }
      await fsWrite(filePath, content.replace(oldString, newString))
      return { ok: true }
    },
  }))
}

async function run(ctx: Context, config: Config, io: RunnerIo): Promise<void> {
  // Loader siblings mount concurrently; await the complete application.
  await (ctx.get('loader') as { await(): Promise<void> } | undefined)?.await()
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  if (agents === undefined || sessions === undefined) return

  if (config.mock !== undefined && config.mock !== '') {
    ctx.llm.registerAdapter(['mock'], new MockAdapter(JSON.parse(config.mock) as never[]))
  }
  if (config.targetTool === 'true') registerTargetTool(ctx)
  if (config.planReview !== undefined && config.planReview !== '') {
    // The headless profile has no interactive user-questions channel, so a
    // plan review would fail with NO_PROVIDER forever. Script the answers:
    // the first rejectCount live reviews decline with the recorded user's
    // feedback (a LIVE failure the checkpoint/notice channel can react to),
    // later reviews approve so the turn can converge.
    const spec = JSON.parse(config.planReview) as { rejectCount?: number; feedback?: string }
    await ctx.plugin(UserQuestionService)
    let pending = spec.rejectCount ?? 1
    ctx.userQuestions.registerProvider({
      ask: async (request) => {
        const question = request.questions[0]
        if (question === undefined) throw new Error('eval plan-review stub: no question to answer')
        if (pending > 0) {
          pending -= 1
          return { answers: [{ id: question.id, selected: ['Keep planning'], custom: spec.feedback ?? '' }] }
        }
        return { answers: [{ id: question.id, selected: ['Approve'] }] }
      },
    })
  }
  const effort = config.reasoningEffort ?? ''
  const current: ModelSelectionRef['current'] = {
    provider: config.provider,
    model: config.model,
    ...(effort === '' || effort === 'null'
      ? {}
      : { reasoningEffort: ReasoningEffortId(effort) }),
  }
  const selection: ModelSelectionRef = { current, assembled: undefined }

  // Two start shapes: RESUME a pre-seeded breakpoint session (the real
  // corpus), or FRESH-create a session for minimal live scenarios where the
  // failure happens inside THIS run — the only way the plugin's notice
  // channel actually fires and drives adoption.
  const start = JSON.parse(config.start === undefined || config.start === '' ? '{}' : config.start) as
    { kind: 'resume'; sessionId: string } | { kind: 'fresh'; task: string }
  const setup = (agentCtx: Context) => {
    installModelSelection(agentCtx, selection)
  }
  const { agent } = start.kind === 'resume'
    ? await agents.resume({
        resumeSessionId: SessionId(start.sessionId),
        agentOptions: { provider: config.provider, model: config.model },
        setup,
      })
    : await agents.create({
        sessionId: SessionId(config.sessionId ?? 'mini'),
        meta: { cwd: process.cwd() },
        agentOptions: { provider: config.provider, model: config.model },
        setup,
      })
  const wake = start.kind === 'fresh'
    ? { kind: 'user', text: start.task }
    : JSON.parse(config.wake) as { kind: 'empty' | 'user'; text?: string }
  const grader = JSON.parse(config.grader === undefined || config.grader === '' ? '{}' : config.grader) as GraderSpec
  const firstSeq = agent.session.seq
  // Stop-at: the moment the retry criterion passes (checked one tick after
  // each direct tool result commits), flush and exit successfully — a
  // successful retry ends in a few steps instead of waiting for the turn.
  const disposeStopAt = grader.kind === undefined ? undefined : ctx.on('tools/result', (exec) => {
    if ((exec as { parent?: unknown }).parent !== undefined) return
    setImmediate(() => {
      if (evaluateRetrySuccess(agent, firstSeq, grader)) {
        disposeStopAt?.()
        void (async () => {
          await sessions.flush(agent.session)
          io.stdout.write('STOP-AT-SUCCESS\n')
          io.exit(0)
        })()
      }
    })
  })
  agent.followup(createUserMessage(wake.kind === 'user'
    ? { content: [{ type: 'text', text: wake.text ?? '' }], source: { kind: 'user' } }
    : { content: [], source: { kind: 'plugin', plugin: 'dsh-tool-retry-eval' } }))
  await agent.whenIdle()
  disposeStopAt?.()
  await sessions.flush(agent.session)
  const reason = lastReason(agent.session as never)
  io.exit(reason === 'completed' ? 0 : 1)
}

/** Mount the one-shot eval driver. */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (exit === undefined) {
    throw new Error('dsh-tool-retry-eval-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: RunnerIo = {
    stdout: process.stdout,
    stderr: process.stderr,
    exit,
  }
  void run(ctx, config, io).catch((error: unknown) => {
    fail(io, error instanceof Error ? error.message : String(error))
  })
}
