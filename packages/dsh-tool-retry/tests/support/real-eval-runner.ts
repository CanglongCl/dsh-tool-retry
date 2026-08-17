/**
 * Real-model evaluation runner (plan §6): resumes one breakpoint-snapshot
 * session prefix through the published persistence backend and lets a live
 * model continue from the breakpoint, then summarizes the post-break
 * metrics. The adapter is injectable — the keyless resume-mechanics smoke
 * drives it with a scripted mock, the real eval with the DeepSeek provider.
 *
 * ON arm: the plugin is mounted, the prefix gains the recorded failure
 * notice, and the checkpoint store is pre-seeded from the fixture (by-id +
 * previous/ alias + history.jsonl) so the resumed session exercises the
 * plugin's restart contract verbatim — the notice's call id resolves, the
 * round map rebuilds from the persisted log tail.
 *
 * OFF arm: no plugin, no notice, no checkpoint store — the baseline the
 * model regenerates arguments against.
 */

import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { waitForIdle } from './real-e2e-runner.ts'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ToolRetry from '../../src/index.ts'
import { CHECKPOINT_ROOT, PLUGIN_ID, sanitizeId } from '../../src/invariant.ts'
import { InlineRuntime } from './inline-runtime.ts'

export interface EvalFixture {
  name: string
  mode: 'native' | 'code'
  /** The tool family the runner composition must mount. */
  kind: 'deploy' | 'boom' | 'fs' | 'plan'
  /** The breakpoint round's failing blocks, in model order. */
  blocks: { callId: string; tool: string; rawArguments: string; errorText: string }[]
  continuation: string
  /** Workspace files pre-created before resume (fs scenarios). */
  workspaceFiles?: { path: string; content: string }[]
  /** Post-run workspace-state checks (fs scenarios' retry-success evidence). */
  successChecks?: { kind: 'fileExists' | 'fileContains'; path: string; fragment?: string }[]
  /** Parsed prefix events (header id/createdAt + session events). */
  header: { id: string; createdAt: number }
  events: unknown[]
}

/** Parse one committed eval fixture directory into a runnable snapshot. */
export function loadEvalFixture(dir: string): EvalFixture {
  const scenario = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8')) as EvalFixture
  const lines = readFileSync(join(dir, 'session-prefix.jsonl'), 'utf8').split('\n').filter(line => line.trim().length > 0)
  const header = JSON.parse(lines[0]!) as { id: string; createdAt: number }
  const events = lines.slice(1).map(line => JSON.parse(line) as unknown)
  return { ...scenario, header, events }
}

/** When one arm run stops: at the successful retry (fast) or at idle (full). */
export type StopAt = 'idle' | 'retry-success'

export interface EvalRunOptions {
  fixture: EvalFixture
  arm: 'on' | 'off'
  /** Stop the run the moment the retry succeeds (the criterion the summary
   * reports) instead of waiting for the turn to converge; halves per-run
   * wall time and output tokens, at the cost of the post-retry steps. */
  stopAt?: StopAt
  /** Real provider model (deepseek adapter). */
  model: string
  /** Adapter reasoning effort (deepseek: off | high | max); absent = adapter default. */
  reasoningEffort?: 'off' | 'high' | 'max'
  deadlineMs: number
  /** Per-run artifact dir; when set, the FULL session log (every event, tool
   * calls included with raw arguments) is persisted as session.jsonl there —
   * the drill-down evidence the HTML report embeds (the dsh-web-review
   * per-run session.jsonl pattern), alongside trace.md / process.json. */
  runDir?: string
  /** Repetition + repo head for the immutable experiment identity. */
  revision?: { repetition: number; repoHead: string }
  /** Unique per-run session id suffix (concurrent same-scenario runs). */
  sessionIdSuffix?: string
  /** Scripted adapter for the keyless smoke; absent = real provider. */
  adapter?: LlmAdapter
  /** Hook logs for the smoke's behavioral assertions. */
  boomCalls?: { value: string }[]
  deployCalls?: { kind: string }[]
}

