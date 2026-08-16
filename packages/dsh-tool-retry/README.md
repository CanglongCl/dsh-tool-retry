# @canglongcl/dsh-tool-retry

External DSH agent-plane plugin that checkpoints every model tool-call block (success or failure) to the OS temp directory, injects one minimal notice per failed call, and provides the editPreviousToolCalling replay tool (native mode) so the model can fix a saved call's arguments instead of regenerating them. In code mode (PTC) no tool is registered; the model replays by reading the checkpoint inside a new run_code program, JSON.parsing it, applying a literal replace on the real program text, and submitting the corrected program as the next run.

The harness checkout is not modified.

See the repository [AGENTS.md](../../AGENTS.md) for loading, invariants, and testing contracts. The accepted design lives in [docs/tool-calling-checkpoint-replay-plan.md](../../docs/tool-calling-checkpoint-replay-plan.md) (appendix B holds the four model-facing prompt drafts and their Chinese review translations).

## Usage

```bash
pnpm install
pnpm gen-config        # regenerate the dev overlay after moving the repo
pnpm install-presets   # install the two user presets under ~/.dsh/.agent-presets/
pnpm dev               # launch the harness CLI with the dev alias linked
pnpm dev:headless -- "<task>"  # one-shot self-test session through the headless profile
pnpm test              # unit + integration + built-bundle boundary regressions
pnpm check             # typecheck + unit suite + gen-config idempotence + staging allowlist
pnpm package:official  # stage the publishable tarball under dist/
```

## Storage model

```text
<os.tmpdir()>/.dsh/tool-checkpoints/<sessionId>/
├── history.jsonl                    # appended index: { id, tool, turn, step, ordinal }
├── by-id/<sanitize(id)>.json        # the only real store; kept for the session
└── previous/1.json -> ../by-id/<id> # aliases for the previous message's parallel
                                     # blocks; rebuilt each round (Windows: copy fallback)
```

## Context model

### What the model sees

- **Static system-prompt section** tool:checkpoint-replay (order 149): the two access forms (by-id files and previous/1.json aliases), history.jsonl lookup, the usage matrix (previous message -> ordinal, older -> call id: failed ids were injected, successful ids come from history.jsonl), and the replay-tool usage. The PTC flavor describes the checkpoint as the whole previous run_code program.
- **Per-failure notice** (every failure, via tools/post-execute additionalContexts): "saved + call id (+ by-id path in PTC) + use editPreviousToolCalling (PTC: edit/read + tools.run_code)". The failure reason is NOT repeated — the harness tool/result already carries it.
- **Replay tool editPreviousToolCalling** (native only): { previous_ordinal?, call_id?, old_string, new_string, replace_all }, exactly one locator; edits the by-id file internally and re-invokes the original tool with the edited arguments.
- The model never computes ids or paths; ids are injected verbatim and echoed back.

### Token effect

- Static section: ~100-180 tokens once per prompt assembly (mode-conditional).
- Each failure notice: ~20-40 tokens, once per failure.
- Checkpoint files and history.jsonl are not injected; the model pays nothing unless it chooses to read them.

### KV Cache effect

- No per-turn context mutation beyond the static section and the occasional failure notice, so KV-cache reuse is unaffected in ordinary steps.

## Known Limitations and Deferred Work

- Windows alias fallback is a content copy (edits through an alias diverge from by-id/).
- both mode is treated as code mode: the replay tool is not registered.
- PTC retry guidance is parse-first: JSON.parse + literal replace on the parsed program text (no JSON escaping in the match); the remaining risk is short-fragment ambiguity — the guidance tells the model to use a longer unique fragment.
- v1 embeds replay audit data in tool/result meta; a dedicated tool/replay session event is deferred (requires harness core changes).
- Non-local fs backends (e.g. e2b) skip previous/ aliases; notices still carry exact paths.
- ABORTED boundary (verified; see AGENTS.md "Zero filtering"): ABORTED_BEFORE_DISPATCH bypasses post-execute entirely (no checkpoint, no notice); a post-body ABORTED checkpoints but its result replacement happens after our decision (no notice).
