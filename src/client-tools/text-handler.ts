import {
  beforeInterleavedBoundary,
  emitAssistantText,
} from "../assistant-output.js";
import type { ChatCompletionChunk } from "../openai.js";
import { chunkFromToolDelta, type StreamState } from "../stream.js";
import type { TurnPolicy } from "../turn-policy.js";
import { ClientToolMarkerFilter } from "./marker-parser.js";
import { toOpenAiToolCalls } from "./openai-map.js";
import type { ClientToolSpec, MarkerParserEvent } from "./types.js";

export interface ClientToolTextHandler {
  pushText(
    state: StreamState,
    policy: TurnPolicy,
    text: string,
  ): Generator<ChatCompletionChunk | null>;
  flush(
    state: StreamState,
    policy: TurnPolicy,
  ): Generator<ChatCompletionChunk | null>;
}

export function createClientToolTextHandler(
  tools: ClientToolSpec[],
): ClientToolTextHandler {
  const filter = new ClientToolMarkerFilter();

  function* markerEventsToChunks(
    events: MarkerParserEvent[],
    state: StreamState,
    policy: TurnPolicy,
  ): Generator<ChatCompletionChunk | null> {
    for (const event of events) {
      if (event.type === "text" && event.text) {
        const chunk = emitAssistantText(state, policy, event.text);
        if (chunk) yield chunk;
        continue;
      }
      if (event.type !== "tool_call") continue;

      yield* beforeInterleavedBoundary(state, policy);
      const [mapped] = toOpenAiToolCalls({
        toolCalls: [event.toolCall],
        tools,
        responseId: state.completionId,
        startIndex: state.toolCalls.size,
      });
      if (!mapped) continue;
      yield chunkFromToolDelta(
        state,
        mapped.id,
        mapped.function.name,
        mapped.function.arguments,
      );
    }
  }

  return {
    *pushText(state, policy, text) {
      yield* markerEventsToChunks(filter.push(text), state, policy);
    },
    *flush(state, policy) {
      yield* markerEventsToChunks(filter.flush(), state, policy);
    },
  };
}
