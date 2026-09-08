/**
 * Helpers for parsing Pi JSON mode events and summarizing subagent results.
 */

function getSeenMessageSignatures(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__seenMessageSignatures")) {
    Object.defineProperty(result, "__seenMessageSignatures", {
      value: new Set(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result.__seenMessageSignatures;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
}

function getMessageSignature(message) {
  return stableStringify(message);
}

function updateAssistantMetadata(result, message) {
  if (!message || message.role !== "assistant") return;
  if (!result.model && message.model) result.model = message.model;
  if (message.stopReason) result.stopReason = message.stopReason;
  if (message.errorMessage) result.errorMessage = message.errorMessage;
}

function addAssistantMessage(result, message) {
  if (!message || message.role !== "assistant") return false;

  const signature = getMessageSignature(message);
  const seen = getSeenMessageSignatures(result);

  // A brand-new assistant message at the turn limit is over budget: block it
  // before any metadata or usage mutation. This is the backstop for
  // gate-passed turn_end/agent_end events carrying unseen messages (bead
  // pi-subagent-hom); seen replays dedupe below without flagging.
  if (
    !seen.has(signature) &&
    result.maxTurnsLimit !== undefined &&
    result.usage.turns >= result.maxTurnsLimit
  ) {
    markMaxTurnsExceeded(result);
    return false;
  }

  updateAssistantMetadata(result, message);

  if (seen.has(signature)) return false;
  seen.add(signature);

  result.messages.push(message);

  result.usage.turns++;
  const usage = message.usage;
  if (usage) {
    result.usage.input += usage.input || 0;
    result.usage.output += usage.output || 0;
    result.usage.cacheRead += usage.cacheRead || 0;
    result.usage.cacheWrite += usage.cacheWrite || 0;
    result.usage.cost += usage.cost?.total || 0;
    result.usage.contextTokens = usage.totalTokens || 0;
  }

  return true;
}

function addAssistantMessages(result, messages) {
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const message of messages) {
    if (addAssistantMessage(result, message)) changed = true;
  }
  return changed;
}

// Event types that can carry an assistant message. Anything else (e.g.
// compaction_start/end, auto_retry_*, session_* housekeeping) introduces no
// new assistant message.
const MESSAGE_CARRYING_EVENT_TYPES = new Set(["message_end", "turn_end", "agent_end"]);

function markMaxTurnsExceeded(result) {
  result.maxTurnsExceeded = true;
  result.stopReason = "max_turns";
  result.errorMessage = `Sub-agent exceeded maximum turns (${result.maxTurnsLimit})`;
  result.stderr = `Sub-agent exceeded maximum turns (${result.maxTurnsLimit})`;
}

export function processPiEvent(event, result) {
  if (!event || typeof event !== "object") return false;

  // The max-turns flag is terminal: once set, no later event may mutate the
  // result. A turn_end replaying a blocked message cannot re-add it (bead
  // pi-subagent-hom), and post-run housekeeping cannot poison a settled run.
  if (result.maxTurnsExceeded) return false;

  // Block sub-agents from spawning further sub-agents
  // This is enforced at the runner level (not via system prompt) for reliability
  if (event.type === "message_end" && event.message?.role === "assistant") {
    const content = event.message.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "toolCall" && part?.name === "subagent") {
          result.stopReason = "subagent_recursion_blocked";
          result.errorMessage = "Sub-agents are not allowed to spawn further sub-agents.";
          result.stderr = result.errorMessage;
          result.exitCode = 1;
          return false;
        }
      }
    }
  }

  // A new turn at the limit means another over-budget LLM call is starting:
  // flag it so the runner kills the child before that call completes.
  if (event.type === "turn_start") {
    if (result.maxTurnsLimit !== undefined && result.usage.turns >= result.maxTurnsLimit) {
      markMaxTurnsExceeded(result);
    }
    return false;
  }

  // Housekeeping events carry no assistant message and must never fail a run
  // (bead pi-subagent-rdf): real pi emits compaction_start/end AFTER agent_end,
  // and the old gate treated them as over-budget turns, flipping a clean,
  // completed run to max_turns and killing the child mid-compaction.
  if (!MESSAGE_CARRYING_EVENT_TYPES.has(event.type)) return false;

  // Check max turns limit before processing new events.
  // maxTurnsLimit is the numeric limit; maxTurnsExceeded is the "limit hit" flag.
  if (result.maxTurnsLimit !== undefined && result.usage.turns >= result.maxTurnsLimit) {
    // The child used its full turn budget. If it ended exactly on a clean
    // final report (last assistant message stopped with non-empty text, no
    // pending tool calls), the task is done: let the run end naturally
    // instead of failing a completed run (bead pi-subagent-l72). turn_end and
    // agent_end normally replay already-seen messages, so passing them adds
    // nothing; a new assistant message snuck into them is blocked by the
    // check inside addAssistantMessage (bead pi-subagent-hom).
    if (!isFinalReportMessage(result.messages)) {
      markMaxTurnsExceeded(result);
      return false;
    }
  }

  switch (event.type) {
    case "message_end":
      return addAssistantMessage(result, event.message);

    case "turn_end":
      return addAssistantMessage(result, event.message);

    case "agent_end":
      result.sawAgentEnd = true;
      return addAssistantMessages(result, event.messages);

    default:
      return false;
  }
}

export function processPiJsonLine(line, result) {
  if (!line.trim()) return false;

  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }

  return processPiEvent(event, result);
}

/**
 * Whether the child's most recent assistant message is a final report:
 * the model stopped without pending tool calls and produced non-empty text.
 */
function isFinalReportMessage(messages) {
  if (!Array.isArray(messages)) return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    const hasText = (message.content ?? []).some(
      (part) => part?.type === "text" && typeof part.text === "string" && part.text.length > 0,
    );
    return message.stopReason === "stop" && hasText;
  }

  return false;
}

export function getFinalAssistantText(messages) {
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
        return part.text;
      }
    }
  }

  return "";
}

export function getResultSummaryText(result) {
  const finalText = getFinalAssistantText(result?.messages);
  if (finalText) return finalText;

  if (typeof result?.errorMessage === "string" && result.errorMessage.trim()) {
    return result.errorMessage.trim();
  }

  const isError =
    (typeof result?.exitCode === "number" && result.exitCode > 0) ||
    result?.stopReason === "error" ||
    result?.stopReason === "aborted";

  if (isError && typeof result?.stderr === "string" && result.stderr.trim()) {
    return result.stderr.trim();
  }

  return "(no output)";
}
