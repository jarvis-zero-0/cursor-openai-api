import type { InteractionUpdate } from "@cursor/sdk";
import { beforeInterleavedBoundary } from "./assistant-output.js";
import { normalizeInteractionUpdate } from "./interaction-update.js";
import type { ChatCompletionChunk } from "./openai.js";
import { chunkFromReasoningText, chunkFromToolDelta } from "./stream.js";
import type { StreamState } from "./stream.js";
import { applyThinkingCompletedMeta } from "./stream.js";
import type { TurnPolicy } from "./turn-policy.js";
import type { TurnStreamContext } from "./turn-stream.js";

function* emitCursorToolDelta(
  state: StreamState,
  policy: TurnPolicy,
  callId: string,
  name: string,
  args?: string,
): Generator<ChatCompletionChunk | null> {
  yield* beforeInterleavedBoundary(state, policy);
  yield chunkFromToolDelta(state, callId, name, args);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled interaction update: ${JSON.stringify(value)}`);
}

export function* chunksFromInteractionUpdate(
  update: InteractionUpdate,
  state: StreamState,
  stream: TurnStreamContext,
): Generator<ChatCompletionChunk | null> {
  const { policy, assistantText } = stream;

  if (update.type === "turn-ended") {
    yield* assistantText.flushTurn(state, policy);
    return;
  }

  const normalized = normalizeInteractionUpdate(update);

  switch (normalized.type) {
    case "text-delta": {
      if (!normalized.text) return;
      yield* assistantText.pushDelta(state, policy, normalized.text);
      return;
    }
    case "thinking-delta": {
      if (!policy.includeThinking || !normalized.text) return;
      yield* beforeInterleavedBoundary(state, policy);
      const chunk = chunkFromReasoningText(state, normalized.text);
      if (chunk) yield chunk;
      return;
    }
    case "thinking-completed": {
      applyThinkingCompletedMeta(state, normalized.thinkingDurationMs);
      return;
    }
    case "tool-call-started": {
      if (!policy.emitCursorTools) return;
      yield* emitCursorToolDelta(
        state,
        policy,
        normalized.callId,
        normalized.name,
        normalized.args,
      );
      return;
    }
    case "partial-tool-call": {
      if (!policy.emitCursorTools) return;
      const name =
        normalized.name || state.toolCalls.get(normalized.callId)?.name;
      if (!name) return;
      yield* emitCursorToolDelta(
        state,
        policy,
        normalized.callId,
        name,
        normalized.args,
      );
      return;
    }
    case "tool-call-completed":
      return;
    case "ignored":
      return;
    default:
      return assertNever(normalized);
  }
}

export async function applyInteractionUpdate(
  state: StreamState,
  update: InteractionUpdate,
  stream: TurnStreamContext,
  onChunk?: (chunk: ChatCompletionChunk) => Promise<void>,
): Promise<void> {
  for (const chunk of chunksFromInteractionUpdate(update, state, stream)) {
    if (chunk && onChunk) await onChunk(chunk);
  }
}
