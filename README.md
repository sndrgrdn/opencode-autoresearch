# opencode-autoresearch — autonomous experiment loop for OpenCode

**[Install](#install)** · **[Usage](#usage)** · **[How it works](#how-it-works)**

*Try an idea, measure it, keep what works, discard what doesn't, repeat.*

Inspired by [davebcn87/pi-autoresearch](https://github.com/davebcn87/pi-autoresearch), which applies the same core loop to pi, and by [karpathy/autoresearch](https://github.com/karpathy/autoresearch).

Works for any optimization target: test speed, build time, parser latency, memory use, bundle size, training metrics, or custom benchmark output.

---

## What's included

| | |
|---|---|
| **Plugin** | OpenCode tools for initializing sessions, running benchmarks, logging results, keeping wins, and discarding failures |
| **Skill** | `autoresearch` workflow that gathers the target, writes session files, establishes a baseline, and keeps looping |

### Plugin tools

| Tool | Description |
|------|-------------|
| `init_experiment` | One-time session config: name, metric, unit, direction, command, scope |
| `run_experiment` | Runs the benchmark command, captures `METRIC name=value` lines, optionally runs checks |
| `log_experiment` | Records keep/discard/crash/checks-failed decisions and updates session files |
| `keep_experiment` | Stages and commits a kept experiment |
| `discard_experiment` | Restores the worktree to the pre-experiment state |
| `autoresearch_status` | Shows session stats, best result, branch, and dirty state |

### Session files

| File | Purpose |
|------|---------|
| `autoresearch.jsonl` | Append-only event log for config, runs, and experiment decisions |
| `autoresearch.md` | Human-readable session doc with baseline, best run, and experiment history |
| `autoresearch.checks.sh` | Optional correctness gate run after passing benchmarks |

---

## Install

### Plugin

```json
{
  "plugin": ["@sndrgrdn/opencode-autoresearch"]
}
```

### Skill

Copy the bundled skill into your OpenCode skills directory:

```bash
mkdir -p ~/.config/opencode/skills/autoresearch
curl -fsSL https://raw.githubusercontent.com/sndrgrdn/opencode-autoresearch/master/skills/autoresearch/SKILL.md -o ~/.config/opencode/skills/autoresearch/SKILL.md
```

Then reload OpenCode if needed.

---

## Usage

### 1. Start autoresearch

```text
/autoresearch
```

The skill asks about your goal, command, metric, and files in scope - or infers them from context. It then sets up the session, writes the session files, runs the baseline, and starts the loop.

### 2. The loop

The core workflow is:

```text
edit -> run_experiment -> log_experiment -> keep_experiment or discard_experiment -> repeat
```

Every run is written to `autoresearch.jsonl`, so the session can survive restarts and be resumed by a fresh agent.

### 3. Monitor progress

Use `autoresearch_status` anytime to inspect:

- run counts
- keep/discard/crash/check-failure counts
- baseline metric
- best kept metric
- current branch and git dirty state

---

## Example domains

| Domain | Metric | Command |
|--------|--------|---------|
| Test speed | seconds ↓ | `bun test` |
| Build speed | seconds ↓ | `bun run build` |
| Parser latency | ms ↓ | `node benchmark.js` |
| Bundle size | bytes ↓ | `bun run build && du -sb dist` |
| Model quality | score ↑ | `python train.py` |

---

## How it works

The **plugin** provides the mechanics. The **skill** provides the workflow.

```text
Plugin: tool execution, event logging, markdown updates, git keep/discard
Skill: target selection, file scoping, baseline setup, experiment strategy
```

This split keeps the plugin generic while letting the skill drive autonomous optimization behavior.

Two files make the session resumable:

```text
autoresearch.jsonl  - append-only log of every config, run, and experiment decision
autoresearch.md     - living document with objective, baseline, best run, and history
```

A new agent can read those files and continue from the current state without prior chat context.

---

## Backpressure checks

Create `autoresearch.checks.sh` when you want correctness gates after successful benchmark runs.

```bash
#!/bin/bash
set -euo pipefail
bun test
bun run typecheck
```

Or pass `checks_command` to `init_experiment`.

Behavior:

- checks run only after a benchmark exits successfully
- check time does not affect the primary metric
- failing checks mark the run as `checks_failed`
- failed checks block `keep_experiment`
- checks use a separate timeout from the benchmark command

---

## Tool examples

### `init_experiment`

```json
{
  "name": "optimize-parser",
  "metric_name": "parse_time",
  "metric_unit": "ms",
  "direction": "lower",
  "command": "node benchmark.js",
  "checks_command": "bun test && bun run typecheck",
  "branch": "autoresearch/parser",
  "files_in_scope": ["src/parser.js", "src/lexer.js"]
}
```

### `run_experiment`

```json
{
  "timeout_seconds": 600,
  "checks_timeout_seconds": 300
}
```

### `log_experiment`

```json
{
  "run_id": "uuid-from-run",
  "commit": "abc123",
  "metric": 45.2,
  "status": "keep",
  "description": "Refactored parse loop to reduce allocations",
  "metrics": {
    "memory_mb": 128
  }
}
```

### `keep_experiment`

```json
{
  "commit_message": "perf(parser): reduce allocations in parse loop"
}
```

### `discard_experiment`

```json
{
  "confirmation": "DISCARD"
}
```

---

## Metric format

Benchmarks should print metrics as plain lines:

```text
METRIC parse_time=45.2
METRIC memory_mb=128
METRIC throughput=1000
```

`run_experiment` parses those lines automatically and uses the configured primary metric for decisions.

---

## Development

```bash
bun install
bun run typecheck
bun run build
bun run smoke
bun run dev
```

---

## Credit

This project is heavily inspired by the structure and UX of [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) by [davebcn87](https://github.com/davebcn87), adapted for the OpenCode plugin/tool model.

## License

MIT
