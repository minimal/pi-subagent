/**
 * Fake `pi` for the no-output regression test.
 *
 * Emits a thinking-only assistant message (no text) plus agent_end and exits
 * 0: the runner must NOT report success for this.
 */
const message = {
	role: "assistant",
	content: [{ type: "thinking", thinking: "I should have written a report." }],
	model: "fake-model",
	stopReason: "stop",
	timestamp: 1,
};

process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
process.stdout.write(`${JSON.stringify({ type: "agent_end", messages: [message] })}\n`);
