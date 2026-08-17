/**
 * Shared invariants for the dsh-tool-retry plugin: path layout, id
 * sanitization, mode detection, and the tool/call event lookup.
 * @module dsh-tool-retry/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Stable plugin identity used in notice sources and diagnostics. */
export const PLUGIN_ID = '@canglongcl/dsh-tool-retry'

/** Session checkpoint root: `<os.tmpdir()>/.dsh/tool-checkpoints/<sessionId>/`. */
export const CHECKPOINT_ROOT = join(tmpdir(), '.dsh', 'tool-checkpoints')

/** checkpointDirFor session root under {@link CHECKPOINT_ROOT}. */
export function checkpointRootDir(sessionId: string): string {
  return join(CHECKPOINT_ROOT, sanitizeId(sessionId))
}

/** One call's data taken verbatim from the session `tool/call` event. */
export interface ToolCallData {
  turn: number
  step: number
  callId: string
  name: string
  arguments: string
}

/**
 * Find the `tool/call` event for one call id, newest first. The agent loop
 * commits the event before dispatching the call body, so it is always present
 * by post-execute; on a resumed session the restored log serves the same
 * lookup without extra machinery.
 */
export function findCallEvent(session: Session, callId: string): ToolCallData | undefined {
  const events = session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && event.type === 'tool/call' && event.data.callId === callId) {
      return { ...event.data }
    }
  }
  return undefined
}

/** File-name sanitization: any byte outside `[A-Za-z0-9._-]` becomes `_`. */
export function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * Code-mode detection (the plan's dual condition): `run_code` is visible for
 * the scope AND the runtime behind it is mounted. The reserved name cannot be
 * forged, so visibility is authoritative. `both` mode reads as code. A broken
 * deployment where `run_code` is visible but the runtime failed to mount
 * degrades to native (the visibility probe itself would throw otherwise).
 */
export function isCodeMode(ctx: Context, scope: ScopeKey | undefined): boolean {
  try {
    return ctx.tools.get(RUN_CODE_NAME, scope) !== undefined
      && ctx.get('codeRuntime') !== undefined
  } catch {
    return false
  }
}

/** Mode selection for one agent (assembly- or post-execute-time). */
export function agentCodeMode(ctx: Context, agent: Agent | undefined): boolean {
  return agent === undefined ? false : isCodeMode(ctx, agent)
}
