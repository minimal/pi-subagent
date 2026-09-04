/**
 * Fake `pi` for the "child finishes exactly on its final allowed turn" test.
 *
 * Emits TURNS assistant messages — the last one a clean final report
 * (stopReason "stop" with text) — then agent_end and exits 0. With
 * maxTurns == TURNS the runner must report success, not a max-turns failure
 * (bead pi-subagent-l72).
 */
const TURNS = 2;

const messages = [];
for (let i = 1; i <= TURNS; i++) {
	const isFinal = i === TURNS;
	const message = {
		role: "assistant",
		content: [
			{
				type: "text",
				text: isFinal ? "Done in the allotted turns." : `Working (turn ${i} of ${TURNS})`,
			},
		],
		model: "fake-model",
		stopReason: isFinal ? "stop" : "toolUse",
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
	messages.push(message);
	process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
}

process.stdout.write(`${JSON.stringify({ type: "agent_end", messages })}\n`);
