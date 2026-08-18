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
    'After a failed call, a notice gives you the call id, so you can retry with',
    'one small fix, e.g.:',
    `  ${REPLAY_TOOL_NAME}({ call_id: "<id>", patch: [{ path: ".config.mode",`,
    '    old_string: "dev", new_string: "prod" }] })',
    "Follow the rules in that tool's own description, and retry this way only",
    'for a small correction.',
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

/** Failure notice C (native): saved + call id + a concrete one-call retry.
 * When the failed call was itself an edit of another call, the hint carries
 * the original call id the retry should target instead. */
export function nativeNotice(callId: string, hint?: { editedCallId?: string }): UserMessage {
  const retryTarget = hint?.editedCallId ?? callId
  const lines = [
    "Your failed call's arguments were saved.",
    `- call id: ${callId}`,
    'To retry with a small fix:',
    `  ${REPLAY_TOOL_NAME}({ call_id: "${retryTarget}", patch: [{ path: ".field.to.fix",`,
    '    old_string: "<fragment>", new_string: "<replacement>" }] })',
    '  (to replace the whole value at the path instead: value: <replacement>)',
  ]
  if (hint?.editedCallId !== undefined && hint.editedCallId !== callId) {
    lines.push(`(the call above failed while editing call id "${hint.editedCallId}" — retry that original call id)`)
  }
  return createUserMessage({
    source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'notice', summary: 'Failed tool call saved — small fixes can replay it' },
    content: [{ type: 'text', text: lines.join('\n') }],
  })
}

/** Failure notice D (PTC): saved + by-id path; the retry recipe lives in the
 * static PTC section (the only place it is written). */
export function ptcNotice(dir: string, idFileName: string): UserMessage {
  return createUserMessage({
    source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'notice', summary: 'Failed run_code program saved — small fixes can replay it' },
    content: [{
      type: 'text',
      text: [
        'Your failed `run_code` program was saved.',
        `- path: ${dir}/by-id/${idFileName}`,
        'To retry with a small fix, follow the retry recipe in the "TOOL-CALL',
        'CHECKPOINT & REPLAY" prompt section.',
      ].join('\n'),
    }],
  })
}
