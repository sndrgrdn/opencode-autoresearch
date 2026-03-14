import { tool } from "@opencode-ai/plugin";
import type { Plugin, PluginInput, ToolContext } from "@opencode-ai/plugin";

type Shell = PluginInput["$"];
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { readFile, appendFile, writeFile } from "fs/promises";
import { z as zod } from "zod";

// --- types ---
export const DirectionSchema = zod.enum(["lower", "higher"]);
export type Direction = zod.infer<typeof DirectionSchema>;

export const ExperimentStatusSchema = zod.enum([
  "keep",
  "discard",
  "crash",
  "checks_failed",
]);
export type ExperimentStatus = zod.infer<typeof ExperimentStatusSchema>;

export const RunStatusSchema = zod.enum([
  "ok",
  "timeout",
  "crash",
  "checks_failed",
]);
export type RunStatus = zod.infer<typeof RunStatusSchema>;

export const ConfigEventSchema = zod.object({
  type: zod.literal("config"),
  timestamp: zod.iso.datetime(),
  name: zod.string(),
  metric_name: zod.string(),
  metric_unit: zod.string().optional(),
  direction: DirectionSchema,
  command: zod.string().optional(),
  checks_command: zod.string().optional(),
  branch: zod.string().optional(),
  files_in_scope: zod.array(zod.string()).optional(),
  segment: zod.number().int().nonnegative(),
});
export type ConfigEvent = zod.infer<typeof ConfigEventSchema>;

export const MetricsSchema = zod.record(zod.string(), zod.number());
export type Metrics = Record<string, number>;

export const RunEventSchema = zod.object({
  type: zod.literal("run"),
  timestamp: zod.iso.datetime(),
  run_id: zod.string(),
  segment: zod.number().int().nonnegative(),
  command: zod.string(),
  status: RunStatusSchema,
  duration_seconds: zod.number(),
  timed_out: zod.boolean().optional(),
  exit_code: zod.number().optional(),
  metrics: MetricsSchema,
  checks_pass: zod.boolean().optional(),
  checks_duration_seconds: zod.number().optional(),
  log_tail: zod.string().optional(),
});
export type RunEvent = zod.infer<typeof RunEventSchema>;

export const ExperimentEventSchema = zod.object({
  type: zod.literal("experiment"),
  timestamp: zod.iso.datetime(),
  run_id: zod.string(),
  segment: zod.number().int().nonnegative(),
  commit_before: zod.string(),
  commit_after: zod.string().optional(),
  metric: zod.number(),
  metrics: MetricsSchema.optional(),
  status: ExperimentStatusSchema,
  description: zod.string(),
});
export type ExperimentEvent = zod.infer<typeof ExperimentEventSchema>;

export const EventSchema = zod.union([
  ConfigEventSchema,
  RunEventSchema,
  ExperimentEventSchema,
]);
export type Event = zod.infer<typeof EventSchema>;

export interface ExperimentSession {
  segment: number;
  config?: ConfigEvent;
  runs: RunEvent[];
  experiments: ExperimentEvent[];
}

export interface StatusSummary {
  segment: number;
  total_runs: number;
  keep_count: number;
  discard_count: number;
  crash_count: number;
  checks_failed_count: number;
  baseline_metric: number | null;
  best_metric: number | null;
  best_run_id: string | null;
  current_branch: string | null;
  git_dirty: boolean;
  direction: Direction | null;
  metric_name: string | null;
}

// --- state ---
const JSONL_FILE = "autoresearch.jsonl";
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 600;
const DEFAULT_CHECKS_TIMEOUT_SECONDS = 300;

function normalizeTimeoutSeconds(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

async function loadEvents(directory: string): Promise<Event[]> {
  const filePath = `${directory}/${JSONL_FILE}`;
  if (!existsSync(filePath)) {
    return [];
  }

  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim() !== "");

  const events: Event[] = [];
  let malformedLineCount = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const result = EventSchema.safeParse(parsed);
      if (result.success) {
        events.push(result.data);
      } else {
        malformedLineCount += 1;
      }
    } catch {
      malformedLineCount += 1;
    }
  }

  if (malformedLineCount > 0) {
    console.warn(
      `Skipped ${malformedLineCount} malformed autoresearch event(s) in ${filePath}`,
    );
  }

  return events;
}

