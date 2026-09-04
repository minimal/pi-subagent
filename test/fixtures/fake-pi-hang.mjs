/**
 * Fake `pi` for the timeout hard-stop test.
 *
 * Emits one turn, then hangs: the runner must kill it after
 * deadline + grace period.
 */
const message = {
	role: "assistant",
	content: [{ type: "text", text: "Stuck turn" }],
	timestamp: 1,
};

process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);

// Stay alive: the runner is expected to SIGTERM (then SIGKILL) us.
setInterval(() => {}, 60_000);
