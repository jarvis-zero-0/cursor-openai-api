import { describe, expect, test } from "bun:test";
import type {
  SDKAssistantMessage,
  SDKThinkingMessage,
  SDKToolUseMessage,
} from "@cursor/sdk";
import {
  chunkFromAssistantText,
  chunkFromReasoningText,
  chunkFromToolDelta,
  createStreamState,
  chunksFromSdkMessage,
  finishChunk,
} from "../src/stream.js";
import type { TurnPolicy } from "../src/turn-policy.js";

function policy(overrides: Partial<TurnPolicy> = {}): TurnPolicy {
  return {
    includeThinking: true,
    emitCursorTools: false,
    nativeProgress: false,
    clientTools: false,
    toolMode: "native",
    debugStream: false,
    assistantTextMode: "live",
    ...overrides,
  };
}

const runningToolCall: SDKToolUseMessage = {
  type: "tool_call",
  agent_id: "a1",
  run_id: "r1",
  call_id: "c1",
  name: "read",
  status: "running",
  args: { path: "a.ts" },
};

describe("stream adapter", () => {
  test("maps assistant text to content delta", () => {
    const state = createStreamState("composer-2");
    const chunk = chunkFromAssistantText(state, "Hello");
    expect(chunk?.choices[0]?.delta.content).toBe("Hello");
    expect(state.text).toBe("Hello");
  });

  test("maps tool_use block to tool_calls delta", () => {
    const state = createStreamState("composer-2");
    const chunk = chunkFromToolDelta(state, "tu_1", "read_file", {
      path: "a.ts",
    });
    expect(chunk.choices[0]?.delta.tool_calls?.[0]?.function?.name).toBe(
      "read_file",
    );
    expect(chunk.choices[0]?.delta.tool_calls?.[0]?.function?.arguments).toContain(
      "a.ts",
    );
  });

  test("chunksFromSdkMessage does not emit assistant text (onDelta is canonical)", () => {
    const state = createStreamState("composer-2");
    const event: SDKAssistantMessage = {
      type: "assistant",
      agent_id: "a1",
      run_id: "r1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
      },
    };
    const chunks = [...chunksFromSdkMessage(event, state, false)];
    expect(chunks).toHaveLength(0);
    expect(state.text).toBe("");
  });

  test("chunksFromSdkMessage does not emit tool_use blocks", () => {
    const event: SDKAssistantMessage = {
      type: "assistant",
      agent_id: "a1",
      run_id: "r1",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: {} }],
      },
    };

    const state = createStreamState("composer-2");
    expect([...chunksFromSdkMessage(event, state, false)]).toHaveLength(0);
    expect(state.toolCalls.size).toBe(0);
  });

  test("ignores SDK thinking messages (handled via onDelta thinking-delta)", () => {
    const state = createStreamState("composer-2");
    const event: SDKThinkingMessage = {
      type: "thinking",
      agent_id: "a1",
      run_id: "r1",
      text: "Planning...",
    };
    const chunks = [...chunksFromSdkMessage(event, state, false)];
    expect(chunks).toHaveLength(0);
    expect(state.reasoningText).toBe("");
  });

  test("chunkFromReasoningText accumulates reasoning text in state", () => {
    const state = createStreamState("composer-2");
    const chunk = chunkFromReasoningText(state, "step");
    expect(chunk?.choices[0]?.delta.reasoning_content).toBe("step");
    expect(state.reasoningText).toBe("step");
  });

  test("finish chunk sets finish_reason", () => {
    const state = createStreamState("composer-2");
    chunkFromToolDelta(state, "tu_1", "grep", { pattern: "x" });
    const done = finishChunk(state);
    expect(done.choices[0]?.finish_reason).toBe("tool_calls");
  });

  test("finish chunk emits length when max_tokens reached", () => {
    const state = createStreamState("composer-2", { maxTokens: 100 });
    state.usage = {
      prompt_tokens: 10,
      completion_tokens: 100,
      total_tokens: 110,
    };
    const done = finishChunk(state, "stop");
    expect(done.choices[0]?.finish_reason).toBe("length");
  });

  test("finish chunk normalizes non-JSON tool arguments", () => {
    const state = createStreamState("composer-2", { agentId: "a1" });
    chunkFromToolDelta(state, "tu_1", "grep", "partial");
    const done = finishChunk(state);
    const args =
      done.choices[0]?.delta.tool_calls?.[0]?.function?.arguments ??
      state.toolCalls.get("tu_1")?.arguments;
    expect(() => JSON.parse(args!)).not.toThrow();
  });

  test("finish chunk attaches cursor metadata via attachCursorMeta", () => {
    const state = createStreamState("composer-2", { agentId: "a1" });
    const done = finishChunk(state);
    expect(done.cursor?.agent_id).toBe("a1");
  });

  test("narrates native tool_call as reasoning when nativeProgress is on", () => {
    const state = createStreamState("composer-2");
    const chunks = [
      ...chunksFromSdkMessage(
        runningToolCall,
        state,
        false,
        policy({ nativeProgress: true }),
      ),
    ];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.choices[0]?.delta.reasoning_content).toBe(
      "→ read(a.ts)\n",
    );
  });

  test("narrates tool_call even when includeThinking is false (decoupled lever)", () => {
    const state = createStreamState("composer-2");
    const chunks = [
      ...chunksFromSdkMessage(
        runningToolCall,
        state,
        false,
        policy({ nativeProgress: true, includeThinking: false }),
      ),
    ];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.choices[0]?.delta.reasoning_content).toBe(
      "→ read(a.ts)\n",
    );
  });

  test("does not narrate tool_call when nativeProgress is off", () => {
    const state = createStreamState("composer-2");
    const chunks = [
      ...chunksFromSdkMessage(
        runningToolCall,
        state,
        false,
        policy({ nativeProgress: false }),
      ),
    ];
    expect(chunks).toHaveLength(0);
    expect(state.reasoningText).toBe("");
  });

  test("narrates completed shell tool_call result stdout", () => {
    const state = createStreamState("composer-2");
    const completed: SDKToolUseMessage = {
      type: "tool_call",
      agent_id: "a1",
      run_id: "r1",
      call_id: "c1",
      name: "shell",
      status: "completed",
      args: { command: "ls" },
      result: { status: "success", value: { stdout: "file-a\nfile-b" } },
    };
    const chunks = [
      ...chunksFromSdkMessage(
        completed,
        state,
        false,
        policy({ nativeProgress: true }),
      ),
    ];
    expect(chunks[0]?.choices[0]?.delta.reasoning_content).toBe(
      "✓ shell → file-a file-b\n",
    );
  });

  test("maps system message to cursor actual_model metadata", () => {
    const state = createStreamState("composer-2", { agentId: "a1" });
    const chunks = [
      ...chunksFromSdkMessage(
        {
          type: "system",
          agent_id: "a1",
          run_id: "r1",
          model: { id: "composer-2.5" },
        },
        state,
        false,
      ),
    ];
    expect(chunks).toHaveLength(0);
    expect(state.cursorMeta.actual_model).toBe("composer-2.5");
  });
});