export interface EvalRunSummary {
  scenario: string
  arm: 'on' | 'off'
  mode: 'native' | 'code'
  sessionId: string
  /** First post-break assistant step output tokens (the retry cost). */
  retryStepOutputTokens: number
  /** Reasoning tokens inside that step (content = output minus reasoning). */
  retryStepReasoningTokens: number
  /** Post-break model input tokens (the retry request's context cost). */
  postBreakInputTokens: number
  /** The breakpoint tool re-ran and its newest result is not an error. */
  retrySuccess: boolean
  /** The model took the plugin's replay path. */
  adopted: boolean
  /** Post-break plugin notices (should equal post-break failures, ON arm). */
  noticeCount: number
  noticeBytes: number
  /** Post-break tool call names in order. */
  toolCalls: string[]
  /** Post-break tool call raw argument strings (diagnostic evidence). */
  toolCallArguments: string[]
  /** Whether the run reached a completed turn. */
  completed: boolean
  /** Whether the run was cut off at the successful retry (stopAt mode). */
  stoppedEarly: boolean
  /** Run outcome classification (web-review status/attribution analogue). */
  status: 'completed' | 'cutoff' | 'timeout' | 'error'
  /** Structured grader evidence for the retry-success criterion. */
  grader: { criterion: string; checks: { name: string; pass: boolean }[] }
  /** Immutable identities: fixture / grader / execution revisions + experiment id. */
  revisions: { scenario: string; grader: string; execution: string; experiment: string }
  /** Flat text of post-break tool/result contents (debug evidence). */
  resultTexts: string[]
}

/** Stable short identity for one input document. */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 20)
}

/** Structural view of the session rows the criteria read. */
interface RunRow {
  type: string
  data: {
    callId?: string
    name?: string
    arguments?: string
    content?: { type?: string; text?: string }[]
    source?: { plugin?: string }
    usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }
    message?: { content?: { toolCallId?: string; content?: { type?: string; text?: string }[]; isError?: boolean }[] }
    reason?: { kind?: string }
  }
}

/** The per-kind retry-success criterion (shared by the stop-at gate and the summary). */
function computeRetrySuccess(
  fixture: EvalFixture,
  postBreak: RunRow[],
  workspace: string,
  options: EvalRunOptions,
): boolean {
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
  const fsChecksPass = (fixture.successChecks ?? []).every((check) => {
    const path = join(workspace, check.path)
    if (check.kind === 'fileExists') return existsSync(path)
    if (check.fragment === undefined) return false
    try {
      return readFileSync(path, 'utf8').includes(check.fragment)
    } catch {
      return false
    }
  })
  switch (fixture.kind) {
    case 'deploy':
      return options.deployCalls?.some(call => call.kind === 'valid') === true
    case 'boom':
      // Native: the boom tool re-ran with any non-marker value (it only
      // fails on the marker). Code: the plan §6 run_code criterion.
      return fixture.mode === 'native'
        ? options.boomCalls?.some(call => call.value !== 'v1-marker') === true
        : directOk('run_code')
    case 'fs':
      // Code mode additionally requires the retry program to complete.
      return fixture.mode === 'native' ? fsChecksPass : directOk('run_code') && fsChecksPass
    case 'plan':
      // Native: a direct re-submission (OFF) succeeds without error, or the
      // nested replay inside editPreviousToolCalling renders the accepted
      // outcome (ON). Code: the retry program completes.
      return fixture.mode === 'native'
        ? directOk('exit_plan_mode') || resultTexts.some(text => text.includes('plan accepted: true'))
        : directOk('run_code')
  }
}

/**
 * stopAt='retry-success' gate: settle the moment the retry criterion flips
 * true (evaluated on the tick after each tool result, so the loop's commit
 * has landed), falling back to idle when the deadline expires or the turn
 * completes without a success.
 */
async function waitForStopAt(
  ctx: Context,
  handle: AgentHandle,
  prefixLength: number,
  fixture: EvalFixture,
  workspace: string,
  options: EvalRunOptions,
  deadlineMs: number,
): Promise<'cutoff' | 'idle' | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: 'cutoff' | 'idle' | 'timeout'): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      disposeResult()
      disposeStatus()
      resolve(outcome)
    }
    const evaluate = (): boolean => {
      const events = handle.agent.session.events as unknown as RunRow[]
      return computeRetrySuccess(fixture, events.slice(prefixLength), workspace, options)
    }
    const timer = setTimeout(() => finish('timeout'), deadlineMs)
    const disposeStatus = ctx.on('agent/status', ({ agent, status }) => {
      if (agent === handle.agent && status === 'idle') finish('idle')
    })
    // The stop hook rides the tools/result waterfall (after each call body):
    // the fast path is the replay tool itself — a successful
    // editPreviousToolCalling result means the edit + nested replay both
    // landed, which IS the retry the eval measures. PTC arms (no replay
    // tool) and baseline arms fall back to the per-kind criterion.
    const disposeResult = ctx.on('tools/result', (exec, result) => {
      if ((exec as { parent?: unknown }).parent !== undefined) return
      const editLanded = (exec as { name?: string }).name === 'editPreviousToolCalling'
        && (result as { isError?: boolean }).isError !== true
      // The loop appends its tool/result commit right around this emit; defer
      // one tick so the criterion reads the committed event.
      setImmediate(() => {
        if (editLanded || evaluate()) finish('cutoff')
      })
    })
  })
}

