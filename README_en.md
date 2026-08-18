# dsh-tool-retry

[简体中文](./README.md)

> ⭐ If you find this project helpful, please consider giving it a Star! Your support motivates me to keep maintaining and improving it.

Tool-call checkpoint & replay for DeepSeek Harness (DSH). Every model tool-call block (success or failure) is checkpointed to the OS temp directory automatically; after a failure the model gets a minimal notice and can apply a small edit to the saved arguments and replay them instead of regenerating long arguments.

- **One unified logic across PTC (Code Mode / run_code) and native**: only model-direct tool-call blocks are checkpointed — in PTC that is the whole run_code program; tools called inside a program are never stored.
- **Two access forms**: by call id (by-id/, kept for the whole session) or by parallel-block order in the previous message (previous/1.json, previous/2.json… — symlink/shortcut aliases, re-pointed each round).
- **Zero filtering for the store, byte-gated notices**: every direct call is checkpointed (any tool, any error code); the failure notice fires only when the raw arguments are ≥150 UTF-8 bytes — below that, a fresh re-send is cheaper than the replay call's routing structure, so the hint would be a net loss. The notice says "saved + id + usage" only; the failure reason comes from the harness tool/result itself.
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
call_id: "call_00_…"         # location: call id or previous_ordinal (exactly one)
patch:                       # the ONLY edit payload: fix one field by path
  - path: ".plan"            # dot segments + [n] indexes, from a top-level key
    old_string: "keep the Python 2 runtime"   # fragment replace inside the string value (matches the DECODED text, no JSON escaping)
    new_string: "switch to the Rust runtime"
  # or replace the whole value / change its type: { path: ".version", value: 2 }
  # or delete a field: { path: ".config.legacy" } (omit both value and old/new)
