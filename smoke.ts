import { $ } from "bun";
import { mkdtemp, readFile, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { AutoresearchPlugin } from "./dist/index.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "oc-autoresearch-smoke-"));

  const hooks = await AutoresearchPlugin({
    client: {} as never,
    project: {} as never,
    directory,
    worktree: directory,
    serverUrl: new URL("http://localhost"),
    $,
  });

  const tools = hooks.tool;
  assert(tools, "Plugin did not expose any tools");

  const expectedTools = [
    "init_experiment",
    "run_experiment",
    "log_experiment",
    "keep_experiment",
    "discard_experiment",
    "autoresearch_status",
  ];

  for (const name of expectedTools) {
    assert(name in tools, `Missing tool: ${name}`);
  }

  const context = {
    sessionID: "smoke-session",
    messageID: "smoke-message",
    agent: "smoke",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  };

  const initResult = JSON.parse(
    await tools.init_experiment.execute(
      {
        name: "smoke-test",
        metric_name: "latency_ms",
        direction: "lower",
      },
      context,
    ),
  );

  assert(initResult.success === true, "init_experiment did not succeed");

  const statusResult = JSON.parse(
    await tools.autoresearch_status.execute({}, context),
  );

  assert(statusResult.segment === 1, "Unexpected experiment segment");
  assert(
    statusResult.experiment_name === "smoke-test",
    "Status did not return the expected experiment name",
  );

  const files = await readdir(directory);
  assert(files.includes("autoresearch.jsonl"), "Missing autoresearch.jsonl");
  assert(files.includes("autoresearch.md"), "Missing autoresearch.md");

  const jsonl = await readFile(join(directory, "autoresearch.jsonl"), "utf-8");
  assert(jsonl.includes('"type":"config"'), "JSONL file missing config event");

  console.log("Smoke test passed");
}

await main();
