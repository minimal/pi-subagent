/**
 * Fake `pi` for the child-env wiring test.
 *
 * Reports the budget env vars and the task message it was started with, as
 * its final assistant text.
 */
// The runner always appends the task message as the last (positional) arg.
const args = process.argv.slice(2);
const task = args[args.length - 1] ?? "";

const payload = JSON.stringify({
	child: process.env.PI_SUBAGENT_CHILD,
	timeoutMs: process.env.PI_SUBAGENT_TIMEOUT_MS,
	maxTurns: process.env.PI_SUBAGENT_MAX_TURNS,
	haveStartedAt: process.env.PI_SUBAGENT_STARTED_AT_MS !== undefined,
	task,
});

const final = {
	role: "assistant",
	content: [{ type: "text", text: payload }],
	model: "fake-model",
	stopReason: "stop",
	timestamp: Date.now(),
};

process.stdout.write(`${JSON.stringify({ type: "message_end", message: final })}\n`);
process.stdout.write(`${JSON.stringify({ type: "agent_end", messages: [final] })}\n`);