```

The tool parses the checkpoint, applies the patch, persists it, and immediately re-invokes the original tool — no read first, no path needed.

3. For older successful calls: tail <checkpoint-dir>/history.jsonl for the id, then replay by call_id.

### PTC (Code Mode) mode

No tool is registered. After a failed run the notice gives the checkpoint path; in a new run_code program, read/edit that file with the fs tools (the content is exactly the program you submitted — you may edit without reading first), then reconstruct the corrected program or extract long argument data from it.

## Features

### Automatic checkpointing

- by-id/<id>.json: the raw argument string of every call (byte-identical), kept for the whole session — the basis for multiple retries;
- previous/1.json, previous/2.json…: symlink/shortcut aliases to the previous message's parallel blocks (Windows without symlink privilege falls back to copies), re-pointed each round;
- history.jsonl: one appended index line per call (id/tool/turn/step/ordinal) — tail it to find any historical call.

### Failure notice

One minimal notice per failure with ≥150-byte raw arguments (saved + id + a placeholder retry example). No repeated failure reason, no explanation. editPreviousToolCalling's own failures always notify — the notice points the retry back at the ORIGINAL call id (corrective, not economic). The static system-prompt section carries three XML-shaped examples (plan rejected — fix one section / stale edit fragment / wrong type — replace the whole value); the tool's own description is the single source of the usage rules.

### Replay tool editPreviousToolCalling (native only)

Signature { previous_ordinal?, call_id?, patch } — exactly one of previous_ordinal / call_id; patch is the only payload (required, non-empty) with entries { path, value? | old_string?, new_string?, replace_all? }: value replaces the whole value at the path (any JSON type; omitting it deletes the field, array indexes splice); old/new applies a literal replace inside the string value at the path, matched against its DECODED text (JSON escaping never enters the model's view; duplicate matches error with the count, replace_all replaces all). A missing path errors with the top-level key list. Replays run the full tool pipeline (approval policies re-apply to the new arguments).

### Mode adaptation

- Code mode is detected when run_code is visible AND the codeRuntime plugin is loaded (the reserved name cannot be forged, so name-based detection is safe);
- In code mode editPreviousToolCalling is not registered and PTC prompt text is used.

## Storage and cleanup

- Directory: <os.tmpdir()>/.dsh/tool-checkpoints/<sessionId>/;
- The plugin deletes the session directory on session end; OS temp reclamation is the backstop;
- Contents are the exact raw argument strings the model sent, never wrapped.

## Evaluation

The eval suite lives in this repo and is re-run with every change (scripts/eval-harness*.ts; HTML reports persisted under reports/ with the full per-run tool calls):

- **How it runs**: `pnpm eval:real` drives the REAL DSH CLI per scenario in ON/OFF arms — the ON arm adds exactly one plugin row, and failures happen LIVE in the run (so the notice channel really fires); `--repeat N` controls variance, `pnpm eval:report` renders the report. A keyless mechanism A/B (fixed transcript, CI-gated) verifies the checkpoint/notice/replay paths without measuring model behavior.
- **Corpus**: minimal live scenarios (short/long args, plan rejection, type errors) plus crops of real sessions (a real 10.5K-char plan among them).
- **Latest headline numbers** (reports 019/022, deepseek-v4-flash, reasoning high):
  - **Long args + "fix one spot" failures: ~94% adoption** — 14/15 across five mini long-arg scenarios ×3 repeats, 2/2 on the real 10.5K-char plan with a one-line fix; each retry re-sends 190–10,700 fewer argument bytes (OFF re-emits the whole thing, ON patches tens-to-hundreds of bytes);
  - **Short args (<150 bytes): no notice, 0 attempts, 0 waste** — a fresh re-send beats a routing-laden replay there, and the byte gate enforces exactly that;
  - **Research-type feedback (the real plan rejection): 0 adoption by design** — the model's reasoning quotes the "small corrections only, otherwise re-send" guidance verbatim and rewrites (~40% changed), keeping the replay path inside the economic zone where it actually saves;
  - **Success rate**: retrySuccess is effectively 100% across all measurable scenarios; honest caveat — at mini scale the ~+1K input overhead of notice+examples makes total-token deltas mixed, and the decisive net savings appear on failures whose single re-send is hundreds of bytes or more (10K scale: decisive).

## Development

Loading model, design invariants, and verification: see [AGENTS.md](./AGENTS.md); the full design (four prompt drafts with Chinese translations) lives in [docs/tool-calling-checkpoint-replay-plan.md](./docs/tool-calling-checkpoint-replay-plan.md).

```sh
pnpm install
pnpm gen-config        # regenerate the dev overlay (cordis.yml + entry-name.json)
pnpm install-presets   # install the tool-retry-standard / tool-retry-code user presets
pnpm dev               # link the dev alias and launch the harness Web CLI (needs DSH_HARNESS)
pnpm dev:headless -- "<one-shot task>"   # self-test: one headless session runs the full loop and exits
pnpm test              # unit + integration + code-mode integration + keyless A/B + eval-resume smoke (vitest)
pnpm build:fixtures    # regenerate the breakpoint corpora (replay-fixtures/ + eval-fixtures/; check verifies idempotence)
pnpm e2e:real          # real-API e2e (native + PTC; needs DEEPSEEK_API_KEY, auto-skips without it)
pnpm eval:real         # real-model evaluation (plan §6: per scenario x arm x N; key via env -> repo .env -> ~/.dsh/.env chain)
pnpm eval:report        # render the HTML report, persisted to reports/NNN-...html (git hash/model/reasoning/token metadata, click-to-expand full tool calls per run)
pnpm check             # repo gate: typecheck + tests + fixture/gen-config idempotence + official allowlist
pnpm package:official  # assemble the publishable official tarball under dist/
pnpm release:verify   # release identity verification (first CI step; mandatory before tag-triggered publishing)
```

## Publishing to npm

Releases run entirely in GitHub Actions; locally you only sync versions and push a tag:

1. Keep the `version` in `packages/dsh-tool-retry/package.json` and the root `package.json` in sync, commit, and push to main;
2. Tag the release: `git tag v<version> && git push origin v<version>`.

The pipeline [.github/workflows/release-npm.yml](./.github/workflows/release-npm.yml) then runs:

1. `pnpm release:verify` — checks package identity (name, public access, repository metadata, root/package version sync, tag/version match);
2. `pnpm check` — the repo quality gate (typecheck, unit suite, fixture and config idempotence, official allowlist);
3. `pnpm package:official` — assembles the tarball, verifies the SHA256, and uploads it as a build artifact;
4. the publish job (tag-triggered only) — publishes **those exact verified bytes** to npmjs.org via npm Trusted Publishing (GitHub OIDC, no long-lived token); prerelease versions automatically use the `next` tag.

Prerequisite: the npm account must enable Trusted Publishing for the `@canglongcl` scope and authorize the GitHub repository `CanglongCl/dsh-tool-retry`; no npm token is stored or allowed in the repo.

## Known limitations

- Without Windows Developer Mode/admin rights, previous/ aliases fall back to copies (edits through an alias change the copy only);
- both mode is treated as code mode (the public API cannot distinguish), so the replay tool is not registered there;
- In PTC the retry path is loader-based: read the checkpoint, JSON.parse it, apply a literal replace on the real program text (`prev.code`), then run the corrected program through the `AsyncFunction` constructor and return its value — top-level `return`/`await` keep their native run_code semantics (plain eval rejects `return` in strict mode); if the retry itself fails, the new checkpoint holds the loader (its file_path still points at the original program);
- Replaying an UNKNOWN_TOOL checkpoint fails again (expected);
- The OS temp directory may be reclaimed (within a session the plugin recreates directories as needed);
- ABORTED boundary (verified; see AGENTS.md "Zero filtering"): a call cancelled at entry takes the `final-result` stage and bypasses post-execute — neither checkpointed nor notified; a post-body ABORTED checkpoints (the waterfall saw the call) but its result replacement happens after our decision, so it gets no notice.
