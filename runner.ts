/**
 * Subagent process runner.
 *
 * Spawns isolated `pi` subprocesses with full context inheritance.
 * Sub-agents inherit the exact same system prompt as the main agent
 * (no --append-system-prompt). Task is delivered as a user message.
 *
 * Simplified model:
 * - No named agents or config files
 * - Sub-agents inherit parent's model/tools/thinking
 * - Sub-agents cannot spawn further sub-agents (enforced in runner-events.js)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { parseInheritedCliArgs } from "./runner-cli.js";
import { processPiJsonLine } from "./runner-events.js";
import {
  type SingleResult,
  emptyUsage,
  getFinalOutput,
  normalizeCompletedResult,
} from "./types.js";
import { buildChildEnv, buildTaskMessage, DEFAULT_TIMEOUT_MS } from "./budget.js";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 5000;
const AGENT_END_GRACE_MS = 250;
/** Post-deadline grace: let the child finish its final report before killing. */
const TIMEOUT_GRACE_MS = 180_000;
/** Extra time allowed after SIGKILL for stdout to drain before force-resolving. */
const KILL_DRAIN_MS = 3_000;
const PI_OFFLINE_ENV = "PI_OFFLINE";

/** Post-deadline grace period in ms (PI_SUBAGENT_TIMEOUT_GRACE_MS overrides for tests). */
function resolveTimeoutGraceMs(): number {
  const v = Number(process.env.PI_SUBAGENT_TIMEOUT_GRACE_MS);
  return Number.isFinite(v) && v >= 0 ? v : TIMEOUT_GRACE_MS;
}

type OnUpdateCallback = (partial: AgentToolResult) => void;

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
  if (isNode && process.argv[1]) {
    return { command: process.execPath, prefixArgs: [process.argv[1]] };
  }
  return { command: process.execPath, prefixArgs: [] };
}

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

function writeForkSessionToTempFile(
  sessionJsonl: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const filePath = path.join(tmpDir, `session.jsonl`);
  fs.writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function cleanupTempDir(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Persistent sub-agent session files
// ---------------------------------------------------------------------------

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const SESSION_KEEP_ENV = "PI_SUBAGENT_SESSION_KEEP";
const DEFAULT_SESSION_KEEP = 20;

function expandTilde(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

/** Directory where per-run sub-agent session files are kept. */
export function getSubagentSessionDir(): string {
  const configured = process.env[AGENT_DIR_ENV]?.trim();
  const agentDir = configured
    ? expandTilde(configured)
    : path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "sessions", "subagents");
}

function sanitizeAgentName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40);
  return cleaned || "subagent";
}

/**
 * Copy a run's session file (forked parent history + sub-agent turns) into the
 * persistent sub-agent session directory. Returns the destination path, or
 * null when persistence fails (never breaks the run itself).
 */
export function persistSubagentSession(tmpSessionPath: string, agentName: string): string | null {
  try {
    const dir = getSubagentSessionDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");
    const dest = path.join(dir, `${stamp}-${sanitizeAgentName(agentName)}.jsonl`);
    fs.copyFileSync(tmpSessionPath, dest);
    pruneSubagentSessions(dir);
    return dest;
  } catch {
    return null;
  }
}

