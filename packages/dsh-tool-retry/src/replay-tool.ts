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
import type { CheckpointIo, SessionCheckpoint } from './checkpoint.ts'
import { sanitizeId } from './invariant.ts'
import { REPLAY_TOOL_NAME } from './notices.ts'

/** Resolve (or create) a store for a session id (plugin-owned per-session map). */
export type StoreLookup = (sessionId: string) => SessionCheckpoint

/** Whether one assembling scope belongs to this plugin's scope chain. */
export type ScopeCoverage = (scope: ScopeKey | undefined) => boolean

/** One patch entry: a path plus exactly one of value / old_string+new_string. */
interface PatchEntry {
  path: string
  /** Whole-value replacement (any JSON value). */
  value?: JsonValue
  /** Literal replace inside the string value at the path. */
  old_string?: string
  new_string?: string
  replace_all?: boolean
}

/** The tool's validated arguments. */
interface ReplayArgs {
  previous_ordinal?: number
  call_id?: string
  /** The only edit payload: parsed-checkpoint patches (path + value xor
   * old/new), so JSON escaping never enters the model's view. */
  patch?: PatchEntry[]
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
 * Tokenize a jq-style patch path: `.config.mode` → ['config', 'mode'],
 * `items[0].name` → ['items', 0, 'name'], `a[0][1]` → ['a', 0, 1]. Every
 * character must belong to a token — a path like `a[0x]` is invalid rather
 * than silently truncated.
 */
function parsePatchPath(path: string): (string | number)[] {
  const tokens: (string | number)[] = []
  const source = path.trim()
  const matcher = /\.|[^.\[\]]+|\[\d+\]/gu
  let consumed = 0
  for (const match of source.matchAll(matcher)) {
    if (match.index !== consumed) throw new Error(`invalid patch path "${path}"`)
    consumed += match[0].length
    const token = match[0]
    if (token === '.') continue
    if (token.startsWith('[')) tokens.push(Number(token.slice(1, -1)))
    else tokens.push(token)
  }
  if (consumed !== source.length) throw new Error(`invalid patch path "${path}"`)
  return tokens
}

/** The (turn, step) of one recorded tool/call, if the log holds it. */
function callTurnStep(sessionEvents: readonly unknown[], callId: string): { turn: number; step: number } | undefined {
  for (const event of sessionEvents) {
    const candidate = event as { type?: string; data?: { callId?: string; turn?: number; step?: number } } | undefined
    if (candidate?.type === 'tool/call' && candidate.data?.callId === callId
      && candidate.data.turn !== undefined && candidate.data.step !== undefined) {
      return { turn: candidate.data.turn, step: candidate.data.step }
    }
  }
  return undefined
}

/**
 * Register the replay tool and its guidance section. Native mode only — the
 * caller applies the plan's dual-detection before registering. The guidance
 * text gates itself on the caller's scope coverage (tool registrations are
 * global registry entries).
 */
export function registerReplayTool(ctx: Context, io: CheckpointIo, lookup: StoreLookup, covers: ScopeCoverage): void {
  void covers
  ctx.tools.register(defineTool({
    name: REPLAY_TOOL_NAME,
    description: 'Edit the checkpointed arguments of a previous tool call and immediately re-run that tool with the edited arguments. Each patch entry either sets one value (value) or applies a literal replace inside one string (old_string/new_string). Use this only when a small correction is needed; otherwise call the original tool again with fresh arguments.',
    parameters: {
      previous_ordinal: {
        type: 'number',
        description: "The call's position (1/2/\u2026) in your previous message. Only reliable when this replay call is the FIRST tool call of your message — after any earlier call in the same message, or for a parallel sibling, pass call_id instead. Exactly one of previous_ordinal / call_id must be provided.",
      },
      call_id: {
        type: 'string',
        description: 'The call id of an older call (from its failure notice or the tail of history.jsonl). Exactly one of previous_ordinal / call_id must be provided.',
      },
      patch: {
        type: 'array',
        description: 'One or more edits, applied in order to the parsed checkpoint. A path uses dot segments and [n] array indexes starting from the checkpoint\'s TOP-LEVEL keys. Each entry carries EXACTLY ONE of: value (replace the whole value at the path — any JSON type; omit value AND old_string to delete the field), or old_string + new_string (a literal replace inside the string value at the path; the string\'s decoded text is matched, so JSON quoting never enters old_string; it must appear exactly once unless replace_all is true).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: {
              type: 'string',
              required: true,
              description: 'Dot/array path from a top-level key to the target value (e.g. ".config.mode", "items[0].name").',
            },
            value: {
              type: 'json',
              description: 'The whole replacement value at the path (any JSON value). Omit value AND old_string to delete the field (array indexes splice the item out). Mutually exclusive with old_string/new_string.',
            },
            old_string: {
              type: 'string',
              description: 'Literal text to replace inside the string value at the path. Must match exactly; when replace_all is false (default) it must appear exactly once — if it appears more than once, include more surrounding text to make it unique.',
            },
            new_string: {
              type: 'string',
              description: 'Literal replacement text. Use an empty string to delete the match. Mutually exclusive with value.',
            },
            replace_all: {
              type: 'boolean',
              description: 'Replace all matches. Defaults to false.',
            },
          },
        },
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
      if (args.patch === undefined || args.patch.length === 0) {
        throw new Error('patch must contain at least one entry')
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
        let entry = store.lookupOrdinal(args.previous_ordinal as number)
        // Ordinal stability: previous_ordinal means "the PREVIOUS message's
        // calls", but the round map re-points at the FIRST direct call of
        // each message (its post-execute) — so a replay call that is not the
        // message's first call (a parallel sibling, or after an earlier read)
        // can resolve against the CURRENT message's map: a miss (the current
        // calls are not checkpointed yet) or, worse, the current message's
        // call with the same ordinal — a wrong-target replay. Detect both by
        // comparing the resolved entry's (turn, step) with this call's own
        // group, and rebuild from the log with the current group excluded.
        const own = callTurnStep(agent.session.events, String(exec.callId))
        if (entry !== undefined && own !== undefined) {
          const entryGroup = callTurnStep(agent.session.events, entry.callId)
          if (entryGroup !== undefined && entryGroup.turn === own.turn && entryGroup.step === own.step) {
            entry = undefined
          }
        }
        if (entry === undefined) {
          // Restart/resume recovery (decision 11) and the stability rule
          // above: rebuild lazily from the session log (excluding this
          // message's group when the map had re-pointed to it).
          await store.ensureRound(io, agent.session.events, own)
          entry = store.lookupOrdinal(args.previous_ordinal as number)
        }
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

      // 3. Apply the edit payload. The observation table is in-memory and
      // does NOT survive a process restart/resume — a checkpoint written by
      // an earlier process would otherwise fail the policy as
      // FS_NOT_OBSERVED. Re-observe first with the plugin's own
      // write-then-emit pattern (same content, this call's exec actor),
      // exactly like checkpoint() records it.
      const existing = await ctx.fs.readText(fileTarget, exec.signal)
      const rewrite = await ctx.fs.writeText(fileTarget, existing, undefined, exec.signal)
      ctx.emit('fs/observed', fileTarget, { kind: 'present', version: rewrite.version }, exec)
      // Patch mode: parse the checkpointed JSON, apply the entries in order,
      // and persist the patched object — the model never touches the stored
      // string's escaping.
      let parsed: unknown
      try {
        parsed = existing ? JSON.parse(existing) : {}
      } catch {
        throw new Error('checkpoint content is not JSON — patch edits need JSON arguments')
      }
      for (const entry of args.patch!) {
        const hasValue = Object.hasOwn(entry, 'value')
        const hasOld = entry.old_string !== undefined
        const hasNew = entry.new_string !== undefined
        if (hasValue && (hasOld || hasNew)) {
          throw new Error('patch entry must carry exactly one of: value, or old_string + new_string')
        }
        if (hasOld !== hasNew) {
          throw new Error('old_string and new_string must be provided together')
        }
        // The registry snapshot already detaches json-typed values; the
        // round-trip is a defensive plain-JSON guard only.
        const value = hasValue ? JSON.parse(JSON.stringify(entry.value)) as unknown : undefined
        const tokens = parsePatchPath(entry.path)
        if (tokens.length === 0) throw new Error('patch path must not be empty')
        const missing = (): never => {
          const keys = parsed !== null && typeof parsed === 'object'
            ? Object.keys(parsed as Record<string, unknown>)
            : []
          throw new Error(`patch path "${entry.path}" not found (checkpoint keys: ${keys.join(', ') || '(none)'})`)
        }
        let parent: Record<string, unknown> | unknown[] | undefined
        let current: unknown = parsed
        let key: string | number | undefined
        for (const token of tokens) {
          if (typeof token === 'number') {
            if (!Array.isArray(current)) missing()
            if (token >= (current as unknown[]).length) missing()
            parent = current as unknown[]
            key = token
            current = (current as unknown[])[token]
          } else if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
            const object = current as Record<string, unknown>
            if (!Object.hasOwn(object, token)) missing()
            parent = object
            key = token
            current = object[token]
          } else {
            missing()
          }
        }
        if (parent === undefined || key === undefined) missing()
        if (hasOld) {
          // String-internal replace: match the value's DECODED text, so JSON
          // quoting never enters old_string (a stringified-JSON value is
          // matched with plain quotes).
          if (typeof current !== 'string') {
            throw new Error(`patch path "${entry.path}" does not point to a string (old_string/new_string edits strings only — use value to replace it instead)`)
          }
          const oldString = entry.old_string as string
          const replaceAll = entry.replace_all === true
          const occurrences = current.split(oldString).length - 1
          if (occurrences === 0) {
            throw new Error(`old_string was not found in the value at "${entry.path}"`)
          }
          if (occurrences > 1 && !replaceAll) {
            throw new Error(`old_string appears ${String(occurrences)} times in the value at "${entry.path}" — include more surrounding text to make it unique, or pass replace_all: true`)
          }
          const edited = replaceAll
            ? current.split(oldString).join(entry.new_string as string)
            : current.replace(oldString, entry.new_string as string)
          if (Array.isArray(parent)) (parent as unknown[])[Number(key)] = edited
          else (parent as Record<string, unknown>)[String(key)] = edited
        } else if (hasValue) {
          if (Array.isArray(parent)) (parent as unknown[])[Number(key)] = value
          else (parent as Record<string, unknown>)[String(key)] = value
        } else {
          // Neither value nor old/new: delete the field (arrays splice).
          if (Array.isArray(parent)) (parent as unknown[]).splice(Number(key), 1)
          else delete (parent as Record<string, unknown>)[String(key)]
        }
      }
      const patchedText = JSON.stringify(parsed)
      const patchedWrite = await ctx.fs.writeText(fileTarget, patchedText, undefined, exec.signal)
      ctx.emit('fs/observed', fileTarget, { kind: 'present', version: patchedWrite.version }, exec)
      const newArgs = parsed

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
