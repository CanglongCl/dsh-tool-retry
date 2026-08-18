/**
 * dsh-tool-retry: automatic tool-call checkpointing, minimal failure notices,
 * and a native-mode edit-and-replay tool.
 *
 * Every model-direct tool call (`exec.parent === undefined`) is checkpointed
 * under `<os.tmpdir()>/.dsh/tool-checkpoints/<sessionId>/` — the raw argument
 * string as `by-id/<id>.json`, a per-round `previous/N.json` alias, and a
 * `history.jsonl` index line — whether it succeeds or fails, with zero
 * filtering by tool name or error code. Every failure additionally attaches
 * one minimal notice to the post-execute decision. In code mode the outer
 * `run_code` program is the only direct call and the plugin registers no
 * replay tool; the model edits checkpoints inside a new program.
 *
 * Agent-plane plugin: one instance per preset standing mount, keyed per
 * session. Registered prompt sections are global registries entries, so the
 * text providers gate themselves on the assembling scope's chain.
 * @module dsh-tool-retry
 */

import type { Context } from '@deepseek-ai/cordis'
import { rmSync } from 'node:fs'
import type { Session } from '@deepseek-ai/dsh-session'
import { scopeChainOf, scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { nodeLinkOps, SessionCheckpoint } from './checkpoint.ts'
import type { CheckpointIo } from './checkpoint.ts'
import {
  agentCodeMode,
  checkpointRootDir,
  findCallEvent,
  isCodeMode,
  sanitizeId,
} from './invariant.ts'
import {
  CHECKPOINT_SECTION_ORDER,
  nativeNotice,
  nativeSection,
  ptcNotice,
  ptcSection,
  REPLAY_TOOL_NAME,
} from './notices.ts'
import { registerReplayTool } from './replay-tool.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-retry'

/** Services required before the checkpoint pipeline can mount. */
export const inject = ['tools', 'fs', 'systemPrompt']

/**
 * Process-facing internals. The link ops are a test seam: unit suites swap in
 * an in-memory mock before mounting the plugin (mirrors the harness's
 * headless-runner `internals` pattern).
 */
export const internals: { linkOps: import('./checkpoint.ts').LinkOps } = {
  linkOps: nodeLinkOps,
}

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Master switch; disabled mounts nothing at all. */
  enabled?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
})

/**
 * Plugin body: the post-execute checkpoint/notice pipeline, the native-mode
 * replay tool, and the mode-conditional static prompt section. All effects
 * unwind with this row (HMR-safe); session directories are removed on
 * `session/disposed` with the fiber teardown as backstop.
 * @param ctx - the mounting composition's context (an agent preset's standing
 *   scope, or the root context in tests/overlays).
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const stores = new Map<string, SessionCheckpoint>()
  const ownScope = scopeOf(ctx)
  const io: CheckpointIo = {
    fs: ctx.fs,
    links: internals.linkOps,
    emitObserved: (target, version, actor) => {
      ctx.emit('fs/observed', target, { kind: 'present', version }, actor)
    },
    warn: message => ctx.logger.warn(message),
  }

  /** Whether one assembling agent belongs to this preset's scope chain. */
  const covers = (scope: ScopeKey | undefined): boolean =>
    ownScope === undefined || (scope !== undefined && scopeChainOf(scope).includes(ownScope))

  // Native mode only: register the replay tool (the plan's dual detection;
  // `both` mode reads as code and gets no tool).
  const codeMode = isCodeMode(ctx, ownScope)
  if (!codeMode) {
    registerReplayTool(ctx, io, (sessionId) => {
      let store = stores.get(sessionId)
      if (store === undefined) {
        store = new SessionCheckpoint(sessionId)
        stores.set(sessionId, store)
      }
      return store
    }, covers)
  }

  // Static protocol section: mode-conditional text, gated on this preset.
  ctx.systemPrompt.section({
    name: 'tool:checkpoint-replay',
    order: CHECKPOINT_SECTION_ORDER,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined || !covers(context.scope)) return ''
      const dir = checkpointRootDir(String(agent.session.id))
      return agentCodeMode(ctx, agent) ? ptcSection(dir) : nativeSection(dir)
    },
  })

  // The "after-tool-calling" hook: every execution passes through it,
  // failures included. The listener always awaits next() and only extends
  // the returned decision's additionalContexts.
  ctx.on('tools/post-execute', async (exec: ToolExecution, result, next) => {
    const decision = await next()
    if (exec.parent !== undefined) return decision
    const agent = exec.agent
    if (agent === undefined) return decision
    const session = agent.session
    const call = findCallEvent(session, String(exec.callId))
    if (call === undefined) {
      ctx.logger.warn(`dsh-tool-retry: no tool/call event for ${exec.callId}; checkpoint skipped`)
      return decision
    }
    const sessionKey = String(session.id)
    let store = stores.get(sessionKey)
    if (store === undefined) {
      store = new SessionCheckpoint(sessionKey)
      stores.set(sessionKey, store)
    }
    let checkpointed = false
    try {
      await store.checkpoint(io, exec, call, session.events)
      checkpointed = true
    } catch (error) {
      // Sandbox read-only, backend error, …: log, skip the notice, and never
      // block the pipeline.
      ctx.logger.warn(`dsh-tool-retry: checkpoint write failed for ${exec.callId}: ${errorMessage(error)}; notice skipped`)
    }
    if (result.isError && checkpointed) {
      const notice = agentCodeMode(ctx, agent)
        ? ptcNotice(store.rootDir, `${sanitizeId(String(exec.callId))}.json`)
        : nativeNotice(String(exec.callId), nativeNoticeHint(call.arguments, exec))
      return {
        ...decision,
        additionalContexts: [...(decision.additionalContexts ?? []), notice],
      } as PostToolDecision
    }
    return decision
  })

  // Per-session cleanup; the effect teardown below is the HMR backstop.
  ctx.on('session/disposed', (session: Session) => {
    const store = stores.get(String(session.id))
    if (store === undefined) return
    stores.delete(String(session.id))
    rmSync(store.rootDir, { recursive: true, force: true })
  })
  ctx.effect(() => () => {
    for (const store of stores.values()) {
      rmSync(store.rootDir, { recursive: true, force: true })
    }
    stores.clear()
  })
}

/** Best-effort message from an unknown throw. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Failure-notice hint derived from the failed call's RAW argument string:
 * the top-level keys (patch paths start from them) and, when the failed call
 * was itself an `editPreviousToolCalling` attempt, the original call id the
 * retry should target instead of the failed attempt's own id. Best-effort —
 * a parse failure contributes nothing, and an ordinal-form replay call has
 * already re-pointed the round map so its original id is unrecoverable here.
 */
function nativeNoticeHint(
  raw: string | undefined,
  exec: { name?: string },
): { keys?: string[]; editedCallId?: string } | undefined {
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record).slice(0, 6)
  let editedCallId: string | undefined
  if (exec.name === REPLAY_TOOL_NAME && typeof record.call_id === 'string') {
    editedCallId = record.call_id
  }
  if (keys.length === 0 && editedCallId === undefined) return undefined
  return {
    ...(keys.length > 0 ? { keys } : {}),
    ...(editedCallId !== undefined ? { editedCallId } : {}),
  }
}
