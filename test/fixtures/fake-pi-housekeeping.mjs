/**
 * Fake `pi` emitting a realistic JSON-mode event stream (bead pi-subagent-hx8).
 *
 * Per turn: turn_start -> message_end -> turn_end (same message object, so the
 * runner's signature dedupe is exercised). The last turn is a clean final
 * report. After agent_end, pi runs post-run housekeeping: compaction_start /
 * compaction_end. Then the child exits 0 on its own.
 *
 * Regression pin for bead pi-subagent-rdf: at the turn limit, the housekeeping
 * events must not flip the completed run into a max_turns failure (which also
 * killed the child mid-compaction before it could exit cleanly).
 */
const TURNS = 2;

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

emit({ type: "session", id: "fake-child-session", version: 1 });

const messages = [];
for (let i = 1; i <= TURNS; i++) {
	const isFinal = i === TURNS;
	emit({ type: "turn_start" });
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
		usage,
		timestamp: i,
	};
	messages.push(message);
	emit({ type: "message_end", message });
	emit({ type: "turn_end", message, toolResults: [] });
}

emit({ type: "agent_end", messages });

// Post-run housekeeping: auto-compaction runs after the agent loop ends.
emit({ type: "compaction_start" });
emit({ type: "compaction_end" });
