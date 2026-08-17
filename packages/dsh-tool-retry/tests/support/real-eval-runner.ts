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

import { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ToolRetry from '../../src/index.ts'
import { CHECKPOINT_ROOT, PLUGIN_ID, sanitizeId } from '../../src/invariant.ts'
import { InlineRuntime } from './inline-runtime.ts'
import { waitForIdle } from './real-e2e-runner.ts'

export interface EvalFixture {
  name: string
  mode: 'native' | 'code'
  /** The tool family the runner composition must mount. */
  kind: 'deploy' | 'boom' | 'fs' | 'plan'
  /** The breakpoint round's failing blocks, in model order. */
  blocks: { callId: string; tool: string; rawArguments: string; errorText: string; notice: string }[]
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

export interface EvalRunOptions {
  fixture: EvalFixture
  arm: 'on' | 'off'
  /** Real provider model (deepseek adapter). */
  model: string
  /** Adapter reasoning effort (deepseek: off | high | max); absent = adapter default. */
  reasoningEffort?: 'off' | 'high' | 'max'
  deadlineMs: number
  /** Per-run artifact dir; when set, the FULL session log (every event, tool
   * calls included with raw arguments) is persisted as session.jsonl there —
   * the drill-down evidence the HTML report embeds (the dsh-web-review
   * per-run session.jsonl pattern). */
  runDir?: string
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
  /** Flat text of post-break tool/result contents (debug evidence). */
  resultTexts: string[]
}

/**
 * Resume one arm to completion and summarize the post-break metrics.
 * The caller owns the returned checkpointDir cleanup (the session store is
 * per-run and disposed inside).
 */
export async function runEvalScenario(options: EvalRunOptions): Promise<EvalRunSummary> {
  const fixture = options.fixture
  const sessionId = fixture.header.id
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
    // fs scenarios: pre-create the workspace files the retry edits against.
    for (const file of fixture.workspaceFiles ?? []) {
      writeFileSync(join(workspace, file.path), file.content)
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
    const prefixEvents = [...fixture.events]
    if (options.arm === 'on') {
      const lastSeq = prefixEvents.reduce((max: number, event: unknown) =>
        Math.max(max, (event as { seq?: number }).seq ?? 0), 0)
      let seq = lastSeq + 1
      fixture.blocks.forEach((block, index) => {
        const noticeText = block.notice.replaceAll('__CHECKPOINT_DIR__', checkpointDir)
        prefixEvents.push({
          type: 'user/message',
          seq: seq++,
          time: fixture.header.createdAt + 8 + index,
          data: {
            content: [{ type: 'text', text: noticeText }],
            source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'notice', summary: 'Failed call saved' },
            role: 'user',
            id: `prefix-notice-message-${index}`,
          },
          surfaceOp: 'append',
        })
      })
    }
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
    await waitForIdle(ctx, handle.agent, options.deadlineMs)

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
    const callNamesById = new Map(postBreak
      .filter(event => event.type === 'tool/call')
      .map(event => [event.data.callId, event.data.name ?? '']))
    const planCriterion = (toolName: string): boolean => postBreak.some(event =>
      event.type === 'tool/result'
      && event.data.message?.content?.some(block =>
        callNamesById.get(block.toolCallId) === toolName && block.isError !== true) === true)
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
    const retrySuccess = fixture.kind === 'deploy'
      ? options.deployCalls?.some(call => call.kind === 'valid') === true
      : fixture.kind === 'boom'
        ? planCriterion('run_code')
        : fixture.kind === 'fs'
          ? fsChecksPass
          // plan: a direct re-submission (OFF) succeeds without error, or the
          // nested replay inside editPreviousToolCalling renders the accepted
          // outcome (ON).
          : planCriterion('exit_plan_mode')
            || resultTexts.some(text => text.includes('plan accepted: true'))
    const adopted = fixture.mode === 'native'
      ? toolCalls.includes('editPreviousToolCalling')
      : toolCallArguments.some(argumentsText =>
        argumentsText.includes('previous/1.json') || argumentsText.includes('/by-id/'))
    const notices = postBreak.filter(event =>
      event.type === 'user/message' && event.data.source?.plugin === PLUGIN_ID)
    const lastTurnEnd = [...events].reverse().find(event => event.type === 'turn/end')
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
