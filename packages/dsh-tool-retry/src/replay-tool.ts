/**
 * Native-mode replay tool `editPreviousToolCalling`: locate a checkpointed
 * call by previous_ordinal or call_id, apply a literal edit, and re-invoke
 * the original tool with the edited arguments — one call, no fs paths for the
 * model. The re-invocation is a nested sub-dispatch (parent token), so it is
 * neither re-checkpointed nor re-notified and the full policy pipeline
 * (approval included) applies to the edited arguments again.
 * @module dsh-tool-retry/replay-tool
 */

import { CallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import type { SessionCheckpoint } from './checkpoint.ts'
import { sanitizeId } from './invariant.ts'
import { REPLAY_GUIDANCE, REPLAY_GUIDANCE_ORDER, REPLAY_TOOL_NAME } from './notices.ts'

/** Resolve (or create) a store for a session id (plugin-owned per-session map). */
export type StoreLookup = (sessionId: string) => SessionCheckpoint

/** Whether one assembling scope belongs to this plugin's scope chain. */
export type ScopeCoverage = (scope: ScopeKey | undefined) => boolean

/** The tool's validated arguments. */
interface ReplayArgs {
  previous_ordinal?: number
  call_id?: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

/** The tool's canonical output value (content blocks are JSON records). */
interface ReplayValue {
  replayed_call_id: string
  tool_name: string
  checkpoint_path: string
  replay_content: Record<string, JsonValue>[]
}

/** Text content of a content-block list (error detail rendering). */
function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Register the replay tool and its guidance section. Native mode only — the
 * caller applies the plan's dual-detection before registering. The guidance
 * text gates itself on the caller's scope coverage (tool registrations are
 * global registry entries).
 */
export function registerReplayTool(ctx: Context, lookup: StoreLookup, covers: ScopeCoverage): void {
  ctx.systemPrompt.section({
    name: 'tool:editPreviousToolCalling',
    order: REPLAY_GUIDANCE_ORDER,
    text: (context) => covers(context.scope) ? REPLAY_GUIDANCE : '',
  })

  ctx.tools.register(defineTool({
    name: REPLAY_TOOL_NAME,
    description: 'Edit the checkpointed arguments of a previous tool call and immediately re-run that tool with the edited arguments.',
    parameters: {
      previous_ordinal: {
        type: 'number',
        description: "The call's position (1/2/\u2026) in your previous message. Exactly one of previous_ordinal / call_id must be provided.",
      },
      call_id: {
        type: 'string',
        description: 'The call id of an older call (from its failure notice or the tail of history.jsonl). Exactly one of previous_ordinal / call_id must be provided.',
      },
      old_string: {
        type: 'string',
        required: true,
        description: 'Literal text to replace in the checkpointed arguments string. Must match exactly.',
      },
      new_string: {
        type: 'string',
        required: true,
        description: 'Literal replacement text. Use an empty string to delete the match.',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          replayed_call_id: { type: 'string', required: true },
          tool_name: { type: 'string', required: true },
          checkpoint_path: { type: 'string', required: true },
          replay_content: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: true },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Replayed ${value.tool_name} with the edited arguments (call ${value.replayed_call_id}):`,
        },
        ...value.replay_content as unknown as ContentBlock[],
      ],
      presentationMeta: (_args, value) => ({
        replayedCallId: value.replayed_call_id,
        toolName: value.tool_name,
        checkpointPath: value.checkpoint_path,
      }),
    },
    async execute(args: ReplayArgs, exec) {
      const hasOrdinal = args.previous_ordinal !== undefined
      const hasId = args.call_id !== undefined && args.call_id !== ''
      if (hasOrdinal === hasId) {
        throw new Error('provide exactly one of previous_ordinal / call_id (both or neither is an error)')
      }
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('editPreviousToolCalling requires an agent session')
      }
      const sessionId = agent.session.id
      const store = lookup(String(sessionId))

      // 1. Locate the target by-id file and the original tool name.
      let callId: string
      let toolName: string | undefined
      if (hasOrdinal) {
        const entry = store.lookupOrdinal(args.previous_ordinal as number)
        if (entry === undefined) {
          throw new Error(`no checkpoint for previous_ordinal ${String(args.previous_ordinal)} (only the PREVIOUS message's calls keep their ordinals)`)
        }
        callId = entry.callId
        toolName = entry.tool
      } else {
        callId = args.call_id as string
        toolName = store.lookupTool(callId) ?? await lookupToolInHistory(ctx, store, callId, exec.signal)
      }
      if (toolName === undefined) {
        throw new Error(`no checkpoint found for call_id "${callId}" (check history.jsonl for valid ids)`)
      }
      const idFileName = `${sanitizeId(callId)}.json`

      // 2. Containment: the target must stay inside this session's directory.
      const dirTarget = await ctx.fs.resolve(store.rootDir)
      const fileTarget = await ctx.fs.resolve(join(store.byIdDir, idFileName))
      if (!ctx.fs.contains(dirTarget, fileTarget)) {
        throw new Error(`checkpoint target escapes the session checkpoint directory: ${fileTarget.displayPath}`)
      }
      if (await ctx.fs.stat(fileTarget, exec.signal) === undefined) {
        throw new Error(`checkpoint file does not exist: ${fileTarget.displayPath}`)
      }

      // 3. Literal edit through the same intent slot as the fs edit tool
      // (the checkpoint was pre-observed, so the policy passes without a read).
      const intent = await ctx.waterfall('fs/edit-intent', fileTarget, exec, () => undefined)
      const outcome = await ctx.fs.editText(
        fileTarget,
        {
          oldString: args.old_string,
          newString: args.new_string,
          replaceAll: args.replace_all ?? false,
        },
        intent,
        exec.signal,
      )
      ctx.emit('fs/observed', fileTarget, { kind: 'present', version: outcome.version }, exec)

      // 4. Read back and parse; the checkpoint must stay valid JSON.
      const edited = await ctx.fs.readText(fileTarget, exec.signal)
      let newArgs: unknown
      try {
        newArgs = edited ? JSON.parse(edited) : {}
      } catch {
        throw new Error('checkpoint content must remain valid JSON after the edit (your old_string changed its structure)')
      }

      // 5. Nested replay: parent token marks it a sub-dispatch (no
      // re-checkpoint, no notice; pre/execute/post/result still run).
      const replay = await ctx.tools.execute({
        callId: CallId(`${callId}:replay`),
        name: toolName,
        arguments: newArgs,
        agent,
        rootCallId: exec.rootCallId,
        parent: exec.token,
        signal: exec.signal,
      })
      if (replay.isError) {
        throw new Error(`Replay of ${toolName} failed: ${textOf(replay.content) || 'unknown error'}`)
      }
      const value: ReplayValue = {
        replayed_call_id: `${callId}:replay`,
        tool_name: toolName,
        checkpoint_path: fileTarget.displayPath,
        replay_content: [...replay.content] as unknown as Record<string, JsonValue>[],
      }
      return value
    },
  }))
}

/** Read `tool` for a call id from the tail of history.jsonl. */
async function lookupToolInHistory(
  ctx: Context,
  store: SessionCheckpoint,
  callId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  let text: string
  try {
    const target = await ctx.fs.resolve(store.historyPath)
    text = await ctx.fs.readText(target, signal)
  } catch {
    return undefined
  }
  let found: string | undefined
  for (const line of text.split('\n')) {
    if (line === '') continue
    let parsed: { id?: string; tool?: string }
    try {
      parsed = JSON.parse(line) as { id?: string; tool?: string }
    } catch {
      continue
    }
    if (parsed.id === callId) found = parsed.tool
  }
  return found
}
