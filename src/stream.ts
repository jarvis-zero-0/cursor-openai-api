import type { SDKMessage } from "@cursor/sdk";
import { attachCursorMeta } from "./cursor-meta.js";
import type { CompletionFinishReason } from "./finish-reason.js";
import { resolveFinishReason } from "./finish-reason.js";
import { formatToolProgressLine } from "./native-progress.js";
import type { ChatCompletionChunk, CursorCompletionMeta, OpenAIUsage } from "./openai.js";
import { makeCompletionId } from "./openai.js";
import { normalizeToolArguments } from "./tool-args.js";
import type { TurnPolicy } from "./turn-policy.js";

export interface StreamState {
  completionId: string;
  model: string;
  created: number;
  text: string;
  pendingText: string;
  reasoningText: string;
  // Set when visible text is interrupted by an interleaved boundary (thinking
  // or tool call) in live mode, so the next text run is separated rather than
  // fused onto the previous one (e.g. "...feasible." + "Let me check...").
  needsTextSeparator: boolean;
  usage?: OpenAIUsage;
  maxTokens?: number;
  cursorMeta: CursorCompletionMeta;
  toolCalls: Map<
    string,
    { id: string; name: string; arguments: string; index: number }
  >;
  nextToolIndex: number;
}

export function isSdkMessage(event: unknown): event is SDKMessage {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    typeof Reflect.get(event, "type") === "string"
  );
}

export function createStreamState(
  model: string,
  options?: { maxTokens?: number; agentId?: string },
): StreamState {
  return {
    completionId: makeCompletionId(),
    model,
    created: Math.floor(Date.now() / 1000),
    text: "",
    pendingText: "",
    reasoningText: "",
    needsTextSeparator: false,
    maxTokens: options?.maxTokens,
    cursorMeta: { agent_id: options?.agentId ?? "" },
    toolCalls: new Map(),
    nextToolIndex: 0,
  };
}

export function bufferAssistantText(state: StreamState, text: string): void {
  state.pendingText += text;
}

// OpenCode renders all content deltas in one text part, so delay final text
// until turn-end when reasoning needs to appear first.
export function flushBufferedAssistantText(
  state: StreamState,
): ChatCompletionChunk | null {
  const text = state.pendingText;
  state.pendingText = "";
  return chunkFromAssistantText(state, text);
}

// Interrupted buffered text is preamble, not the final answer.
export function flushBufferedAssistantTextAsReasoning(
  state: StreamState,
): ChatCompletionChunk | null {
  const text = state.pendingText;
  state.pendingText = "";
  return chunkFromReasoningText(state, text);
}

export function mergeCursorMetaFromSdkMessage(
  state: StreamState,
  event: SDKMessage,
): void {
  if (event.type === "system") {
    if (event.model?.id) state.cursorMeta.actual_model = event.model.id;
    return;
  }
  if (event.type === "request") {
    state.cursorMeta.request_id = event.request_id;
    return;
  }
  if (event.type === "thinking" && event.thinking_duration_ms != null) {
    state.cursorMeta.thinking_duration_ms = event.thinking_duration_ms;
  }
}

export function applyThinkingCompletedMeta(
  state: StreamState,
  thinkingDurationMs?: number,
): void {
  if (thinkingDurationMs != null) {
    state.cursorMeta.thinking_duration_ms = thinkingDurationMs;
  }
}

