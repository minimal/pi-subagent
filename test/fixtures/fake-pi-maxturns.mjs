/**
 * Fake `pi` for the max-turns kill regression test.
 *
 * Emits TURNS assistant messages, then stays alive indefinitely. The runner
 * must stop processing at the configured limit and kill the child; if it
 * doesn't, the integration test never resolves.
 */
const TURNS = 5;

for (let i = 1; i <= TURNS; i++) {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: `Fake turn ${i} of ${TURNS}` }],
		model: "fake-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: i,
	};
	process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
}

// Stay alive: the runner is expected to terminate us at the turn limit.
setInterval(() => {}, 60_000);
