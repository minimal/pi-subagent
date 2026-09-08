/**
 * Fake `pi` for the session-persistence race test (bead pi-subagent-o2q).
 *
 * Emits a clean final report + agent_end, then stays alive past the runner's
 * semantic-completion grace (250 ms). When SIGTERM arrives it appends one more
 * line to its --session file BEFORE exiting — simulating pi's async shutdown
 * writer. The runner must wait for the child to exit before copying the
 * session file and deleting the temp dir, or the late line is lost.
 */
import * as fs from "node:fs";

const args = process.argv.slice(2);
const sessionIdx = args.indexOf("--session");
const sessionPath = sessionIdx !== -1 ? args[sessionIdx + 1] : undefined;

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "Done from fake pi (late write fixture)." }],
	model: "fake-model",
	stopReason: "stop",
	usage,
	timestamp: 1,
};

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: "message_end", message: assistantMessage });
emit({ type: "agent_end", messages: [assistantMessage] });

let wrote = false;
const writeLateLineAndExit = (code) => {
	if (wrote) return;
	wrote = true;
	if (sessionPath) {
		const marker = {
			role: "assistant",
			content: [{ type: "text", text: "[fake-pi] late shutdown write" }],
			timestamp: Date.now(),
		};
		fs.appendFileSync(sessionPath, `${JSON.stringify(marker)}\n`);
	}
	process.exit(code);
};

process.on("SIGTERM", () => {
	// Simulate pi's async shutdown: disposeRuntime() runs before the final
	// session write and exit. The 150 ms delay keeps the write strictly after
	// the runner's old persist-at-resolve moment, making the race deterministic.
	setTimeout(() => writeLateLineAndExit(143), 150);
});
// Safety net in case SIGTERM never arrives (e.g. a forced kill on Windows).
setTimeout(() => writeLateLineAndExit(0), 3_000);