async function appendEvent(directory: string, event: Event): Promise<void> {
  const filePath = `${directory}/${JSONL_FILE}`;
  const line = JSON.stringify(event) + "\n";
  await appendFile(filePath, line, "utf-8");
}

function getCurrentSegment(events: Event[]): number {
  const configEvents = events.filter(
    (e): e is ConfigEvent => e.type === "config",
  );
  if (configEvents.length === 0) {
    return 0;
  }
  return Math.max(...configEvents.map((e) => e.segment));
}

function getSession(
  events: Event[],
  segment: number,
): ExperimentSession {
  const config = events.find(
    (e): e is ConfigEvent => e.type === "config" && e.segment === segment,
  );

  const runs = events.filter(
    (e): e is RunEvent => e.type === "run" && e.segment === segment,
  );

  const experiments = events.filter(
    (e): e is ExperimentEvent =>
      e.type === "experiment" && e.segment === segment,
  );

  return { segment, config, runs, experiments };
}

function getCurrentConfig(events: Event[]): ConfigEvent | undefined {
  const segment = getCurrentSegment(events);
  return events.find(
    (e): e is ConfigEvent => e.type === "config" && e.segment === segment,
  );
}

function findRun(events: Event[], runId: string): RunEvent | undefined {
  return events.find((e): e is RunEvent => e.type === "run" && e.run_id === runId);
}

function computeStatusSummary(
  events: Event[],
  currentBranch: string | null,
  gitDirty: boolean,
): StatusSummary {
  const segment = getCurrentSegment(events);
  const session = getSession(events, segment);
  const config = session.config;

  const keep_count = session.experiments.filter(
    (e) => e.status === "keep",
  ).length;
  const discard_count = session.experiments.filter(
    (e) => e.status === "discard",
  ).length;
  const crash_count = session.experiments.filter(
    (e) => e.status === "crash",
  ).length;
  const checks_failed_count = session.experiments.filter(
    (e) => e.status === "checks_failed",
  ).length;

  const baselineRun = session.runs.find((r) => r.status === "ok");
  const baseline_metric =
    config && baselineRun ? (baselineRun.metrics[config.metric_name] ?? null) : null;

  let best_metric: number | null = null;
  let best_run_id: string | null = null;

  if (config) {
    const validExperiments = session.experiments.filter((e) => e.status === "keep");

    if (validExperiments.length > 0) {
      if (config.direction === "lower") {
        const best = validExperiments.reduce((min, e) =>
          e.metric < min.metric ? e : min,
        );
        best_metric = best.metric;
        best_run_id = best.run_id;
      } else {
        const best = validExperiments.reduce((max, e) =>
          e.metric > max.metric ? e : max,
        );
        best_metric = best.metric;
        best_run_id = best.run_id;
      }
    }
  }

  return {
    segment,
    total_runs: session.runs.length,
    keep_count,
    discard_count,
    crash_count,
    checks_failed_count,
    baseline_metric,
    best_metric,
    best_run_id,
    current_branch: currentBranch,
    git_dirty: gitDirty,
    direction: config?.direction ?? null,
    metric_name: config?.metric_name ?? null,
  };
}

// --- git ---
interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  isDirty: boolean;
  hasStaged: boolean;
  hasUnstaged: boolean;
  untrackedFiles: string[];
}

