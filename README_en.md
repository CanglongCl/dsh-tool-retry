# dsh-tool-retry

[简体中文](./README.md)

> ⭐ If you find this project helpful, please consider giving it a Star! Your support motivates me to keep maintaining and improving it.

Tool-call checkpoint & replay for DeepSeek Harness (DSH). Every model tool-call block (success or failure) is checkpointed to the OS temp directory automatically; after a failure the model gets a minimal notice and can apply a small edit to the saved arguments and replay them instead of regenerating long arguments.

- **One unified logic across PTC (Code Mode / run_code) and native**: only model-direct tool-call blocks are checkpointed — in PTC that is the whole run_code program; tools called inside a program are never stored.
- **Two access forms**: by call id (by-id/, kept for the whole session) or by parallel-block order in the previous message (previous/1.json, previous/2.json… — symlink/shortcut aliases, re-pointed each round).
- **Zero filtering, one minimal notice per failure** ("saved + id + usage" only; the failure reason comes from the harness tool/result itself).
- **No harness source modification**: an independent npm plugin registered through a user preset.

## Installation

```sh
npm i -g @canglongcl/dsh-tool-retry
```

The plugin is an agent-level capability and registers through a **user preset** (shipped harness presets cannot be modified):

1. Duplicate a built-in preset in the DSH home (standard for native, PTC for code mode), or place a preset under ~/.dsh/.agent-presets/ (this repo provides tool-retry-standard / tool-retry-code templates).
2. Add one row to its agent.cordis.yml:

```yaml
- id: tool-retry
  name: '@canglongcl/dsh-tool-retry'
```

3. Select that preset for the session.

## Usage

### Native (standard) mode

1. When a tool call fails you receive a minimal notice containing the call id (e.g. call_00_…).
2. To retry with a small fix, call editPreviousToolCalling once:

```yaml
previous_ordinal: 1          # position in your previous message (alternative to call_id)
call_id: "call_00_…"         # exactly one of the two
old_string: "<original fragment>"
new_string: "<corrected fragment>"
replace_all: false
```

The tool applies the edit, parses the edited content as the new arguments, and immediately re-invokes the original tool — no read first, no path needed.

3. For older successful calls: tail <checkpoint-dir>/history.jsonl for the id, then replay by call_id.

### PTC (Code Mode) mode

No tool is registered. After a failed run the notice gives the checkpoint path; in a new run_code program, read/edit that file with the fs tools (the content is exactly the program you submitted — you may edit without reading first), then reconstruct the corrected program or extract long argument data from it.

## Features

### Automatic checkpointing

- by-id/<id>.json: the raw argument string of every call (byte-identical), kept for the whole session — the basis for multiple retries;
- previous/1.json, previous/2.json…: symlink/shortcut aliases to the previous message's parallel blocks (Windows without symlink privilege falls back to copies), re-pointed each round;
- history.jsonl: one appended index line per call (id/tool/turn/step/ordinal) — tail it to find any historical call.

### Failure notice

One minimal notice per failure (saved + id + usage). No repeated failure reason, no explanation — the full mechanics live in the static system-prompt section.

### Replay tool editPreviousToolCalling (native only)

Signature { previous_ordinal?, call_id?, old_string, new_string, replace_all } — exactly one of previous_ordinal / call_id, routed internally. Replays run the full tool pipeline (approval policies re-apply to the new arguments).

### Mode adaptation

- Code mode is detected when run_code is visible AND the codeRuntime plugin is loaded (the reserved name cannot be forged, so name-based detection is safe);
- In code mode editPreviousToolCalling is not registered and PTC prompt text is used.

## Storage and cleanup

- Directory: <os.tmpdir()>/.dsh/tool-checkpoints/<sessionId>/;
- The plugin deletes the session directory on session end; OS temp reclamation is the backstop;
- Contents are the exact raw argument strings the model sent, never wrapped.

## Evaluation

See §6 of docs/tool-calling-checkpoint-replay-plan.md: **mechanism verification** (a keyless scripted A/B over llm-replay — fixed transcript, no key, CI-gated; verifies checkpointing/notification/replay paths and fixed overhead, not model behavior) plus **real-model evaluation** (python SDK jsonrpc-agent, isolated workspace/session-id per arm — the only way to answer whether models actually adopt the path and how much they really save). This will land as an eval/ suite in this repo (mirroring dsh-web-review's eval structure).

## Development

Loading model, design invariants, and verification: see [AGENTS.md](./AGENTS.md); the full design (four prompt drafts with Chinese translations) lives in [docs/tool-calling-checkpoint-replay-plan.md](./docs/tool-calling-checkpoint-replay-plan.md).

```sh
pnpm install
pnpm gen-config        # regenerate the dev overlay (cordis.yml + entry-name.json)
pnpm install-presets   # install the tool-retry-standard / tool-retry-code user presets
pnpm dev               # link the dev alias and launch the harness Web CLI (needs DSH_HARNESS)
pnpm dev:headless -- "<one-shot task>"   # self-test: one headless session runs the full loop and exits
pnpm test              # unit + integration + built-bundle boundary regressions (vitest)
pnpm check             # repo gate: typecheck + tests + gen-config idempotence + official allowlist
pnpm package:official  # assemble the publishable official tarball under dist/
```

## Known limitations

- Without Windows Developer Mode/admin rights, previous/ aliases fall back to copies (edits through an alias change the copy only);
- both mode is treated as code mode (the public API cannot distinguish), so the replay tool is not registered there;
- In PTC the retry path is eval-in-place: read the checkpoint, JSON.parse it, apply a literal replace on the real program text (`prev.code`), then `eval` the corrected program — no JSON escaping enters the match; if the retry itself fails, the new checkpoint holds the loader (its file_path still points at the original program);
- Replaying an UNKNOWN_TOOL checkpoint fails again (expected);
- The OS temp directory may be reclaimed (within a session the plugin recreates directories as needed);
- ABORTED boundary (verified; see AGENTS.md "Zero filtering"): a call cancelled at entry takes the `final-result` stage and bypasses post-execute — neither checkpointed nor notified; a post-body ABORTED checkpoints (the waterfall saw the call) but its result replacement happens after our decision, so it gets no notice.