function baseChunk(
  state: StreamState,
  delta: ChatCompletionChunk["choices"][0]["delta"],
  finishReason: ChatCompletionChunk["choices"][0]["finish_reason"] = null,
): ChatCompletionChunk {
  return {
    id: state.completionId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function chunkFromAssistantText(
  state: StreamState,
  text: string,
): ChatCompletionChunk | null {
  if (!text) return null;
  state.text += text;
  return baseChunk(state, { content: text });
}

export function chunkFromReasoningText(
  state: StreamState,
  text: string,
): ChatCompletionChunk | null {
  if (!text) return null;
  state.reasoningText += text;
  return baseChunk(state, { reasoning_content: text, reasoning: text });
}

export function chunkFromToolDelta(
  state: StreamState,
  callId: string,
  name: string,
  input?: unknown,
): ChatCompletionChunk {
  if (input === undefined) {
    if (!state.toolCalls.has(callId)) {
      const index = state.nextToolIndex++;
      state.toolCalls.set(callId, {
        id: callId,
        name,
        arguments: "",
        index,
      });
    }
    const entry = state.toolCalls.get(callId)!;
    return baseChunk(state, {
      tool_calls: [
        {
          index: entry.index,
          id: callId,
          type: "function",
          function: { name, arguments: "" },
        },
      ],
    });
  }

  const fragment =
    typeof input === "string" ? input : JSON.stringify(input ?? {});
  let entry = state.toolCalls.get(callId);
  if (!entry) {
    entry = {
      id: callId,
      name,
      arguments: fragment,
      index: state.nextToolIndex++,
    };
    state.toolCalls.set(callId, entry);
    return baseChunk(state, {
      tool_calls: [
        {
          index: entry.index,
          id: entry.id,
          type: "function",
          function: { name: entry.name, arguments: entry.arguments },
        },
      ],
    });
  }
  entry.arguments += fragment;
  return baseChunk(state, {
    tool_calls: [
      {
        index: entry.index,
        function: { arguments: fragment },
      },
    ],
  });
}

export function finalizeToolCalls(state: StreamState): void {
  for (const entry of state.toolCalls.values()) {
    entry.arguments = normalizeToolArguments(entry.arguments);
  }
}

export function roleChunk(state: StreamState): ChatCompletionChunk {
  return baseChunk(state, { role: "assistant" });
}

export function finishChunk(
  state: StreamState,
  preferred: "stop" | "tool_calls" = "stop",
): ChatCompletionChunk {
  finalizeToolCalls(state);
  const finishReason: CompletionFinishReason = resolveFinishReason(
    state,
    preferred,
  );
  const chunk = baseChunk(state, {}, finishReason);
  const withUsage = state.usage ? { ...chunk, usage: state.usage } : chunk;
  const meta = state.cursorMeta.agent_id ? state.cursorMeta : undefined;
  return attachCursorMeta(withUsage, meta);
}

export function* chunksFromSdkMessage(
  event: SDKMessage,
  state: StreamState,
  debugStream = false,
  policy?: TurnPolicy,
): Generator<ChatCompletionChunk> {
  mergeCursorMetaFromSdkMessage(state, event);

  // Option (b): narrate native tool activity as reasoning_content. Tool name,
  // args, status, and RESULT all arrive on this run.stream() channel via
  // SDKToolUseMessage (`tool_call`), which is otherwise ignored here. This is
  // the SINGLE narration site for tool lifecycle events — the onDelta path
  // (interaction-delta.ts) deliberately does not narrate them, so each event
  // produces exactly one progress line.
  //
  // Gated by `nativeProgress` ALONE (forced off in the client tool loop and
  // when emitCursorTools is on). It is intentionally NOT gated by
  // `includeThinking`: progress is a separate lever (`cursor_native_progress`)
  // from the reasoning-suppression lever (`includeThinking`). Caveat: narration
  // rides `reasoning_content`, so a platform that strips/hides reasoning will
  // not render progress — that is the accepted opt-out for such platforms.
  if (event.type === "tool_call" && policy?.nativeProgress) {
    const line = formatToolProgressLine(event);
    if (line) {
      const chunk = chunkFromReasoningText(state, line);
      if (chunk) yield chunk;
    }
    return;
  }

  if (debugStream && event.type === "status") {
    const meta = `${event.status}${event.message ? `: ${event.message}` : ""}`;
    const chunk = chunkFromAssistantText(state, `\n[status] ${meta}\n`);
    if (chunk) yield chunk;
  }
}
