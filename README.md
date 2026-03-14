# Autoresearch Plugin for OpenCode

An OpenCode plugin that implements an autonomous keep/discard experiment loop for optimizing code through iterative experimentation.

## Features

- **Experiment Tracking**: Record and track experiments with metrics in JSONL format
- **Git Integration**: Keep or discard experiments with proper git safety
- **Metric Parsing**: Automatically parse `METRIC name=value` output lines
- **Markdown Documentation**: Auto-generated human-readable experiment logs
- **Checks Support**: Optional validation via `autoresearch.checks.sh`
- **AI Skill**: Included skill provides guided workflows and best practices

## Installation

### Local Development

Add to your OpenCode configuration:

```json
{
  "plugin": ["file:///path/to/oc-autoresearch"]
}
```

### From npm (when published)

```json
{
  "plugin": ["@sndrgrdn/opencode-autoresearch"]
}
```

### Using the Skill

Copy the skill to your OpenCode skills directory:

```bash
mkdir -p ~/.config/opencode/skills/autoresearch
cp node_modules/@sndrgrdn/opencode-autoresearch/skills/autoresearch/SKILL.md ~/.config/opencode/skills/autoresearch/
```

The skill provides guided workflows and best practices for the autoresearch loop.

## Tools

### init_experiment

Initialize a new autoresearch experiment session.

```json
{
  "name": "optimize-parser",
  "metric_name": "parse_time",
  "metric_unit": "ms",
  "direction": "lower",
  "command": "node benchmark.js",
  "branch": "experiment/parser-opt",
  "files_in_scope": ["src/parser.js", "src/lexer.js"]
}
```

### run_experiment

Execute the experiment command and capture metrics.

```json
{
  "timeout_seconds": 600,
  "checks_timeout_seconds": 300
}
```

### log_experiment

Log the experiment result with decision.

```json
{
  "run_id": "uuid-from-run",
  "commit": "abc123",
  "metric": 45.2,
  "status": "keep",
  "description": "Refactored parse loop to use iterator",
  "metrics": {
    "memory_mb": 128
  }
}
```

### keep_experiment

Commit the current experiment changes.

```json
{
  "commit_message": "perf(parser): optimize parse loop using iterator"
}
```

### discard_experiment

Discard uncommitted changes (requires confirmation).

```json
{
  "confirmation": "DISCARD"
}
```

### autoresearch_status

Get current session status including metrics and counts.

## Workflow

1. **Initialize**: `init_experiment` creates `autoresearch.jsonl` and `autoresearch.md`
2. **Baseline**: `run_experiment` to establish baseline metrics
3. **Log**: `log_experiment` to record the baseline
4. **Iterate**:
   - Edit code
   - `run_experiment` to measure
   - `log_experiment` to record decision
   - `keep_experiment` or `discard_experiment`
5. **Status**: `autoresearch_status` to review progress

## Metric Format

Experiments should output metrics in this format:

```
METRIC parse_time=45.2
METRIC memory_mb=128
METRIC throughput=1000
```

## Files Created

- `autoresearch.jsonl` - Append-only event log
- `autoresearch.md` - Human-readable experiment notes
- `autoresearch.checks.sh` - Optional validation script

## Development

```bash
# Install dependencies
bun install

# Type check
bun run typecheck

# Build
bun run build

# Smoke test
bun run smoke

# Watch mode
bun run dev
```

## License

MIT
