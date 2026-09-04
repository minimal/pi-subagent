import test from "node:test";
import assert from "node:assert/strict";
import {
	budgetStatus,
	buildChildEnv,
	buildTaskMessage,
	budgetWarningText,
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
