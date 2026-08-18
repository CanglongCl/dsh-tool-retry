/**
 * Model-facing text for the plugin: the static system-prompt section
 * (drafts A/B, mode-conditional) and the minimal failure notices (drafts
 * C/D). Injection language is English (the plan's reviewed drafts); the
 * Chinese translations in the plan appendix are review aids only.
 * @module dsh-tool-retry/notices
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { PLUGIN_ID } from './invariant.ts'

/** Static section name/order: tool guidance band, before the SDK section (150). */
export const CHECKPOINT_SECTION_ORDER = 149
/** Replay-tool guidance section name/order: right after `tool:edit` (102). */
export const REPLAY_GUIDANCE_ORDER = 103
export const REPLAY_TOOL_NAME = 'editPreviousToolCalling'

/** Static section A (native) with the session directory filled in. */
export function nativeSection(dir: string): string {
  return [
    'TOOL-CALL CHECKPOINT & REPLAY',
    `Every tool call you make is checkpointed under ${dir}:`,
    '- previous/1.json, previous/2.json, ... are shortcuts to the PARALLEL',
    '  tool-call blocks of your PREVIOUS message, in your call order (your 1st',
    '  block is previous/1.json, your 2nd block is previous/2.json, and so on).',
    '  A new round of calls re-points them.',
    '- Every call is also kept under its call id as by-id/<id>.json, and an index',
    '  line is appended to history.jsonl.',
    "- A checkpoint's content is byte-for-byte identical to the arguments you sent",
    '  for that call.',
    `To retry with a small correction, call \`${REPLAY_TOOL_NAME}\` once with`,
    "either previous_ordinal (the call's position 1/2/\u2026 in your previous message)",
    "or call_id (for an OLDER call — a failed",
    "call's id was given in its failure notice, and any call's id can be looked",
    'up in the tail of history.jsonl), plus old_string / new_string /',
    'replace_all. It applies your edit and immediately re-invokes the original',
    'tool with the edited arguments. Use this only when a small correction is',
    'needed; otherwise call the tool again with fresh arguments.',
  ].join('\n')
}

/** Static section B (PTC/code) with the session directory filled in. */
export function ptcSection(dir: string): string {
  return [
    'TOOL-CALL CHECKPOINT & REPLAY',
    'Every `run_code` call you make — i.e. everything you wrote in your tool call',
    `block, which is the full program — is checkpointed under ${dir},`,
    'whether it succeeds or fails: previous/1.json is a shortcut to your most',
    'recent program, which is kept as by-id/<id>.json, and an index line is',
    'appended to history.jsonl. Tools called INSIDE a program (including nested',
    '`run_code`) are not checkpointed separately.',
    '- Your most recent program is always previous/1.json; older programs are',
    '  under by-id/<id>.json — a failed run\'s id',
    '  was given in its failure notice, and any id can be looked up in the tail',
    '  of history.jsonl.',
    '- After a FAILED run, a notice tells you the call id and the checkpoint path.',
    '- To retry with a small correction: in a NEW `run_code` program, read the',
    '  checkpoint with tools.read, JSON.parse it, apply a literal replace on the',
    '  real program text, then run the corrected program as a real function and',
    '  return its value:',
    '      const prev = JSON.parse((await tools.read({ file_path: "<checkpoint path>" }))',
    '        .lines.map(line => line.text).join("\\n"));',
    '      const AsyncFunction = (async () => {}).constructor;',
    '      return await new AsyncFunction("tools", "console",',
    '        "\'use strict\';\\n" + prev.code.replace("const retries = 3", "const retries = 5"))(tools, console);',
    '  Use this only when a small correction is needed; otherwise write a fresh',
    '  program.',
  ].join('\n')
}

/** Tool guidance section for the replay tool (native only). */
export const REPLAY_GUIDANCE = [
  `Edit and replay a previous tool call's checkpointed arguments in ONE call.`,
  `For a call in your PREVIOUS message, pass previous_ordinal (its position 1/2/\u2026 in that message);`,
  `for an OLDER call, pass call_id (a failed call's id was given in its failure notice; any id can be looked up in the tail of history.jsonl).`,
  'previous_ordinal is only reliable when this replay call is the FIRST tool call of your message:',
  'after any earlier tool call in the same message (or for a parallel sibling), pass call_id instead.',
  'Exactly one of previous_ordinal / call_id must be provided. Provide old_string / new_string / replace_all:',
  'your edit is applied to the checkpoint and the original tool is immediately re-invoked with the edited arguments.',
  'Use this only when a small correction is needed; otherwise call the tool again with fresh arguments.',
].join(' ')

/** Failure notice C (native): saved + call id + a concrete one-call retry. */
export function nativeNotice(callId: string): UserMessage {
  return createUserMessage({
    source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'notice', summary: 'Failed tool call saved — small fixes can replay it' },
    content: [{
      type: 'text',
      text: [
        "Your failed call's arguments were saved.",
        `- call id: ${callId}`,
        `To retry with a small fix, call \`${REPLAY_TOOL_NAME}\` once:`,
        `  call_id: "${callId}", old_string: "<fragment to replace>", new_string: "<replacement>"`,
        'It applies your edit and immediately re-runs the tool. Only rewrite the',
        'arguments from scratch when the whole call must change.',
      ].join('\n'),
    }],
  })
}

/** Failure notice D (PTC): saved + by-id path + a concrete loader retry. */
export function ptcNotice(dir: string, idFileName: string): UserMessage {
  return createUserMessage({
    source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'notice', summary: 'Failed run_code program saved — small fixes can replay it' },
    content: [{
      type: 'text',
      text: [
        'Your failed `run_code` program was saved.',
        `- path: ${dir}/by-id/${idFileName}`,
        'To retry with a small fix, read that file with tools.read, JSON.parse it,',
        'apply a literal replace to the real program text (prev.code), then run',
        'the corrected program via:',
        '  new AsyncFunction("tools", "console", "\'use strict\';\\n" + corrected)(tools, console)',
        'Only rewrite the program from scratch when the whole program must change.',
      ].join('\n'),
    }],
  })
}
