import { describe, expect, test } from "bun:test";
import type { SDKThinkingMessage } from "@cursor/sdk";
import type { TurnStreamContext } from "../src/turn-stream.js";
import { applyInteractionUpdate } from "../src/interaction-delta.js";
import { createStreamState, chunksFromSdkMessage } from "../src/stream.js";
import type { ChatCompletionChunk } from "../src/openai.js";

const withThinking: TurnStreamContext = {
  policy: {
    includeThinking: true,
    emitCursorTools: false,
    clientToolLoop: false,
    debugStream: false,
    assistantTextMode: "live",
  },
};

describe("thinking deduplication", () => {
  test("uses thinking-delta only; ignores duplicate SDK thinking messages", async () => {
    const state = createStreamState("composer-2.5");
    const chunks: ChatCompletionChunk[] = [];
    const onChunk = async (chunk: ChatCompletionChunk) => {
      chunks.push(chunk);
    };

    await applyInteractionUpdate(
      state,
      { type: "thinking-delta", text: "The user wants me to " },
      withThinking,
      onChunk,
    );
    await applyInteractionUpdate(
      state,
      { type: "thinking-delta", text: "generate a random number." },
      withThinking,
      onChunk,
    );

    const event: SDKThinkingMessage = {
      type: "thinking",
      agent_id: "a1",
      run_id: "r1",
      text: "generate a random number.",
    };
    const legacyChunks = [...chunksFromSdkMessage(event, state, false)];

    expect(legacyChunks).toHaveLength(0);
    expect(chunks).toHaveLength(2);
    expect(state.reasoningText).toBe(
      "The user wants me to generate a random number.",
    );
  });
});