async function getGitStatus($: Shell, directory: string): Promise<GitStatus> {
  try {
    const result = await $`git -C ${directory} status --porcelain -b`
      .quiet()
      .nothrow();
    if (result.exitCode !== 0) {
      return {
        isRepo: false,
        branch: null,
        isDirty: false,
        hasStaged: false,
        hasUnstaged: false,
        untrackedFiles: [],
      };
    }

    const output = result.stdout.toString();
    const lines = output.split("\n");

    let branch: string | null = null;
    const statusLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("## ")) {
        const match = line.match(/^##\s+(\S+)/);
        if (match) {
          const branchName = match[1].replace(/^\*/, "").trim();
          if (branchName) {
            branch = branchName;
          }
        }
      } else if (line.trim()) {
        statusLines.push(line);
      }
    }

    let hasStaged = false;
    let hasUnstaged = false;
    const untrackedFiles: string[] = [];

    for (const line of statusLines) {
      if (line.startsWith("??") && line.length > 3) {
        untrackedFiles.push(line.slice(3));
      } else if (line.length > 1) {
        const status = line[1];
        if (status === "M" || status === "D") {
          hasUnstaged = true;
        }
        if (line[0] === " " && (status === "M" || status === "D")) {
          hasStaged = true;
        }
      }
    }

    return {
      isRepo: true,
      branch,
      isDirty: statusLines.length > 0,
      hasStaged,
      hasUnstaged,
      untrackedFiles,
    };
  } catch {
    return {
      isRepo: false,
      branch: null,
      isDirty: false,
      hasStaged: false,
      hasUnstaged: false,
      untrackedFiles: [],
    };
  }
}

async function stageAll($: Shell, directory: string): Promise<void> {
  const result = await $`git -C ${directory} add -A`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Failed to stage changes: ${result.stderr.toString()}`);
  }
}

async function commit(
  $: Shell,
  directory: string,
  message: string,
): Promise<string> {
  const result = await $`git -C ${directory} commit -m ${message}`
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Failed to commit: ${result.stderr.toString()}`);
  }

  const commitResult =
    await $`git -C ${directory} rev-parse --short HEAD`.quiet();
  return commitResult.stdout.toString().trim();
}

async function discardChanges($: Shell, directory: string): Promise<void> {
  await $`git -C ${directory} reset --hard`.quiet().nothrow();
  await $`git -C ${directory} clean -fd`.quiet().nothrow();
}

// --- metrics ---
const METRIC_LINE_REGEX = /^METRIC\s+(\w+)\s*=\s*(-?\d+(?:\.\d+)?)$/;

function parseMetrics(output: string): Metrics {
  const metrics: Metrics = {};
  const lines = output.split("\n");

  for (const line of lines) {
    const match = line.trim().match(METRIC_LINE_REGEX);
    if (match) {
      const [, name, valueStr] = match;
      const value = parseFloat(valueStr!);
      if (!isNaN(value)) {
        metrics[name!] = value;
      }
    }
  }

  return metrics;
}

// --- checks ---
interface CheckResult {
  pass: boolean;
  duration_seconds: number;
  output: string;
  error?: string;
  timedOut?: boolean;
}

const CHECKS_SCRIPT = "autoresearch.checks.sh";

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runProcessWithTimeout(
  $: Shell,
  directory: string,
  command: string[],
  timeoutSeconds: number,
): Promise<ProcessResult> {
  const cmd = command.join(" ");
  const timeoutMs = Math.max(1000, timeoutSeconds * 1000);
  
  const shellPromise = $`bash -c ${cmd}`
    .cwd(directory)
    .quiet()
    .nothrow();
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs);
  });
  
  try {
    const result = await Promise.race([shellPromise, timeoutPromise]);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout?.toString() || "",
      stderr: result.stderr?.toString() || "",
      timedOut: false,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "TIMEOUT") {
      return {
        exitCode: -1,
        stdout: "",
        stderr: "",
        timedOut: true,
      };
    }
    throw error;
  }
}

