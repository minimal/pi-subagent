/**
 * Fake `pi` for the timeout-grace test.
 *
 * Emits one early turn, then stays silent (simulating the child generating
 * its final report past the deadline). After FAKE_PI_DELAY_MS it emits a
 * final assistant message and exits 0. The test runs with a timeout shorter
 * than the delay: the runner must let the child finish inside the grace
 * period instead of killing it.
 */
const DELAY_MS = Number(process.env.FAKE_PI_DELAY_MS ?? 1_500);

function makeMessage(text, timestamp) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		timestamp,
	};
}

process.stdout.write(
	`${JSON.stringify({ type: "message_end", message: makeMessage("Working...", 1) })}\n`,
);

setTimeout(() => {
	const final = makeMessage("Final report delivered after the deadline.", Date.now());
	process.stdout.write(`${JSON.stringify({ type: "message_end", message: final })}\n`);
	process.stdout.write(
		`${JSON.stringify({ type: "agent_end", messages: [final] })}\n`,
	);
	process.exit(0);
}, DELAY_MS);
