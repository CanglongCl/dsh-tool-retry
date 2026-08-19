# dsh-tool-retry

[简体中文](./README.md)

> ⭐ If you find this project helpful, please consider giving it a Star! Your support motivates me to keep maintaining and improving it.

Tool-call retry for DeepSeek Harness. Every model tool-call block is checkpointed automatically; after a failure the model can change part of the original call and re-invoke the tool, instead of regenerating the whole long argument list.

## Installation

```sh
dsh plugin --profile web add @canglongcl/dsh-tool-retry
```

## How it works

Outside PTC mode the plugin registers the `editPreviousToolCalling` tool, which lets the model edit part of a previous tool call's arguments and immediately re-invokes that tool with the edited arguments.

In PTC mode no tool is registered. After a failed program the notice gives the checkpoint path; in a new `run_code` program the Agent can read it back, modify it through a script, and run the corrected program as a function via the `AsyncFunction` constructor.

## Mechanism

### Automatic checkpointing

- Every direct call is stored by its call id at `<tmpdir>/.../by-id/<tool-call-id>.json`, byte-identical to the raw argument string the model sent.

### Failure notice

- When a tool call with 150+ bytes of arguments fails, the model receives a hint: "saved + call id + a placeholder retry example".

### Replay tool `editPreviousToolCalling`

- Lets the model edit part of the original arguments by the failed call's ID and re-run the tool.
- Registered outside PTC mode only (PTC mode uses script replacement and re-execution).

## Evaluation

The project includes an evaluation suite for the real usage flow: whether the model actually adopts the replay path after the notice, how much argument re-sending each retry saves, and whether tasks still complete. It covers long/short arguments, plan rejection, argument type errors, stale fragments, whole-value replacement, and write-overwrite rejection.

Headline results: on long-argument tool failures the mechanism adoption rate is ≈94%; compared to re-sending the full arguments, the tool-call portion saves 74% tokens and the total saves 42%.

Design, how to run it, and how to read the results: see the [Eval suite](./eval/README.md); per-batch reports: [reports/index.html](./reports/index.html).

## Development

Development environment, loading model, design invariants and verification: see [AGENTS.md](./AGENTS.md); the full design: [docs/tool-calling-checkpoint-replay-plan.md](./docs/tool-calling-checkpoint-replay-plan.md).
