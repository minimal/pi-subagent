import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	runAgent,
	getSubagentSessionDir,
	persistSubagentSession,
	pruneSubagentSessions,
} from "../runner.ts";
import { isResultError, isResultSuccess } from "../types.ts";
import { getFinalAssistantText, getResultSummaryText } from "../runner-events.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(testDir, "fixtures");

/** Run fn with an env var set, restoring the previous value afterwards. */
async function withEnv(name, value, fn) {
	const saved = process.env[name];
	process.env[name] = value;
	try {
		return await fn();
	} finally {
		if (saved === undefined) delete process.env[name];
		else process.env[name] = saved;
	}
}

/** Minimal parent session snapshot: header line + one user turn. */
function makeForkSnapshot() {
	const header = { type: "session", id: "parent-session", version: 1 };
	const userTurn = {
		role: "user",
		content: [{ type: "text", text: "parent turn" }],
		timestamp: 1,
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(userTurn)}\n`;
}

function runAgentWithFixture(fixtureName, opts = {}) {
	return runAgent({
		cwd: testDir,
		agentName: opts.agentName ?? "fixture",
		task: "integration test task",
		forkSessionSnapshotJsonl: makeForkSnapshot(),
		timeout: opts.timeout ?? 30_000,
		maxTurns: opts.maxTurns ?? 50,
		makeDetails: (results) => ({ results }),
		testSpawn: {
			command: process.execPath,
			prefixArgs: [path.join(fixturesDir, fixtureName)],
		},
	});
}

/** List fork temp dirs in the system temp dir (pi-subagent-*). */
function listForkTempDirs() {
	return fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("pi-subagent-"));
}

test("runAgent persists the sub-agent session file (fork + child turns)", async () => {
	const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
	const tmpDirsBefore = new Set(listForkTempDirs());

	try {
		await withEnv("PI_CODING_AGENT_DIR", tmpAgentDir, async () => {
			const result = await runAgentWithFixture("fake-pi-session.mjs", {
				agentName: "session-tester",
			});

			assert.equal(result.exitCode, 0);
			assert.equal(isResultSuccess(result), true);
			assert.equal(isResultError(result), false);

			// Session file persisted with fork lines + the child's own turn.
			assert.ok(result.sessionFile, "sessionFile should be set");
			const lines = fs
				.readFileSync(result.sessionFile, "utf8")
				.split("\n")
				.filter((l) => l.trim());
			assert.equal(lines.length, 3);
			assert.ok(lines[0].includes("parent-session"), "first line is the fork header");
			assert.ok(lines[1].includes("parent turn"), "second line is the parent turn");
			assert.ok(
				lines[2].includes("[fake-pi] child turn marker"),
				"third line is the child turn marker",
			);

			// Fork temp dir cleaned up after the run.
			const tmpDirsAfter = listForkTempDirs();
			assert.ok(
				tmpDirsAfter.every((d) => tmpDirsBefore.has(d)),
				"fork temp dir should be cleaned up",
			);
		});
	} finally {
		fs.rmSync(tmpAgentDir, { recursive: true, force: true });
	}
});

test("runAgent terminates the child when the turn limit is hit", async () => {
	const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));

	try {
		await withEnv("PI_CODING_AGENT_DIR", tmpAgentDir, async () => {
			const started = Date.now();
			const result = await runAgentWithFixture("fake-pi-maxturns.mjs", {
				agentName: "maxturns-tester",
				maxTurns: 2,
			});
			const elapsedMs = Date.now() - started;

			assert.equal(result.maxTurnsExceeded, true);
			assert.equal(result.stopReason, "max_turns");
			assert.equal(result.exitCode, 1);
			assert.equal(result.usage.turns, 2);
			assert.equal(isResultSuccess(result), false);
			assert.equal(isResultError(result), true);
			// Resolving at all proves the child was killed (the fixture would
			// otherwise sleep forever); allow slack for the SIGKILL fallback.
			assert.ok(
				elapsedMs < 10_000,
				`child should be killed promptly (took ${elapsedMs}ms)`,
			);
		});
	} finally {
		fs.rmSync(tmpAgentDir, { recursive: true, force: true });
	}
});

test("runAgent succeeds when the child reports on its final allowed turn", async () => {
	const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));

	try {
		await withEnv("PI_CODING_AGENT_DIR", tmpAgentDir, async () => {
			const result = await runAgentWithFixture("fake-pi-maxturns-final.mjs", {
				agentName: "final-turn-tester",
				maxTurns: 2,
			});

			// Completing exactly on the turn limit is a success, not a failure.
			assert.equal(result.maxTurnsExceeded, undefined);
			assert.equal(result.stopReason, "stop");
			assert.equal(result.exitCode, 0);
			assert.equal(isResultSuccess(result), true);
			assert.equal(isResultError(result), false);
			assert.equal(result.usage.turns, 2);
			assert.equal(
				getFinalAssistantText(result.messages),
				"Done in the allotted turns.",
			);
		});
	} finally {
		fs.rmSync(tmpAgentDir, { recursive: true, force: true });
	}
});

test("persistSubagentSession copies the run session into the sub-agent session dir", async () => {
	const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));

	try {
		await withEnv("PI_CODING_AGENT_DIR", tmpAgentDir, () => {
			const src = path.join(tmpAgentDir, "source-session.jsonl");
			fs.writeFileSync(src, "line1\nline2\n");

			const dest = persistSubagentSession(src, "tester");

			assert.ok(dest, "persist should return the destination path");
			assert.ok(dest.startsWith(getSubagentSessionDir()));
			assert.ok(dest.endsWith("-tester.jsonl"));
			assert.equal(fs.readFileSync(dest, "utf8"), "line1\nline2\n");
			assert.equal(fs.readdirSync(getSubagentSessionDir()).length, 1);
		});
	} finally {
		fs.rmSync(tmpAgentDir, { recursive: true, force: true });
	}
});

test("persistSubagentSession prunes old sessions per PI_SUBAGENT_SESSION_KEEP", async () => {
	const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));

	try {
		await withEnv("PI_CODING_AGENT_DIR", tmpAgentDir, () =>
			withEnv("PI_SUBAGENT_SESSION_KEEP", "2", () => {
				const subagentsDir = getSubagentSessionDir();
				fs.mkdirSync(subagentsDir, { recursive: true });
				for (let i = 1; i <= 3; i++) {
					fs.writeFileSync(
						path.join(subagentsDir, `2020-01-01T00-00-0${i}-old.jsonl`),
						`old ${i}\n`,
					);
				}

				const src = path.join(tmpAgentDir, "source-session.jsonl");
				fs.writeFileSync(src, "fork-line\nchild-line\n");
				const dest = persistSubagentSession(src, "tester");

				assert.ok(dest && fs.existsSync(dest), "persist should succeed");
				const remaining = fs.readdirSync(subagentsDir).sort();
				assert.equal(remaining.length, 2, "only the newest 2 sessions should remain");
				assert.ok(remaining.includes(path.basename(dest)), "the new session is kept");
			}),
		);
	} finally {
		fs.rmSync(tmpAgentDir, { recursive: true, force: true });
	}
});

test("pruneSubagentSessions keeps only the newest sessions", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-prune-"));
	try {
		for (let i = 1; i <= 5; i++) {
			fs.writeFileSync(
				path.join(dir, `2020-01-01T00-00-0${i}-tester.jsonl`),
				`{"n":${i}}\n`,
			);
		}

		pruneSubagentSessions(dir, 2);

		const remaining = fs.readdirSync(dir).sort();
		assert.deepEqual(remaining, [
			"2020-01-01T00-00-04-tester.jsonl",
			"2020-01-01T00-00-05-tester.jsonl",
		]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runAgent lets a child finish its final report inside the timeout grace", async () => {
	const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));

	try {
		await withEnv("PI_CODING_AGENT_DIR", tmpAgentDir, () =>
			withEnv("PI_SUBAGENT_TIMEOUT_GRACE_MS", "5000", () =>
				withEnv("FAKE_PI_DELAY_MS", "1500", async () => {
					const result = await runAgentWithFixture("fake-pi-grace.mjs", {
						agentName: "grace-tester",
						timeout: 800,
					});

					assert.equal(result.timeout, undefined);
					assert.equal(result.exitCode, 0);
					assert.equal(isResultSuccess(result), true);
					assert.equal(
						getFinalAssistantText(result.messages),
						"Final report delivered after the deadline.",
					);
				}),
			),
		);
	} finally {
		fs.rmSync(tmpAgentDir, { recursive: true, force: true });
	}
});

test("runAgent hard-stops a child still running after the timeout grace", async () => {
	const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));

	try {
		await withEnv("PI_CODING_AGENT_DIR", tmpAgentDir, () =>
			withEnv("PI_SUBAGENT_TIMEOUT_GRACE_MS", "1000", async () => {
				const started = Date.now();
				const result = await runAgentWithFixture("fake-pi-hang.mjs", {
					agentName: "hang-tester",
					timeout: 500,
				});
				const elapsedMs = Date.now() - started;

				assert.equal(result.timeout, true);
				assert.equal(result.exitCode, 124);
				assert.equal(result.stopReason, "timeout");
				assert.equal(isResultSuccess(result), false);
				assert.equal(isResultError(result), true);
				assert.ok(
					elapsedMs < 10_000,
					`child should be killed after deadline + grace (took ${elapsedMs}ms)`,
				);
			}),
		);
	} finally {
		fs.rmSync(tmpAgentDir, { recursive: true, force: true });
	}
});

test("runAgent passes the budget env and task preamble to the child", async () => {
	const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));

	try {
		await withEnv("PI_CODING_AGENT_DIR", tmpAgentDir, async () => {
			const result = await runAgentWithFixture("fake-pi-env.mjs", {
				agentName: "env-tester",
			});

			assert.equal(isResultSuccess(result), true);
			const payload = JSON.parse(getFinalAssistantText(result.messages));
			assert.equal(payload.child, "1");
			assert.equal(payload.timeoutMs, "30000");
			assert.equal(payload.maxTurns, "50");
			assert.equal(payload.haveStartedAt, true);
			assert.ok(payload.task.startsWith("[sub-agent-task]"));
			assert.ok(payload.task.includes("Budget:"));
			assert.ok(payload.task.includes("subagent_budget"));
		});
	} finally {
		fs.rmSync(tmpAgentDir, { recursive: true, force: true });
	}
});

test("runAgent treats an exit-0 child with no final text as an error", async () => {
	const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));

	try {
		await withEnv("PI_CODING_AGENT_DIR", tmpAgentDir, async () => {
			const result = await runAgentWithFixture("fake-pi-nooutput.mjs", {
				agentName: "nooutput-tester",
			});

			assert.equal(result.stopReason, "no_output");
			assert.equal(isResultSuccess(result), false);
			assert.equal(isResultError(result), true);
			assert.ok(
				getResultSummaryText(result).includes("final text report"),
				"summary should explain the missing report",
			);
		});
	} finally {
		fs.rmSync(tmpAgentDir, { recursive: true, force: true });
	}
});
