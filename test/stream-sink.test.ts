import { describe, expect, test } from "bun:test";
import { ChatCompletionStreamSink } from "../src/stream-sink.js";
import { CursorMetaAccumulator } from "../src/cursor-meta.js";
import type { ChatCompletionChunk } from "../src/openai.js";
import {
  chunkFromAssistantText,
  createStreamState,
} from "../src/stream.js";

describe("ChatCompletionStreamSink", () => {
  test("serializes concurrent delta writes before completion", async () => {
    const state = createStreamState("composer-2", { agentId: "agent-1" });
    const meta = new CursorMetaAccumulator("agent-1");
    const events: string[] = [];

    let releaseFirstWrite!: () => void;
    const firstWriteReleased = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });

    const sink = new ChatCompletionStreamSink(
      async (chunk) => {
        if (chunk === "[DONE]") {
          events.push("done");
          return;
        }

        const choice = chunk.choices[0];
        const marker =
          choice?.delta.content ??
          choice?.delta.role ??
          choice?.finish_reason ??
          "chunk";

        if (marker === "A") {
          await firstWriteReleased;
        }
        events.push(marker);
      },
      state,
      meta,
    );

    const first = sink.writeDelta(
      chunkFromAssistantText(state, "A") as ChatCompletionChunk,
    );
    await Promise.resolve();
    const second = sink.writeDelta(
      chunkFromAssistantText(state, "B") as ChatCompletionChunk,
    );
    const complete = sink.complete();

    await Promise.resolve();
    expect(events).toEqual(["assistant"]);

    releaseFirstWrite();
    await Promise.all([first, second, complete]);

    expect(events).toEqual(["assistant", "A", "B", "stop", "done"]);
  });
});
