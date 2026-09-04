/**
 * Time-budget helpers for sub-agent runs.
 *
 * The parent runner tells the child its budget via env vars (wall-clock limit,
 * turn limit, start time). The child registers a `subagent_budget` tool built
 * on these helpers and injects a one-shot warning when the budget runs low.
 *
 * All functions are pure so they can be unit tested without a pi process.
 */

export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const TIMEOUT_ENV = "PI_SUBAGENT_TIMEOUT_MS";
export const MAX_TURNS_ENV = "PI_SUBAGENT_MAX_TURNS";
export const STARTED_AT_ENV = "PI_SUBAGENT_STARTED_AT_MS";

export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_TURNS = 50;

/**
 * Remaining-budget threshold at which the child is warned.
 * 25% of the limit, clamped to [60s, 240s] so short runs still get a
 * meaningful warning and long runs don't wait forever before warning.
 */
export function warnRemainingMs(timeoutMs: number): number {
	return Math.min(Math.max(timeoutMs * 0.25, 60_000), 240_000);
}

export interface BudgetStatus {
	elapsedMs: number;
	remainingMs: number;
	limitMs: number;
	warnAtRemainingMs: number;
	shouldWarn: boolean;
}

export function budgetStatus(
	nowMs: number,
	startedAtMs: number,
	timeoutMs: number,
): BudgetStatus {
	const elapsedMs = Math.max(0, nowMs - startedAtMs);
	const remainingMs = timeoutMs - elapsedMs;
	const warnAtRemainingMs = warnRemainingMs(timeoutMs);
	return {
		elapsedMs,
		remainingMs,
		limitMs: timeoutMs,
		warnAtRemainingMs,
		shouldWarn: remainingMs <= warnAtRemainingMs,
	};
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Human-readable budget status for the `subagent_budget` tool. */
export function describeSubagentBudget(
	nowMs: number,
	startedAtMs: number,
	timeoutMs: number,
	maxTurns?: number,
	turnsUsed?: number,
): string {
	const status = budgetStatus(nowMs, startedAtMs, timeoutMs);
	const lines = [
		`Time budget: ${formatDuration(status.remainingMs)} remaining of ${formatDuration(status.limitMs)} total (elapsed ${formatDuration(status.elapsedMs)}).`,
	];
	if (maxTurns !== undefined) {
		lines.push(
			`Turn budget: ${turnsUsed ?? 0} of ${maxTurns} assistant turns used.`,
		);
	}
	if (status.shouldWarn) {
		lines.push(
			"Time is running low: stop starting new work and write your final report now.",
		);
	}
	return lines.join("\n");
}

/** One-shot low-budget warning injected into the child's session. */
export function budgetWarningText(
	nowMs: number,
	startedAtMs: number,
	timeoutMs: number,
): string {
	const status = budgetStatus(nowMs, startedAtMs, timeoutMs);
	const secondsLeft = Math.max(0, Math.ceil(status.remainingMs / 1000));
	return (
		`Budget warning: about ${secondsLeft}s remain of your ${formatDuration(status.limitMs)} time budget. ` +
		"Stop starting new work now. Finish what you are doing, then write your final report as your last message — it is the only thing returned to the caller."
	);
}

/** Task message sent to the child, with the run's budget stated up front. */
export function buildTaskMessage(
	task: string,
	timeoutMs: number,
	maxTurns: number,
): string {
	return (
		`[sub-agent-task] Complete this task:\n\n` +
		`Budget: at most ${Math.round(timeoutMs / 1000)}s wall-clock and ${maxTurns} assistant turns. ` +
		"Check remaining budget any time with the `subagent_budget` tool. " +
		"When time is low, stop calling tools and write your final report. " +
		`An automated warning is injected when about ${Math.round(warnRemainingMs(timeoutMs) / 1000)}s remain.\n\n` +
		task
	);
}

/** Env vars that tell the child its own budget. */
export function buildChildEnv(
	timeoutMs: number,
	maxTurns: number,
	nowMs: number,
): Record<string, string> {
	return {
		[SUBAGENT_CHILD_ENV]: "1",
		[TIMEOUT_ENV]: String(timeoutMs),
		[MAX_TURNS_ENV]: String(maxTurns),
		[STARTED_AT_ENV]: String(nowMs),
	};
}
