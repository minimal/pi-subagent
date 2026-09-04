/**
 * Wiring tests for the child-mode budget warning in index.ts.
 *
 * Imports the real extension with a fake ExtensionAPI and drives the
 * turn_start/turn_end handlers to verify where the one-shot warning is (and
 * is not) sent. The pi packages are redirected to local stubs, mirroring the
 * aliases pi's extension loader provides in production.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const stubUrl = pathToFileURL(path.join(testDir, "fixtures", "stub-pi-packages.mjs")).href;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (
			specifier === "@sinclair/typebox" ||
			specifier === "@mariozechner/pi-coding-agent" ||
			specifier === "@mariozechner/pi-tui"
		) {
			return { url: stubUrl, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeFakePi() {
	const handlers = {};
	const tools = [];
	const sent = [];
	const pi = {
		on(event, handler) {
			(handlers[event] ??= []).push(handler);
		},
		registerTool(def) {
			tools.push(def);
		},
		sendUserMessage(text, options) {
			sent.push({ text, options });
		},
	};
	return { pi, handlers, tools, sent };
}

/**
 * Run fn as a sub-agent child: 90s budget, 55s already elapsed (below the
 * 60s warn line), fast 100ms watchdog. Env is restored afterwards.
 */
async function withChildEnv(fn) {
	const vars = {
		PI_SUBAGENT_CHILD: "1",
		PI_SUBAGENT_TIMEOUT_MS: "90000",
		PI_SUBAGENT_STARTED_AT_MS: String(Date.now() - 55_000),
		PI_SUBAGENT_WATCHDOG_MS: "100",
	};
	const saved = {};
	for (const [k, v] of Object.entries(vars)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	try {
		const { default: extension } = await import("../index.ts");
		const fake = makeFakePi();
		extension(fake.pi);
		await fn(fake);
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

test("warning is dropped when the in-flight turn is the final report", async () => {
	await withChildEnv(async ({ handlers, tools, sent }) => {
		// Sanity: both tools are registered for the child.
		assert.deepEqual(tools.map((t) => t.name), ["subagent", "subagent_budget"]);

		const [turnStart] = handlers["turn_start"] ?? [];
		const [turnEnd] = handlers["turn_end"] ?? [];
		assert.ok(turnStart && turnEnd, "child mode must register turn handlers");

		// The child starts generating its final report (turn in flight).
		turnStart({ turnIndex: 4 });

		// Watchdog ticks cross the threshold mid-turn: hold, do not send.
		await sleep(400);
		assert.equal(sent.length, 0, "warning must not be sent while the turn is in flight");

		// The in-flight turn ends without tool calls: it is the final report.
		turnEnd({
			turnIndex: 4,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Report." }],
				stopReason: "stop",
			},
			toolResults: [],
		});

		// The warning is dropped: nothing is sent, ever.
		await sleep(400);
		assert.equal(sent.length, 0, "warning must be dropped once the final report is delivered");
	});
});

test("warning is sent at turn end while the child is still calling tools", async () => {
	await withChildEnv(async ({ handlers, sent }) => {
		const [turnStart] = handlers["turn_start"] ?? [];
		const [turnEnd] = handlers["turn_end"] ?? [];

		turnStart({ turnIndex: 0 });
		await sleep(400); // watchdog holds while the turn is in flight
		assert.equal(sent.length, 0);

		turnEnd({
			turnIndex: 0,
			message: { role: "assistant", content: [], stopReason: "toolUse" },
			toolResults: [],
		});

		assert.equal(sent.length, 1, "warning should be sent at the turn boundary");
		assert.equal(sent[0].options.deliverAs, "steer");
		assert.ok(sent[0].text.startsWith("Budget warning:"));

		// One-shot: later ticks never re-send.
		await sleep(400);
		assert.equal(sent.length, 1);
	});
});