/** Flat text of a message's text blocks. */
function textOfBlocks(content: { type?: string; text?: string }[] | undefined): string {
  return (content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

/** Structured process statistics (dsh-web-review process.json parity). */
function processStats(events: RunRow[], summary: EvalRunSummary): Record<string, unknown> {
  const toolCounts: Record<string, number> = {}
  const filesRead = new Set<string>()
  const perStepTokens: { step: number; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }[] = []
  let errorResults = 0
  let firstToolCallStep: number | undefined
  let firstWriteStep: number | undefined
  let finalText = ''
  let endReason = 'unknown'
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  for (const event of events) {
    const data = event.data
    if (event.type === 'assistant/message') {
      const usage = data.usage
      if (usage !== undefined) {
        perStepTokens.push({
          step: (data as { step?: number }).step ?? 0,
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: usage.reasoningTokens ?? 0,
        })
        totals.input += usage.inputTokens ?? 0
        totals.output += usage.outputTokens ?? 0
        totals.reasoning += usage.reasoningTokens ?? 0
      }
      const content = data.message?.content ?? []
      const text = textOfBlocks(content as { type?: string; text?: string }[])
      if (text !== '') finalText = text
    } else if (event.type === 'tool/call') {
      const name = data.name ?? ''
      toolCounts[name] = (toolCounts[name] ?? 0) + 1
      if (firstToolCallStep === undefined) firstToolCallStep = (data as { step?: number }).step
      if (firstWriteStep === undefined && /^(write|edit)$/u.test(name)) firstWriteStep = (data as { step?: number }).step
      const match = /"(?:file_path|path|file)"\s*:\s*"([^"]+)"/u.exec(data.arguments ?? '')
      if (match?.[1] !== undefined) filesRead.add(match[1])
    } else if (event.type === 'tool/result') {
      if (data.message?.content?.some(block => block.isError === true) === true) errorResults += 1
    } else if (event.type === 'turn/end') {
      endReason = (data.reason as { kind?: string }).kind ?? endReason
    }
  }
  return {
    sessionId: summary.sessionId,
    status: summary.status,
    turns: perStepTokens.length > 0 ? 1 : 0,
    steps: perStepTokens.length,
    toolCalls: toolCounts,
    errorResults,
    firstToolCallStep,
    firstWriteStep,
    filesRead: [...filesRead],
    tokens: totals,
    perStepTokens,
    reasoningChars: 0,
    finalText: finalText.slice(0, 4000),
    endReason,
    grader: summary.grader,
    revisions: summary.revisions,
  }
}

/**
 * Resume one arm to completion and summarize the post-break metrics.
 * The caller owns the returned checkpointDir cleanup (the session store is
 * per-run and disposed inside).
 */
