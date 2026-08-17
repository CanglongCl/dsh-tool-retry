/**
 * Real-model arm runner shared by the e2e (plan §5.6) and the evaluation
 * suite (plan §6): boots the full agent-loop composition over published
 * deps — DeepSeek provider adapter, credentials from the process
 * environment, this plugin, and (code mode) the inline program runtime
 * (the published worker is not on npm) — runs one task to idle, and
 * summarizes the persisted session.
 *
 * This file lives under the plugin package so its `@deepseek-ai/*` imports
 * resolve through the package's pinned devDependencies; repo scripts import
 * it by relative path.
 */

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ToolRetry from '../../src/index.ts'
import { CHECKPOINT_ROOT, PLUGIN_ID } from '../../src/invariant.ts'
import { InlineRuntime } from './inline-runtime.ts'

export type RealMode = 'native' | 'code'

export interface RealArmOptions {
  /** Composition mode: native wire surface or code mode (run_code). */
  mode: RealMode
  /** Stable session id (deterministic checkpoint directory). */
  sessionId: string
  /** The task text the model receives. */
  task: string
  /** Provider/model for the live session. */
  model: string
  /** Per-arm deadline in ms. */
  deadlineMs: number
  /** Registered tool log hooks (code mode only). */
  boomCalls?: { value: string }[]
  /** Registered tool log hooks (native mode only). */
  deployCalls?: { label: string; kind: string }[]
}

export interface RealArmOutcome {
  sessionId: string
  checkpointed: boolean
  noticeIds: string[]
  toolCalls: string[]
  adopted: boolean
  replaySucceeded: boolean
  /** Flat text of every tool/result content, in event order. */
  resultTexts: string[]
  workspace: string
}

/** Wait for one agent to go idle, or reject at the arm deadline. */
export function waitForIdle(ctx: Context, agent: Agent, deadlineMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`arm deadline (${deadlineMs} ms) expired`)), deadlineMs)
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        clearTimeout(timer)
        dispose()
        resolve()
      }
    })
  })
}

/**
 * Boot one real-model arm to completion and summarize the persisted session.
 * The caller owns the returned workspace (removed after inspection).
 */
export async function runRealArm(options: RealArmOptions): Promise<RealArmOutcome> {
  const checkpointDir = join(CHECKPOINT_ROOT, options.sessionId)
  rmSync(checkpointDir, { recursive: true, force: true })
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-tool-retry-real-'))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx, {
      tools: options.mode === 'code' ? { mode: 'code' } : {},
      systemPrompt: { persona: 'dsh-tool-retry real-model run' },
    })
    await ctx.plugin(LocalCredentialProvider)
    await ctx.plugin(LlmDeepSeek)
    if (options.mode === 'code') {
      await ctx.plugin(InlineRuntime)
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
    } else {
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
          const config = args.config as { kind: string; label?: string }
          options.deployCalls?.push({ label: config.label ?? '', kind: config.kind })
          if (config.kind === 'invalid') throw new Error('deploy rejected config: kind must be "valid"')
          return { ok: true }
        },
      }))
    }
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(FsPolicy)
    if (options.mode === 'code') await ctx.plugin(ToolFs)
    await ctx.plugin(ToolRetry)
    await ctx.plugin(AgentLoop, { agents: [] })

    const handle = await ctx.agents.create({
      sessionId: SessionId(options.sessionId),
      meta: { cwd: workspace },
      agentOptions: { provider: 'deepseek-official', model: options.model },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: options.task }], source: { kind: 'user' } }))
    await waitForIdle(ctx, handle.agent, options.deadlineMs)

    const events = handle.agent.session.events as unknown as {
      type: string
      data: {
        callId?: string
        name?: string
        content?: { type?: string; text?: string }[]
        source?: { plugin?: string }
        message?: { content?: { toolCallId?: string; content?: { type?: string; text?: string }[] }[] }
      }
    }[]
    const noticeEvents = events.filter(event =>
      event.type === 'user/message' && event.data.source?.plugin === PLUGIN_ID)
    const noticeIds = noticeEvents.map((event) => {
      const text = event.data.content?.find(block => block.type === 'text')?.text ?? ''
      return (/call id: (\S+)/u.exec(text)?.[1] ?? /by-id\/(\S+\.json)/u.exec(text)?.[1] ?? '')
        .replace(/\.json$/u, '')
    })
    const callNames = events
      .filter(event => event.type === 'tool/call')
      .map(event => event.data.name ?? '')
    const resultTexts = events
      .filter(event => event.type === 'tool/result')
      .map(event => (event.data.message?.content?.[0]?.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('\n'))
    const adopted = options.mode === 'native'
      ? callNames.includes('editPreviousToolCalling')
      : options.boomCalls?.some(call => call.value === 'v2-good') === true
    const replaySucceeded = options.mode === 'native'
      ? resultTexts.some(text => text.includes('Replayed deploy'))
      : options.boomCalls?.some(call => call.value === 'v2-good') === true
    const checkpointed = existsSync(join(checkpointDir, 'by-id'))
      && existsSync(join(checkpointDir, 'history.jsonl'))
      && readdirSync(join(checkpointDir, 'by-id')).length > 0
    await handle.dispose()
    return {
      sessionId: options.sessionId,
      checkpointed,
      noticeIds,
      toolCalls: callNames,
      adopted,
      replaySucceeded,
      resultTexts,
      workspace,
    }
  } finally {
    rmSync(checkpointDir, { recursive: true, force: true })
  }
}
