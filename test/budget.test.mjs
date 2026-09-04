import test from "node:test";
import assert from "node:assert/strict";
import {
	budgetStatus,
	buildChildEnv,
	buildTaskMessage,
	budgetWarningOnTick,
	budgetWarningOnTurnEnd,
	budgetWarningText,
	createBudgetWarningState,
	describeSubagentBudget,
	warnRemainingMs,
} from "../budget.ts";

test("warnRemainingMs clamps to [60s, 240s]", () => {
	assert.equal(warnRemainingMs(600_000), 150_000);
	assert.equal(warnRemainingMs(120_000), 60_000); // 25% = 30s, clamped up
	assert.equal(warnRemainingMs(7_200_000), 240_000); // clamped down
});

test("budgetStatus flags the warning window", () => {
	const start = 1_000_000;
	const limit = 600_000;
	assert.equal(budgetStatus(start + 300_000, start, limit).shouldWarn, false);
	assert.equal(budgetStatus(start + 450_001, start, limit).shouldWarn, true);
	const over = budgetStatus(start + 700_000, start, limit);
	assert.ok(over.remainingMs < 0);
});

test("describeSubagentBudget reports time and turns", () => {
	const text = describeSubagentBudget(240_000, 0, 600_000, 50, 3);
	assert.ok(text.includes("6m 0s remaining of 10m 0s total"));
	assert.ok(text.includes("3 of 50 assistant turns used"));
	assert.ok(!text.includes("running low"));

	const low = describeSubagentBudget(500_000, 0, 600_000, 50, 30);
	assert.ok(low.includes("running low"));
});

test("budgetWarningText mentions remaining seconds and the report contract", () => {
	const text = budgetWarningText(500_000, 0, 600_000);
	assert.ok(text.startsWith("Budget warning:"));
	assert.ok(text.includes("100s remain"));
	assert.ok(text.includes("final report"));
});

test("buildTaskMessage states the budget and keeps the task", () => {
	const task = "Review the branch";
	const message = buildTaskMessage(task, 600_000, 50);
	assert.ok(message.startsWith("[sub-agent-task] Complete this task:"));
	assert.ok(message.includes("Budget: at most 600s wall-clock and 50 assistant turns"));
	assert.ok(message.includes("`subagent_budget`"));
	assert.ok(message.endsWith(task));
});

test("buildChildEnv passes the budget to the child", () => {
	const env = buildChildEnv(600_000, 50, 12345);
	assert.deepEqual(env, {
		PI_SUBAGENT_CHILD: "1",
		PI_SUBAGENT_TIMEOUT_MS: "600000",
		PI_SUBAGENT_MAX_TURNS: "50",
		PI_SUBAGENT_STARTED_AT_MS: "12345",
	});
});

test("warning is dropped when the in-flight turn ends with a final report", () => {
	const state = createBudgetWarningState();
	state.turnActive = true;

	// Threshold crossed mid-turn: the decision is deferred, not sent yet.
	assert.equal(budgetWarningOnTick(state, 510_000, 0, 600_000), "hold");

	// The in-flight turn was the final report: the warning must be dropped,
	// otherwise it lands after the report and burns an extra turn.
	assert.equal(budgetWarningOnTurnEnd(state, "stop"), "drop");

	// Settled: nothing more can happen, even if the threshold is deep inside.
	assert.equal(budgetWarningOnTick(state, 590_000, 0, 600_000), "none");
	assert.equal(budgetWarningOnTurnEnd(state, "toolUse"), "none");
});

test("warning is sent at turn end while the child is still calling tools", () => {
	const state = createBudgetWarningState();
	state.turnActive = true;

	assert.equal(budgetWarningOnTick(state, 510_000, 0, 600_000), "hold");
	assert.equal(budgetWarningOnTurnEnd(state, "toolUse"), "send");
	assert.equal(budgetWarningOnTick(state, 590_000, 0, 600_000), "none");
});

test("warning is sent immediately when no turn is in flight", () => {
	const state = createBudgetWarningState();
	assert.equal(budgetWarningOnTick(state, 300_000, 0, 600_000), "none");
	assert.equal(budgetWarningOnTick(state, 510_000, 0, 600_000), "send");
});

test("warning stays quiet until the threshold and sends nothing unprompted", () => {
	const state = createBudgetWarningState();
	state.turnActive = true;

	assert.equal(budgetWarningOnTick(state, 100_000, 0, 600_000), "none");
	assert.equal(state.pending, false);
	assert.equal(budgetWarningOnTurnEnd(state, "toolUse"), "none");
});
