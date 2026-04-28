/**
 * Helpers for parsing Pi JSON mode events and summarizing flow results.
 */

function getSeenFlowMessageSignatures(result) {
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

function getStreamingTextBuffer(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__streamingTextBuffer")) {
    Object.defineProperty(result, "__streamingTextBuffer", {
      value: "",
      enumerable: false,
      configurable: false,
      writable: true,
    });
    Object.defineProperty(result, "__lastEmittedWordCount", {
      value: 0,
      enumerable: false,
      configurable: false,
      writable: true,
    });
  }
  return result.__streamingTextBuffer;
}

/**
 * Drain the accumulated streaming text buffer and return it.
 * Updates the last-emitted word count for threshold tracking.
 */
export function drainStreamingText(result) {
  const buf = getStreamingTextBuffer(result);
  if (!buf) return "";
  result.__streamingTextBuffer = "";
  result.__lastEmittedWordCount = 0;
  return buf;
}

// ---------------------------------------------------------------------------
// Streaming token estimate
// ---------------------------------------------------------------------------

/** Chars per token heuristic for output estimation. */
const CHARS_PER_TOKEN = 4;

function getStreamingEstimate(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__streamingEstimate")) {
    Object.defineProperty(result, "__streamingEstimate", {
      value: { chars: 0 },
      enumerable: false,
      configurable: false,
      writable: true,
    });
  }
  return result.__streamingEstimate;
}

/**
 * Track streaming characters and estimate output tokens.
 * Called on every streaming delta.
 */
function updateStreamingEstimate(result, deltaLength) {
  if (deltaLength <= 0) return;
  const est = getStreamingEstimate(result);
  est.chars += deltaLength;
}

/**
 * Drain the current streaming estimate and return estimated output tokens.
 * Returns 0 when no streaming has occurred.
 */
export function drainStreamingEstimate(result) {
  const est = getStreamingEstimate(result);
  const tokens = Math.floor(est.chars / CHARS_PER_TOKEN);
  est.chars = 0;
  return tokens;
}

/**
 * Accumulate a text or thinking delta into the streaming buffer.
 * Returns true if the caller should emit an update.
 */
function accumulateStreamingDelta(result, delta) {
  if (!delta) return false;
  const buf = getStreamingTextBuffer(result);
  result.__streamingTextBuffer = buf + delta;
  updateStreamingEstimate(result, delta.length);
  if (result.__streamingTextBuffer.length - result.__lastEmittedWordCount >= 40) {
    result.__lastEmittedWordCount = result.__streamingTextBuffer.length;
    return true;
  }
  return false;
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

function addFlowAssistantMessage(result, message) {
  if (!message || message.role !== "assistant") return false;

  updateAssistantMetadata(result, message);

  const signature = getMessageSignature(message);
  const seen = getSeenFlowMessageSignatures(result);
  if (seen.has(signature)) return false;
  seen.add(signature);

  result.messages.push(message);

  // Reset streaming estimate when actual usage arrives
  const est = getStreamingEstimate(result);
  est.chars = 0;

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

  // Count tool call parts in the message content
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "toolCall") {
        result.usage.toolCalls++;
      }
    }
  }

  return true;
}

function addFlowAssistantMessages(result, messages) {
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const message of messages) {
    if (addFlowAssistantMessage(result, message)) changed = true;
  }
  return changed;
}

function processFlowEvent(event, result) {
  if (!event || typeof event !== "object") return false;

  switch (event.type) {
    case "message_end":
      return addFlowAssistantMessage(result, event.message);

    case "turn_end":
      return addFlowAssistantMessage(result, event.message);

    case "agent_end":
      result.sawAgentEnd = true;
      return addFlowAssistantMessages(result, event.messages);

    case "message_update": {
      const evt = event.assistantMessageEvent;
      if (!evt || typeof evt !== "object") return false;
      if (evt.type === "text_delta") {
        return accumulateStreamingDelta(result, evt.delta);
      }
      if (evt.type === "thinking_delta") {
        return accumulateStreamingDelta(result, evt.delta);
      }
      return false;
    }

    default:
      return false;
  }
}

export function processFlowJsonLine(line, result) {
  if (!line.trim()) return false;

  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }

  return processFlowEvent(event, result);
}

export function getFlowFinalText(messages) {
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

export function getFlowSummaryText(result) {
  const finalText = getFlowFinalText(result?.messages);
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
