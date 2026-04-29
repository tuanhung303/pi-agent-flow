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

/** EMA smoothing factor for tokens-per-second (higher = more responsive). */
const EMA_ALPHA = 0.3;

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
 * Lazily initialize TPS tracking properties on the result object.
 * - __lastEmitTime: timestamp (ms) of the last streaming emit
 * - __smoothedTps: EMA-smoothed tokens-per-second value
 */
function getTpsTracker(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__smoothedTps")) {
    Object.defineProperty(result, "__smoothedTps", {
      value: 0,
      enumerable: false,
      configurable: false,
      writable: true,
    });
    Object.defineProperty(result, "__lastEmitTime", {
      value: 0,
      enumerable: false,
      configurable: false,
      writable: true,
    });
  }
  return result;
}

/**
 * Update the EMA-smoothed tokens-per-second based on a new sample.
 * Called from emitUpdate() with the estimated output tokens since last emit.
 * Skips the update when delta time or tokens are zero (e.g., first emit).
 */
export function updateSmoothedTps(result, estimatedTokens) {
  if (estimatedTokens <= 0) return;
  const tracker = getTpsTracker(result);
  const now = Date.now();
  if (tracker.__lastEmitTime === 0) {
    // First emit — seed the value directly
    tracker.__lastEmitTime = now;
    return;
  }
  const deltaSec = (now - tracker.__lastEmitTime) / 1000;
  if (deltaSec <= 0) return;
  const instantRate = estimatedTokens / deltaSec;
  if (tracker.__smoothedTps === 0) {
    tracker.__smoothedTps = instantRate;
  } else {
    tracker.__smoothedTps = EMA_ALPHA * instantRate + (1 - EMA_ALPHA) * tracker.__smoothedTps;
  }
  tracker.__lastEmitTime = now;
}

/**
 * Return the current EMA-smoothed tokens-per-second value.
 */
export function drainSmoothedTps(result) {
  const tracker = getTpsTracker(result);
  return tracker.__smoothedTps;
}

/**
 * Lazily initialize ctx baseline tracking properties on the result object.
 * - __ctxBaseline: last known real totalTokens from message_end
 * - __ctxStreamingChars: cumulative output chars since last baseline reset
 */
function getCtxBaseline(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__ctxBaseline")) {
    Object.defineProperty(result, "__ctxBaseline", {
      value: 0,
      enumerable: false,
      configurable: false,
      writable: true,
    });
    Object.defineProperty(result, "__ctxStreamingChars", {
      value: 0,
      enumerable: false,
      configurable: false,
      writable: true,
    });
  }
  return result.__ctxBaseline;
}

/**
 * Track streaming characters and estimate output tokens.
 * Called on every streaming delta.
 */
function updateStreamingEstimate(result, deltaLength) {
  if (deltaLength <= 0) return;
  const est = getStreamingEstimate(result);
  est.chars += deltaLength;
  // Also accumulate chars for ctx estimation (not drained on emit)
  getCtxBaseline(result);
  result.__ctxStreamingChars += deltaLength;
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
 * Return the estimated context tokens: last known real totalTokens (baseline)
 * plus any additional output tokens estimated since that baseline was set.
 * Returns 0 before the first message_end when no baseline exists yet,
 * in which case the caller should fall back to the streaming output estimate.
 */
export function drainCtxEstimate(result) {
  getCtxBaseline(result);
  const streamingTokens = Math.floor(result.__ctxStreamingChars / CHARS_PER_TOKEN);
  return result.__ctxBaseline + streamingTokens;
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

    // Snapshot ctx baseline for smooth streaming estimation
    result.__ctxBaseline = usage.totalTokens || 0;
    result.__ctxStreamingChars = 0;
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