async function runChecks(
  $: Shell,
  directory: string,
  timeoutSeconds: number = 300,
  checksCommand?: string,
): Promise<CheckResult> {
  const scriptPath = `${directory}/${CHECKS_SCRIPT}`;

  if (!checksCommand && !existsSync(scriptPath)) {
    return {
      pass: true,
      duration_seconds: 0,
      output: "No checks script found",
    };
  }

  const startTime = Date.now();

  try {
    const result = checksCommand
      ? await runProcessWithTimeout(
          $,
          directory,
          ["bash", "-c", checksCommand],
          timeoutSeconds,
        )
      : await runProcessWithTimeout(
          $,
          directory,
          ["bash", scriptPath],
          timeoutSeconds,
        );
    const duration_seconds = (Date.now() - startTime) / 1000;

    if (result.timedOut) {
      return {
        pass: false,
        duration_seconds,
        output: result.stdout,
        error: "Checks timed out",
        timedOut: true,
      };
    }

    if (result.exitCode !== 0) {
      return {
        pass: false,
        duration_seconds,
        output: result.stdout,
        error: result.stderr || "Checks failed",
      };
    }

    return {
      pass: true,
      duration_seconds,
      output: result.stdout,
    };
  } catch (error) {
    const duration_seconds = (Date.now() - startTime) / 1000;

    return {
      pass: false,
      duration_seconds,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// --- markdown ---
const MARKDOWN_FILE = "autoresearch.md";

async function loadMarkdown(directory: string): Promise<string> {
  const filePath = `${directory}/${MARKDOWN_FILE}`;
  if (!existsSync(filePath)) {
    return "";
  }
  return readFile(filePath, "utf-8");
}

async function saveMarkdown(
  directory: string,
  content: string,
): Promise<void> {
  const filePath = `${directory}/${MARKDOWN_FILE}`;
  await writeFile(filePath, content, "utf-8");
}

function generateMarkdownTemplate(config: ConfigEvent): string {
  const timestamp = new Date().toISOString();

  return `# Autoresearch: ${config.name}

**Started:** ${timestamp}  
**Segment:** ${config.segment}  
**Branch:** ${config.branch || "Not specified"}

## Objective

Optimize ${config.metric_name} (${config.direction} is better).

## Primary Metric

- **Name:** ${config.metric_name}
- **Unit:** ${config.metric_unit || "Not specified"}
- **Direction:** ${config.direction}

## Command

\`\`\`bash
${config.command || "Not specified"}
\`\`\`

## Checks Command

${config.checks_command || "Not specified"}

## Files in Scope

${config.files_in_scope?.map((f: string) => `- ${f}`).join("\n") || "Not specified"}

## Baseline

*Will be populated after first successful run*

## Best Run

*Will be populated after first kept experiment*

## Experiments

| Run | Status | Metric | Description |
|-----|--------|--------|-------------|

## Tried Ideas

- [ ] Initial baseline

## Dead Ends

*None yet*

## Next Ideas

- [ ] Establish baseline
`;
}

function updateMarkdownWithSession(
  existingContent: string,
  session: ExperimentSession,
  summary: StatusSummary,
): string {
  const config = session.config;
  if (!config) return existingContent;

  let content = existingContent;
  const improvement =
    summary.baseline_metric !== null &&
    summary.best_metric !== null &&
    summary.baseline_metric !== 0
      ? (
          (config.direction === "lower" ? -1 : 1) *
          (((summary.best_metric - summary.baseline_metric) /
            summary.baseline_metric) *
            100)
        ).toFixed(2) + "%"
      : "N/A";

  if (summary.baseline_metric !== null) {
    const baselineSection = `## Baseline

- **Metric:** ${summary.baseline_metric}${config.metric_unit ? ` ${config.metric_unit}` : ""}
- **Status:** Established`;

    if (content.includes("## Baseline")) {
      content = content.replace(
        /## Baseline[\s\S]*?(?=\n## |$)/,
        baselineSection + "\n\n",
      );
    }
  }

  if (summary.best_metric !== null && summary.best_run_id) {
    const bestSection = `## Best Run

- **Run ID:** ${summary.best_run_id}
- **Metric:** ${summary.best_metric}${config.metric_unit ? ` ${config.metric_unit}` : ""}
- **Improvement:** ${improvement}`;

    if (content.includes("## Best Run")) {
      content = content.replace(
        /## Best Run[\s\S]*?(?=\n## |$)/,
        bestSection + "\n\n",
      );
    }
  }

  if (session.experiments.length > 0) {
    const tableRows = session.experiments
      .map(
        (e) =>
          `| ${e.run_id} | ${e.status} | ${e.metric}${config.metric_unit ? ` ${config.metric_unit}` : ""} | ${e.description} |`,
      )
      .join("\n");

    const tableHeader = `| Run | Status | Metric | Description |
|-----|--------|--------|-------------|`;

    const tableSection = `## Experiments

${tableHeader}
${tableRows}`;

    if (content.includes("## Experiments")) {
      content = content.replace(
        /## Experiments[\s\S]*?(?=\n## |$)/,
        tableSection + "\n\n",
      );
    }
  }

  return content;
}

// --- plugin ---
const z = tool.schema;

export const AutoresearchPlugin: Plugin = async ({ $ }) => {
  return {
    tool: {
      init_experiment: tool({
        description:
          "Initialize a new autoresearch experiment session. Creates autoresearch.jsonl and autoresearch.md files.",
        args: {
          name: z.string().describe("Name of the experiment"),
          metric_name: z.string().describe("Primary metric to optimize"),
          metric_unit: z.string().optional().describe("Unit of the metric"),
          direction: z
            .enum(["lower", "higher"])
            .describe("Whether 'lower' or 'higher' metric values are better"),
          command: z
            .string()
            .optional()
            .describe("Command to run for experiments"),
          checks_command: z
            .string()
            .optional()
            .describe("Command to run after experiments for validation checks"),
          branch: z
            .string()
            .optional()
            .describe("Git branch for this experiment"),
          files_in_scope: z
            .array(z.string())
            .optional()
            .describe("Files involved in the experiment"),
        },
        execute: async (args, context: ToolContext) => {
          const { directory: ctxDir } = context;

          const events = await loadEvents(ctxDir);
          const segment = getCurrentSegment(events) + 1;

          const config: ConfigEvent = {
            type: "config",
            timestamp: new Date().toISOString(),
            name: args.name,
            metric_name: args.metric_name,
            metric_unit: args.metric_unit,
            direction: args.direction,
            command: args.command,
            checks_command: args.checks_command,
            branch: args.branch,
            files_in_scope: args.files_in_scope,
            segment,
          };

          await appendEvent(ctxDir, config);

          const markdownContent = generateMarkdownTemplate(config);
          await saveMarkdown(ctxDir, markdownContent);

          return JSON.stringify({
            success: true,
            segment,
            config: {
              name: args.name,
              metric_name: args.metric_name,
              direction: args.direction,
              command: args.command,
              checks_command: args.checks_command,
              branch: args.branch,
            },
            files_created: ["autoresearch.jsonl", "autoresearch.md"],
          });
        },
      }),

      run_experiment: tool({
        description:
          "Execute an experiment command, capture metrics from METRIC name=value output lines, and optionally run checks.",
        args: {
          command: z
            .string()
            .optional()
            .describe("Command to run (overrides stored command)"),
          timeout_seconds: z
            .number()
            .int()
            .default(DEFAULT_COMMAND_TIMEOUT_SECONDS)
            .describe(
              "Timeout for the command in seconds. Non-positive values use the default.",
            ),
          checks_timeout_seconds: z
            .number()
            .int()
            .default(DEFAULT_CHECKS_TIMEOUT_SECONDS)
            .describe(
              "Timeout for checks in seconds. Non-positive values use the default.",
            ),
        },
        execute: async (args, context: ToolContext) => {
          const { directory: ctxDir } = context;

          const events = await loadEvents(ctxDir);
          const config = getCurrentConfig(events);

          if (!config) {
            throw new Error(
              "No active experiment found. Run init_experiment first.",
            );
          }

          const command = args.command ?? config.command;
          if (!command) {
            throw new Error(
              "No command specified and no stored command in config",
            );
          }

          const runId = randomUUID();
          const segment = config.segment;
          const timeoutSeconds = normalizeTimeoutSeconds(
            args.timeout_seconds,
            DEFAULT_COMMAND_TIMEOUT_SECONDS,
          );
          const checksTimeoutSeconds = normalizeTimeoutSeconds(
            args.checks_timeout_seconds,
            DEFAULT_CHECKS_TIMEOUT_SECONDS,
          );

          const startTime = Date.now();
          let status: RunStatus = "ok";
          let exitCode: number | undefined;
          let commandOutput = "";
          let timedOut = false;

          try {
            const result = await runProcessWithTimeout(
              $,
              ctxDir,
              ["bash", "-c", command],
              timeoutSeconds,
            );

            exitCode = result.exitCode;
            commandOutput = result.stdout + result.stderr;
            timedOut = result.timedOut;

            if (timedOut) {
              status = "timeout";
            } else if (exitCode !== 0) {
              status = "crash";
            }
          } catch (error) {
            status = "crash";
            commandOutput =
              error instanceof Error ? error.message : String(error);
          }

          const duration_seconds = (Date.now() - startTime) / 1000;

          const metrics = parseMetrics(commandOutput);
          const primaryMetric = metrics[config.metric_name] ?? null;

          let checksPass: boolean | undefined;
          let checks_duration_seconds: number | undefined;

          if (status === "ok") {
            const checkResult = await runChecks(
              $,
              ctxDir,
              checksTimeoutSeconds,
              config.checks_command,
            );
            checksPass = checkResult.pass;
            checks_duration_seconds = checkResult.duration_seconds;

            if (!checkResult.pass) {
              status = "checks_failed";
            }
          }

          const runEvent: RunEvent = {
            type: "run",
            timestamp: new Date().toISOString(),
            run_id: runId,
            segment,
            command,
            status,
            duration_seconds,
            timed_out: timedOut ? true : undefined,
            exit_code: exitCode,
            metrics,
            checks_pass: checksPass,
            checks_duration_seconds,
            log_tail: commandOutput.slice(-2000),
          };

          await appendEvent(ctxDir, runEvent);

          return JSON.stringify({
            run_id: runId,
            status,
            primary_metric: primaryMetric,
            metrics,
            duration_seconds,
            checks_pass: checksPass,
            checks_duration_seconds,
            log_tail: runEvent.log_tail,
          });
        },
      }),

      log_experiment: tool({
        description:
          "Log an experiment result with decision (keep/discard/crash/checks_failed). Updates autoresearch.jsonl and autoresearch.md.",
        args: {
          run_id: z.string().describe("ID of the run to log"),
          commit: z.string().describe("Commit hash before the experiment"),
          metric: z.number().describe("Primary metric value"),
          status: z
            .enum(["keep", "discard", "crash", "checks_failed"])
            .describe("Status of the experiment"),
          description: z.string().describe("Description of what changed"),
          metrics: z
            .record(z.string(), z.number())
            .optional()
            .describe("Secondary metrics"),
        },
        execute: async (args, context: ToolContext) => {
          const { directory: ctxDir } = context;

          const events = await loadEvents(ctxDir);
          const config = getCurrentConfig(events);

          if (!config) {
            throw new Error(
              "No active experiment found. Run init_experiment first.",
            );
          }

          const run = findRun(events, args.run_id);
          if (!run) {
            throw new Error(
              `Run '${args.run_id}' not found in current segment`,
            );
          }

          if (run.segment !== config.segment) {
            throw new Error(
              `Run '${args.run_id}' belongs to segment ${run.segment}, current segment is ${config.segment}`,
            );
          }

          const experimentEvent: ExperimentEvent = {
            type: "experiment",
            timestamp: new Date().toISOString(),
            run_id: args.run_id,
            segment: config.segment,
            commit_before: args.commit,
            metric: args.metric,
            metrics: args.metrics,
            status: args.status,
            description: args.description,
          };

          await appendEvent(ctxDir, experimentEvent);

          const updatedEvents: Event[] = [...events, experimentEvent];
          const markdownContent = await loadMarkdown(ctxDir);
          const summary = computeStatusSummary(updatedEvents, null, false);
          const session = getSession(updatedEvents, config.segment);
          const updatedMarkdown = updateMarkdownWithSession(
            markdownContent,
            session,
            summary,
          );
          await saveMarkdown(ctxDir, updatedMarkdown);

          return JSON.stringify({
            success: true,
            run_id: args.run_id,
            status: args.status,
            metric: args.metric,
            segment: config.segment,
          });
        },
      }),

      keep_experiment: tool({
        description:
          "Commit the current experiment changes to git. Stages all changes and creates a commit.",
        args: {
          commit_message: z
            .string()
            .describe("Commit message for the kept experiment"),
        },
        execute: async (args, context: ToolContext) => {
          const { directory: ctxDir } = context;

          const gitStatus = await getGitStatus($, ctxDir);
          if (!gitStatus.isRepo) {
            throw new Error("Not in a git repository. Initialize git first.");
          }

          if (!gitStatus.isDirty) {
            throw new Error("No changes to commit. Make some changes first.");
          }

          await stageAll($, ctxDir);

          const commitHash = await commit($, ctxDir, args.commit_message);

          return JSON.stringify({
            success: true,
            commit_hash: commitHash,
            branch: gitStatus.branch,
            message: args.commit_message,
          });
        },
      }),

      discard_experiment: tool({
        description:
          "Discard uncommitted changes to restore the pre-experiment state. Requires explicit confirmation.",
        args: {
          confirmation: z.string().describe("Type 'DISCARD' to confirm"),
        },
        execute: async (args, context: ToolContext) => {
          const { directory: ctxDir } = context;

          if (args.confirmation !== "DISCARD") {
            throw new Error(
              "Confirmation required: type 'DISCARD' to confirm discarding changes",
            );
          }

          const gitStatus = await getGitStatus($, ctxDir);
          if (!gitStatus.isRepo) {
            throw new Error("Not in a git repository.");
          }

          if (!gitStatus.isDirty) {
            return JSON.stringify({
              success: true,
              message: "No changes to discard",
              discarded_files: [],
            });
          }

          await discardChanges($, ctxDir);

          return JSON.stringify({
            success: true,
            message: "Changes discarded successfully",
            discarded_files: gitStatus.untrackedFiles,
            restored_changes: gitStatus.hasStaged || gitStatus.hasUnstaged,
          });
        },
      }),

      autoresearch_status: tool({
        description:
          "Get the current status of the autoresearch session including metrics, experiment counts, and git state.",
        args: {},
        execute: async (_args, context: ToolContext) => {
          const { directory: ctxDir } = context;

          const events = await loadEvents(ctxDir);

          const gitStatus = await getGitStatus($, ctxDir);

          const summary = computeStatusSummary(
            events,
            gitStatus.branch,
            gitStatus.isDirty,
          );

          const config = getCurrentConfig(events);

          return JSON.stringify({
            segment: summary.segment,
            experiment_name: config?.name ?? null,
            metric_name: summary.metric_name,
            direction: summary.direction,
            total_runs: summary.total_runs,
            keep_count: summary.keep_count,
            discard_count: summary.discard_count,
            crash_count: summary.crash_count,
            checks_failed_count: summary.checks_failed_count,
            baseline_metric: summary.baseline_metric,
            best_metric: summary.best_metric,
            best_run_id: summary.best_run_id,
            current_branch: summary.current_branch,
            git_dirty: summary.git_dirty,
            files: {
              jsonl: "autoresearch.jsonl",
              markdown: "autoresearch.md",
            },
          });
        },
      }),
    },
  };
};

export default AutoresearchPlugin;
