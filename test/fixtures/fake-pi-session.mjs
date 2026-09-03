/**
 * Fake `pi` for session persistence tests.
 *
 * Finds the --session path in argv, appends one assistant turn (the "child
 * turn" marker, simulating the child writing to its session file), then
 * emits message_end + agent_end JSON events and exits 0.
 */
import * as fs from "node:fs";

const args = process.argv.slice(2);
const sessionIdx = args.indexOf("--session");
const sessionPath = sessionIdx !== -1 ? args[sessionIdx + 1] : undefined;

if (sessionPath) {
	const marker = {
		role: "assistant",
		content: [{ type: "text", text: "[fake-pi] child turn marker" }],
		timestamp: Date.now(),
	};
	fs.appendFileSync(sessionPath, `${JSON.stringify(marker)}\n`);
}

const assistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "Done from fake pi (session fixture)." }],
	model: "fake-model",
	stopReason: "stop",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: Date.now(),
};

process.stdout.write(`${JSON.stringify({ type: "message_end", message: assistantMessage })}\n`);
process.stdout.write(`${JSON.stringify({ type: "agent_end", messages: [assistantMessage] })}\n`);
