/**
 * Fake `pi` for the stale-text regression test (bead pi-subagent-c73).
 *
 * Emits an early text message, then a thinking-only final message with
 * stopReason "stop", then agent_end, and exits 0. The runner must classify
 * this as no_output: the final-message text check must not fall through to
 * the earlier text and call the run a stale-text success.
 */
const early = {
	role: "assistant",
	content: [{ type: "text", text: "Progress: half done." }],
	model: "fake-model",
	stopReason: "toolUse",
	timestamp: 1,
};
const final = {
	role: "assistant",
	content: [{ type: "thinking", thinking: "I should have written a report." }],
	model: "fake-model",
	stopReason: "stop",
	timestamp: 2,
};

process.stdout.write(`${JSON.stringify({ type: "message_end", message: early })}\n`);
process.stdout.write(`${JSON.stringify({ type: "message_end", message: final })}\n`);
process.stdout.write(
	`${JSON.stringify({ type: "agent_end", messages: [early, final] })}\n`,
);
