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
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter } from './mock-adapter.ts'

/** Stable Cordis plugin name (the overlay row id). */
export const name = 'dsh-tool-retry-eval-runner'

/** Core services required before the resume can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'llm']

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
}

export const Config: z<Config> = z.object({
  sessionId: z.string().required(),
  wake: z.string().required(),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  mock: z.string(),
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

/** The last turn's outcome (only 'completed' exits 0). */
function lastReason(session: { events: readonly { type: string; data?: { reason?: { kind?: string } } }[] }): string {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]!
    if (event.type === 'turn/end') return event.data?.reason?.kind ?? 'unknown'
  }
  return 'unknown'
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
  const effort = config.reasoningEffort ?? ''
  const current: ModelSelectionRef['current'] = {
    provider: config.provider,
    model: config.model,
    ...(effort === '' || effort === 'null'
      ? {}
      : { reasoningEffort: ReasoningEffortId(effort) }),
  }
  const selection: ModelSelectionRef = { current, assembled: undefined }

  // Resume the pre-seeded breakpoint session (the eval plan's delta vs the
  // headless bundle's fresh agents.create): the real harness composition
  // reconstructs the session with its interrupted-turn repair, then the
  // neutral wake opens the retry turn.
  const { agent } = await agents.resume({
    resumeSessionId: SessionId(config.sessionId),
    agentOptions: { provider: config.provider, model: config.model },
    setup: (agentCtx: Context) => {
      installModelSelection(agentCtx, selection)
    },
  })
  const wake = JSON.parse(config.wake) as { kind: 'empty' | 'user'; text?: string }
  agent.followup(createUserMessage(wake.kind === 'user'
    ? { content: [{ type: 'text', text: wake.text ?? '' }], source: { kind: 'user' } }
    : { content: [], source: { kind: 'plugin', plugin: 'dsh-tool-retry-eval' } }))
  await agent.whenIdle()
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
