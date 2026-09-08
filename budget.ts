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

// ---------------------------------------------------------------------------
// One-shot warning state machine
// ---------------------------------------------------------------------------

export interface BudgetWarningState {
	/** True once the warning was sent or deliberately dropped. */
	settled: boolean;
	/** Time threshold crossed; waiting for a turn boundary to send the warning. */
	pending: boolean;
	/** An LLM turn is currently in flight. */
	turnActive: boolean;
}

export function createBudgetWarningState(): BudgetWarningState {
	return { settled: false, pending: false, turnActive: false };
}

/**
 * Watchdog tick decision (mutates `state`).
 *
 * Returns "hold" when the threshold is crossed mid-turn: Pi delivers steer
 * messages only after the in-flight turn ends, so the decision is deferred to
 * `budgetWarningOnTurnEnd`. That way a warning can never land after a final
 * report and force a pointless extra turn (bead pi-subagent-l72).
 */
export function budgetWarningOnTick(
	state: BudgetWarningState,
	nowMs: number,
	startedAtMs: number,
	timeoutMs: number,
): "none" | "send" | "hold" {
	if (state.settled) return "none";
	if (!budgetStatus(nowMs, startedAtMs, timeoutMs).shouldWarn) return "none";
	if (state.turnActive) {
		state.pending = true;
		return "hold";
	}
	return "send";
}

/**
 * Turn-boundary decision (mutates `state`).
 *
 * A turn that ends with stopReason "stop" is the final report: the run is
 * over, so a pending warning is dropped ("drop") instead of being delivered
 * after the report and consuming an extra turn. Any other stop reason means
 * the child was still working, so a pending warning is sent ("send") and
 * becomes visible before the model's next LLM call.
 */
export function budgetWarningOnTurnEnd(
	state: BudgetWarningState,
	stopReason: string | undefined,
): "none" | "send" | "drop" {
	if (state.settled) return "none";
	if (stopReason === "stop") {
		state.pending = false;
		state.settled = true;
		return "drop";
	}
	if (state.pending) {
		state.pending = false;
		state.settled = true;
		return "send";
	}
	return "none";
}

/**
 * Run-end decision (mutates `state`).
 *
 * agent_end is the true end of the run: nothing sent after it can reach the
 * model in time. A steer queued here would either burn a pointless extra
 * turn after the final report or land during shutdown (bead
 * pi-subagent-few). Settles any pending warning so later ticks are no-ops.
 */
export function budgetWarningOnAgentEnd(
	state: BudgetWarningState,
): "none" | "drop" {
	if (state.settled) return "none";
	state.pending = false;
	state.settled = true;
	return "drop";
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