export async function runEvalScenario(options: EvalRunOptions): Promise<EvalRunSummary> {
  const fixture = options.fixture
  const sessionId = `${fixture.header.id}${options.sessionIdSuffix ?? ''}`
  const checkpointDir = join(CHECKPOINT_ROOT, sessionId)
  rmSync(checkpointDir, { recursive: true, force: true })
  const root = mkdtempSync(join(tmpdir(), 'dsh-tool-retry-eval-'))
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-tool-retry-eval-ws-'))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx, {
      tools: fixture.mode === 'code' ? { mode: 'code' } : {},
      systemPrompt: { persona: 'dsh-tool-retry evaluation agent' },
    })
    if (fixture.mode === 'code') await ctx.plugin(InlineRuntime)
    if (fixture.kind === 'deploy') {
      ctx.tools.register(defineTool({
        name: 'deploy',
        description: 'deploy a service configuration',
        parameters: { config: { type: 'object', required: true, additionalProperties: true, description: 'the full deployment config' } },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean', required: true } },
          },
          render: (_args, value) => [{ type: 'text', text: `deployed ${String(value.ok)}` }],
        },
        async execute(args) {
          const config = args.config as { kind: string }
          options.deployCalls?.push({ kind: config.kind })
          if (config.kind !== 'valid') throw new Error('deploy rejected config: kind must be "valid"')
          return { ok: true }
        },
      }))
    } else if (fixture.kind === 'boom') {
      ctx.tools.register(defineTool({
        name: 'boom',
        description: 'fails when value is "v1-marker"',
        parameters: { value: { type: 'string', required: true, description: 'value' } },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean', required: true } },
          },
          render: (_args, value) => [{ type: 'text', text: `boom ok: ${String(value.ok)}` }],
        },
        async execute(args) {
          const value = String(args.value)
          options.boomCalls?.push({ value })
          if (value === 'v1-marker') throw new Error('boom failed on v1-marker')
          return { ok: true }
        },
      }))
    } else if (fixture.kind === 'plan') {
      // The plan-review exit tool: the recorded breakpoint carries the user
      // rejection + feedback; live submissions succeed (re-submission after
      // revision is the retry behavior under test).
      ctx.tools.register(defineTool({
        name: 'exit_plan_mode',
        description: 'Present your plan for the user\'s review; on approval, leave plan mode.',
        parameters: { plan: { type: 'string', required: true, description: 'The complete plan as markdown' } },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { accepted: { type: 'boolean', required: true } },
          },
          render: (_args, value) => [{ type: 'text', text: `plan accepted: ${String(value.accepted)}` }],
        },
        async execute() {
          return { accepted: true }
        },
      }))
    }
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(FsPolicy)
    if (fixture.kind === 'fs' || fixture.mode === 'code') await ctx.plugin(ToolFs)
    // fs scenarios: pre-create the workspace files the retry edits against
    // (nested snapshot paths need their parent directories first).
    for (const file of fixture.workspaceFiles ?? []) {
      const target = join(workspace, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.content)
    }
    if (options.arm === 'on') await ctx.plugin(ToolRetry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SessionPersistenceJsonl, { root })

    if (options.adapter !== undefined) {
      ctx.llm.registerAdapter(['mock'], options.adapter)
    } else {
      await ctx.plugin(LocalCredentialProvider)
      await ctx.plugin(LlmDeepSeek)
    }

    // ON arm: pre-seed the checkpoint store (by-id content, the previous/
    // shortcut, and the history index) exactly as the plugin leaves it on
    // disk, so the resumed session replays the restart contract.
    if (options.arm === 'on') {
      mkdirSync(join(checkpointDir, 'by-id'), { recursive: true })
      mkdirSync(join(checkpointDir, 'previous'), { recursive: true })
      let history = ''
      fixture.blocks.forEach((block, index) => {
        writeFileSync(join(checkpointDir, 'by-id', `${sanitizeId(block.callId)}.json`), block.rawArguments)
        history += `${JSON.stringify({ id: block.callId, tool: block.tool, turn: 1, step: 1, ordinal: index + 1 })}\n`
        symlinkSync(`../by-id/${sanitizeId(block.callId)}.json`, join(checkpointDir, 'previous', `${index + 1}.json`))
      })
      writeFileSync(join(checkpointDir, 'history.jsonl'), history)
    }

    // Persist the prefix; the ON arm appends the recorded failure notice.
    // The ON arm differs from OFF by composition and on-disk store only:
    // the plugin's STATIC protocol section describes the checkpoint dirs and
    // the replay tool, and the model decides on its own how to retry (the
    // dynamic failure notice is NOT pre-injected — this eval does not test
    // the user-message delivery channel; live post-break failures still
    // produce real notices, which the metrics count).
    const prefixEvents = [...fixture.events]
    await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: SessionId(sessionId),
      createdAt: fixture.header.createdAt,
    })
    await ctx.sessionPersistence.append(SessionId(sessionId), prefixEvents as never)

    const handle = await ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: options.adapter === undefined
        ? { provider: 'deepseek-official', model: options.model }
        : { provider: 'mock', model: 'mock' },
      ...options.reasoningEffort === undefined || options.adapter !== undefined
        ? {}
        : {
            // Reasoning effort rides the agent-scoped model selection (the
            // agentOptions shape carries no effort field).
            setup: (agentCtx: Context) => {
              installModelSelection(agentCtx, {
                current: {
                  provider: 'deepseek-official',
                  model: options.model,
                  reasoningEffort: ReasoningEffortId(options.reasoningEffort!),
                },
                assembled: undefined,
              })
            },
          },
    })
    if (options.arm === 'on') {
      // The observation table is in-memory state that does not survive a
      // restart, so the pre-seeded checkpoint must be re-observed for the
      // resumed session — the exact write-then-emit pattern the plugin uses
      // at checkpoint time (write outcome version, the call's exec actor).
      for (const block of fixture.blocks) {
        const byIdTarget = await ctx.fs.resolve(join(checkpointDir, 'by-id', `${sanitizeId(block.callId)}.json`))
        const write = await ctx.fs.writeText(byIdTarget, block.rawArguments)
        // The observation actor is the ToolExecution shape ({ agent }), whose
        // owner the policy derives as actor.agent.session.
        ctx.emit('fs/observed', byIdTarget, { kind: 'present', version: write.version }, { agent: handle.agent })
      }
    }
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: fixture.continuation }],
      source: { kind: 'user' },
    }))
    let runStatus: 'completed' | 'cutoff' | 'timeout' | 'error' = 'completed'
    let stoppedEarly = false
    try {
      if (options.stopAt === 'retry-success') {
        const outcome = await waitForStopAt(ctx, handle, prefixEvents.length, fixture, workspace, options, options.deadlineMs)
        if (outcome === 'cutoff') {
          stoppedEarly = true
          runStatus = 'cutoff'
        } else if (outcome === 'timeout') {
          runStatus = 'timeout'
        }
      } else {
        await waitForIdle(ctx, handle.agent, options.deadlineMs)
      }
    } catch (error) {
      runStatus = 'error'
      ctx.logger.warn(`dsh-tool-retry eval: run errored: ${error instanceof Error ? error.message : String(error)}`)
    }

    const events = handle.agent.session.events as unknown as {
      type: string
      data: {
        callId?: string
        name?: string
        content?: { type?: string; text?: string }[]
        source?: { plugin?: string }
        usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }
        message?: { content?: { toolCallId?: string; content?: { type?: string; text?: string }[]; isError?: boolean }[] }
        reason?: { kind?: string }
      }
    }[]
    const postBreak = events.slice(prefixEvents.length)
    const toolCalls = postBreak
      .filter(event => event.type === 'tool/call')
      .map(event => event.data.name ?? '')
    const toolCallArguments = postBreak
      .filter(event => event.type === 'tool/call')
      .map(event => (event.data as { arguments?: string }).arguments ?? '')
    const resultTexts = postBreak
      .filter(event => event.type === 'tool/result')
      .map(event => (event.data.message?.content?.[0]?.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('\n'))
    const firstAssistant = postBreak
      .find(event => event.type === 'assistant/message')
    const retryStepOutputTokens = firstAssistant?.data.usage?.outputTokens ?? 0
    const retryStepReasoningTokens = firstAssistant?.data.usage?.reasoningTokens ?? 0
    const postBreakInputTokens = postBreak
      .filter(event => event.type === 'assistant/message')
      .reduce((sum, event) => sum + (event.data.usage?.inputTokens ?? 0), 0)
    // Retry success (plan §6 criteria): native — the breakpoint tool re-ran
    // with valid inputs (only post-break calls execute live — the recorded
    // breakpoint never re-runs; the ON arm reaches deploy through the replay
    // sub-dispatch); PTC — the plan's own criterion, "the next run_code call
    // completes without error" (the model may legitimately fix the program
    // without reproducing the fixture's marker value).
    const retrySuccess = computeRetrySuccess(fixture, postBreak, workspace, options)
    const adopted = fixture.mode === 'native'
      ? toolCalls.includes('editPreviousToolCalling')
      : toolCallArguments.some(argumentsText =>
        argumentsText.includes('previous/1.json') || argumentsText.includes('/by-id/'))
    const notices = postBreak.filter(event =>
      event.type === 'user/message' && event.data.source?.plugin === PLUGIN_ID)
    const lastTurnEnd = [...events].reverse().find(event => event.type === 'turn/end')
    // Structured grader evidence for the retry-success criterion.
    const graderChecks: { name: string; pass: boolean }[] = (() => {
      if (fixture.kind === 'deploy') {
        return [{ name: 'deploy re-ran with kind "valid"', pass: options.deployCalls?.some(call => call.kind === 'valid') === true }]
      }
      if (fixture.kind === 'boom') {
        return fixture.mode === 'native'
          ? [{ name: 'boom re-ran with a non-marker value', pass: options.boomCalls?.some(call => call.value !== 'v1-marker') === true }]
          : [{ name: 'post-break run_code completed without error', pass: postBreak.some(event =>
            event.type === 'tool/result'
            && event.data.message?.content?.some(block => block.isError !== true) === true) }]
      }
      if (fixture.kind === 'fs') {
        const checks = (fixture.successChecks ?? []).map((check) => {
          const path = join(workspace, check.path)
          const pass = check.kind === 'fileExists'
            ? existsSync(path)
            : check.fragment !== undefined && (() => {
              try {
                return readFileSync(path, 'utf8').includes(check.fragment)
              } catch {
                return false
              }
            })()
          return { name: `${check.kind} ${check.path}${check.fragment === undefined ? '' : ` contains ${check.fragment.slice(0, 30)}`}`, pass }
        })
        return fixture.mode === 'code'
          ? [{ name: 'post-break run_code completed without error', pass: postBreak.some(event =>
            event.type === 'tool/result'
            && event.data.message?.content?.some(block => block.isError !== true) === true) }, ...checks]
          : checks
      }
      return [{ name: 'exit_plan_mode accepted', pass: retrySuccess }]
    })()
    const revisionInput = {
      scenario: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'eval-fixtures', fixture.name, 'scenario.json'), 'utf8'),
      grader: JSON.stringify({ kind: fixture.kind, mode: fixture.mode, checks: fixture.successChecks ?? [] }),
      execution: readFileSync(fileURLToPath(import.meta.url), 'utf8'),
    }
    const revisions = {
      scenario: sha256(revisionInput.scenario),
      grader: sha256(revisionInput.grader),
      execution: sha256(revisionInput.execution),
      experiment: sha256(JSON.stringify({
        scenario: sha256(revisionInput.scenario),
        arm: options.arm,
        mode: fixture.mode,
        model: options.model,
        reasoning: options.reasoningEffort ?? 'default',
        repetition: options.revision?.repetition ?? 0,
        repoHead: options.revision?.repoHead ?? 'unknown',
        execution: sha256(revisionInput.execution),
      })),
    }
    const summary: EvalRunSummary = {
      scenario: fixture.name,
      arm: options.arm,
      mode: fixture.mode,
      sessionId,
      retryStepOutputTokens,
      retryStepReasoningTokens,
      postBreakInputTokens,
      retrySuccess,
      adopted,
      noticeCount: notices.length,
      noticeBytes: notices.reduce((sum, event) =>
        sum + (event.data.content?.find(block => block.type === 'text')?.text?.length ?? 0), 0),
      toolCalls,
      toolCallArguments,
      completed: lastTurnEnd?.data.reason?.kind === 'completed',
      stoppedEarly,
      status: runStatus,
      grader: {
        criterion: `${fixture.kind}/${fixture.mode}`,
        checks: graderChecks,
      },
      revisions,
      resultTexts,
    }
    // Persist the FULL session log (every event, tool calls included with
    // their raw argument strings) as the per-run drill-down evidence — the
    // dsh-web-review per-run session.jsonl pattern. The report embeds it.
    if (options.runDir !== undefined) {
      mkdirSync(options.runDir, { recursive: true })
      const header = handle.agent.session.header as unknown as Record<string, unknown>
      const lines = [
        JSON.stringify({ type: 'session', version: 0, ...header }),
        ...events.map(event => JSON.stringify(event)),
      ]
      writeFileSync(join(options.runDir, 'session.jsonl'), `${lines.join('\n')}\n`)
      // dsh-web-review parity artifacts: a folded human-readable trace, the
      // structured process stats, and (fs scenarios) the final workspace.
      writeFileSync(join(options.runDir, 'process.json'), `${JSON.stringify(processStats(events, summary), null, 2)}\n`)
      if (fixture.kind === 'fs') {
        mkdirSync(join(options.runDir, 'workspace'), { recursive: true })
        cpSync(workspace, join(options.runDir, 'workspace'), { recursive: true })
      }
    }
    await handle.dispose()
    return summary
  } finally {
    await ctx.fiber.dispose().catch(() => {})
    rmSync(root, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
    rmSync(checkpointDir, { recursive: true, force: true })
  }
}