/** Keep only the newest `keep` session files; filenames sort chronologically. */
export function pruneSubagentSessions(dir: string, keep?: number): void {
  const configured = Number.parseInt(process.env[SESSION_KEEP_ENV] ?? "", 10);
  const limit =
    keep ?? (Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SESSION_KEEP);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  } catch {
    return;
  }
  for (const file of files.slice(limit)) {
    try {
      fs.rmSync(path.join(dir, file), { force: true });
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments
// ---------------------------------------------------------------------------

const inheritedCliArgs = parseInheritedCliArgs(process.argv);

function buildPiArgs(
  task: string,
  forkSessionPath: string | null,
  taskCwd: string | undefined,
  timeoutMs: number,
  maxTurns: number,
): string[] {
  const args: string[] = [
    "--mode",
    "json",
    ...inheritedCliArgs.extensionArgs,
    ...inheritedCliArgs.alwaysProxy,
    "-p",
  ];

  // Fork mode: use the parent's session snapshot (full conversation history)
  if (forkSessionPath) {
    args.push("--session", forkSessionPath);
  }

  // Always inherit the parent's tools by default.
  // Sub-agents must have the same tool set as the parent to preserve KV cache.
  if (inheritedCliArgs.fallbackTools !== undefined) {
    args.push("--tools", inheritedCliArgs.fallbackTools);
  }

  // NO --append-system-prompt! The sub-agent inherits the main agent's
  // system prompt (Pi default + APPEND_SYSTEM.md) automatically.

  // Task message with sub-agent marker and the run's budget
  const taskMessage = buildTaskMessage(task, timeoutMs, maxTurns);
  args.push(taskMessage);
  return args;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  /** Working directory. */
  cwd: string;
  /** Freeform name for the sub-agent. */
  agentName: string;
  /** Task description. */
  task: string;
  /** Optional override working directory. */
  taskCwd?: string;
  /** Serialized parent session snapshot (full conversation in JSONL). */
  forkSessionSnapshotJsonl?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Streaming update callback. */
  onUpdate?: OnUpdateCallback;
  /** Factory to wrap results into SubagentDetails. */
  makeDetails: (results: SingleResult[]) => { results: SingleResult[] };
  /** Maximum execution time in milliseconds. Default: 600000 (600s). */
  timeout?: number;
  /** Maximum number of assistant turns (LLM calls). Default: 50. */
  maxTurns?: number;
  /** Test hook: override the pi spawn command (used by tests with a fake pi). */
  testSpawn?: { command: string; prefixArgs?: string[] };
}

/**
 * Spawn a single subagent process and collect its results.
 *
 * Returns a SingleResult even on failure (exitCode > 0, stderr populated).
 */
export async function runAgent(opts: RunAgentOptions): Promise<SingleResult> {
  const {
    cwd,
    agentName,
    task,
    taskCwd,
    forkSessionSnapshotJsonl,
    signal,
    onUpdate,
    makeDetails,
    timeout = DEFAULT_TIMEOUT_MS,
    maxTurns = 50,
    testSpawn,
  } = opts;

  if (!forkSessionSnapshotJsonl || !forkSessionSnapshotJsonl.trim()) {
    return {
      agent: agentName,
      task,
      exitCode: 1,
      messages: [],
      stderr: "Cannot run sub-agent: missing parent session snapshot context.",
      usage: emptyUsage(),
      stopReason: "error",
      errorMessage: "Cannot run sub-agent: missing parent session snapshot context.",
    };
  }

  const result: SingleResult = {
    agent: agentName,
    task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    maxTurnsLimit: maxTurns,
  };

  const emitUpdate = () => {
    onUpdate?.({
      content: [
        {
          type: "text",
          text: getFinalOutput(result.messages) || "(running...)",
        },
      ],
      details: makeDetails([result]),
    });
  };

  // Write forked session snapshot to temp file
  let forkSessionTmpDir: string | null = null;
  let forkSessionTmpPath: string | null = null;
  if (forkSessionSnapshotJsonl) {
    const tmp = writeForkSessionToTempFile(forkSessionSnapshotJsonl);
    forkSessionTmpDir = tmp.dir;
    forkSessionTmpPath = tmp.filePath;
  }

  try {
    const startedAtMs = Date.now();
    const piArgs = buildPiArgs(
      task,
      forkSessionTmpPath,
      taskCwd,
      timeout,
      maxTurns,
    );
    let wasAborted = false;
    let timedOut = false;

    const exitCode = await new Promise<number>((resolve) => {
      const { command, prefixArgs = [] } = testSpawn ?? resolvePiSpawn();
      const proc = spawn(command, [...prefixArgs, ...piArgs], {
        cwd: taskCwd ?? cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          [PI_OFFLINE_ENV]: "1",
          ...buildChildEnv(timeout, maxTurns, startedAtMs),
        },
      });

      proc.stdin.on("error", () => {
        /* ignore broken pipe on fast exits */
      });
      proc.stdin.end();

      let buffer = "";
      let didClose = false;
      let settled = false;
      let maxTurnsKillStarted = false;
      let abortHandler: (() => void) | undefined;
      let semanticCompletionTimer: NodeJS.Timeout | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;
      let hardStopBackstop: NodeJS.Timeout | undefined;

      const clearTimers = () => {
        if (semanticCompletionTimer) {
          clearTimeout(semanticCompletionTimer);
          semanticCompletionTimer = undefined;
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = undefined;
        }
        if (hardStopBackstop) {
          clearTimeout(hardStopBackstop);
          hardStopBackstop = undefined;
        }
      };

      const terminateChild = () => {
        if (isWindows) {
          if (proc.pid !== undefined) {
            const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
              stdio: "ignore",
            });
            killer.unref();
          }
          return;
        }

        proc.kill("SIGTERM");
        const sigkillTimer = setTimeout(() => {
          if (!didClose) proc.kill("SIGKILL");
        }, SIGKILL_TIMEOUT_MS);
        sigkillTimer.unref();
      };

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
        }
        resolve(code);
      };

      const flushLine = (line: string) => {
        if (processPiJsonLine(line, result)) emitUpdate();
        if (result.maxTurnsExceeded) {
          // Turn limit hit: kill the child so it stops making LLM calls past
          // the limit. normalizeCompletedResult maps maxTurnsExceeded to exit code 1.
          if (!maxTurnsKillStarted) {
            maxTurnsKillStarted = true;
            terminateChild();
          }
          return;
        }
        maybeFinishFromAgentEnd();
      };

      const flushBufferedLines = (text: string) => {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) flushLine(line);
        }
      };

      const maybeFinishFromAgentEnd = () => {
        if (!result.sawAgentEnd || didClose || settled) return;
        clearTimers();
        semanticCompletionTimer = setTimeout(() => {
          if (didClose || settled || !result.sawAgentEnd) return;
          if (buffer.trim()) {
            flushBufferedLines(buffer);
            buffer = "";
          }
          proc.stdout.removeListener("data", onStdoutData);
          proc.stderr.removeListener("data", onStderrData);
          finish(0);
          terminateChild();
        }, AGENT_END_GRACE_MS);
        semanticCompletionTimer.unref();
      };

      const onStdoutData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) flushLine(line);
      };

      const onStderrData = (chunk: Buffer) => {
        result.stderr += chunk.toString();
      };

      proc.stdout.on("data", onStdoutData);
      proc.stderr.on("data", onStderrData);

      // Timeout handling: at the deadline, give the child a grace period to
      // finish its final report and exit cleanly (it was warned to wrap up).
      // Only if it is still running when the grace expires do we kill it.
      const hardStop = () => {
        timedOut = true;
        result.timeout = true;
        result.exitCode = 124;
        result.stopReason = "timeout";
        result.errorMessage = `Sub-agent exceeded its ${timeout / 1000}s time budget`;
        result.stderr = result.errorMessage;
        terminateChild();
        hardStopBackstop = setTimeout(() => {
          if (!settled) finish(124);
        }, SIGKILL_TIMEOUT_MS + KILL_DRAIN_MS);
        hardStopBackstop.unref?.();
      };

      timeoutTimer = setTimeout(() => {
        if (didClose || settled) return;
        graceTimer = setTimeout(hardStop, resolveTimeoutGraceMs());
        graceTimer.unref?.();
      }, timeout);

      proc.on("close", (code) => {
        didClose = true;
        clearTimers();
        if (buffer.trim()) flushBufferedLines(buffer);
        finish(code ?? 0);
      });

      proc.on("error", (err) => {
        if (!result.stderr.trim()) result.stderr = err.message;
        clearTimers();
        finish(1);
      });

      // Abort handling
      if (signal) {
        abortHandler = () => {
          if (didClose || settled) return;
          wasAborted = true;
          clearTimers();
          terminateChild();
        };
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    result.exitCode = exitCode;
    return normalizeCompletedResult(result, wasAborted);
  } finally {
    // Keep a persistent copy of the run's session file (forked parent history
    // + the sub-agent's own turns) before the temp dir is cleaned up.
    if (forkSessionTmpPath) {
      const persisted = persistSubagentSession(forkSessionTmpPath, agentName);
      if (persisted) result.sessionFile = persisted;
    }
    cleanupTempDir(forkSessionTmpDir);
  }
}
