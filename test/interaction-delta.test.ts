import { describe, expect, test } from "bun:test";
import type { ClientToolSpec } from "../src/client-tools/types.js";
import { chunksFromInteractionUpdate } from "../src/interaction-delta.js";
import { createStreamState } from "../src/stream.js";
import type { TurnPolicy } from "../src/turn-policy.js";
import {
  defaultAssistantTextStream,
  type TurnStreamContext,
} from "../src/turn-stream.js";

// Client tools are bridged as native customTools; assistant text always flows
// through the default stream (no marker parsing).
function streamContext(policy: TurnPolicy, specs?: ClientToolSpec[]): TurnStreamContext {
  if (!specs?.length) {
    return { policy, assistantText: defaultAssistantTextStream() };
  }
  return {
    policy,
    clientToolSpecs: specs,
    assistantText: defaultAssistantTextStream(),
  };
}

const livePolicy: TurnPolicy = {
  includeThinking: true,
  emitCursorTools: false,
  nativeProgress: false,
  clientTools: false,
  debugStream: false,
  assistantTextMode: "live",
};

const finalContentPolicy: TurnPolicy = {
  ...livePolicy,
  assistantTextMode: "final-content",
};

const preamblePolicy: TurnPolicy = {
  ...livePolicy,
  assistantTextMode: "preamble-as-reasoning",
};

const withCursorTools: TurnPolicy = {
  includeThinking: false,
  emitCursorTools: true,
  nativeProgress: false,
  clientTools: false,
  debugStream: false,
  assistantTextMode: "final-content",
};

// Native worker with progress narration on. includeThinking is false to prove
// narration is decoupled from the thinking lever.
const nativeProgressPolicy: TurnPolicy = {
  includeThinking: false,
  emitCursorTools: false,
  nativeProgress: true,
  clientTools: false,
  toolMode: "native",
  debugStream: false,
  assistantTextMode: "live",
};

const clientToolPreambleStream = streamContext(
  {
    includeThinking: true,
    emitCursorTools: false,
    nativeProgress: false,
    clientTools: true,
    debugStream: false,
    assistantTextMode: "preamble-as-reasoning",
  },
  [{ name: "glob", parameters: { type: "object", properties: {} } }],
);

const clientToolLiveStream = streamContext(
  {
    includeThinking: true,
    emitCursorTools: false,
    nativeProgress: false,
    clientTools: true,
    debugStream: false,
    assistantTextMode: "live",
  },
  [{ name: "glob", parameters: { type: "object", properties: {} } }],
);

const clientToolEchoStream = streamContext(
  {
    includeThinking: false,
    emitCursorTools: false,
    nativeProgress: false,
    clientTools: true,
    debugStream: false,
    assistantTextMode: "live",
  },
  [{ name: "echo" }],
);

function collectInterleavedTurn(
  policy: TurnPolicy,
): ChatCompletionChunkLike[] {
  const state = createStreamState("composer-2");
  const stream = streamContext(policy);
  const chunks: ChatCompletionChunkLike[] = [];

  for (const chunk of chunksFromInteractionUpdate(
    { type: "thinking-delta", text: "think A" },
    state,
    stream,
  )) {
    if (chunk) chunks.push(chunk);
  }
  for (const chunk of chunksFromInteractionUpdate(
    { type: "text-delta", text: "early text" },
    state,
    stream,
  )) {
    if (chunk) chunks.push(chunk);
  }
  for (const chunk of chunksFromInteractionUpdate(
    { type: "thinking-delta", text: "think B" },
    state,
    stream,
  )) {
    if (chunk) chunks.push(chunk);
  }
  for (const chunk of chunksFromInteractionUpdate(
    { type: "text-delta", text: "final text" },
    state,
    stream,
  )) {
    if (chunk) chunks.push(chunk);
  }
  for (const chunk of chunksFromInteractionUpdate(
    { type: "turn-ended" },
    state,
    stream,
  )) {
    if (chunk) chunks.push(chunk);
  }

  return chunks;
}

type ChatCompletionChunkLike = {
  choices: Array<{
    delta: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{ function?: { name?: string } }>;
    };
  }>;
};

describe("chunksFromInteractionUpdate", () => {
  test("live mode streams text-delta immediately", () => {
    const state = createStreamState("composer-2");
    const chunks = [
      ...chunksFromInteractionUpdate(
        { type: "text-delta", text: "Hello" },
        state,
        streamContext(livePolicy),
      ),
    ];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.choices[0]?.delta.content).toBe("Hello");
    expect(state.text).toBe("Hello");
    expect(state.pendingText).toBe("");
  });

  test("maps thinking-delta when enabled", () => {
    const state = createStreamState("composer-2");
    const chunks = [
      ...chunksFromInteractionUpdate(
        { type: "thinking-delta", text: "plan" },
        state,
        streamContext(preamblePolicy),
      ),
    ];
    expect(chunks[0]?.choices[0]?.delta.reasoning_content).toBe("plan");
  });

  test("live mode interleaved turn streams content as it arrives", () => {
    const chunks = collectInterleavedTurn(livePolicy);
    const contents = chunks
      .map((c) => c.choices[0]?.delta.content)
      .filter(Boolean);
    const reasoning = chunks
      .map((c) => c.choices[0]?.delta.reasoning_content)
      .filter(Boolean);

    expect(reasoning).toEqual(["think A", "think B"]);
    // "early text" and "final text" are separated by a thinking boundary, so a
    // newline is injected to prevent the two runs from fusing together.
    expect(contents).toEqual(["early text", "\nfinal text"]);
  });

  test("live mode does not fuse text runs split by an interleaved boundary", () => {
    const state = createStreamState("composer-2");
    const stream = streamContext(livePolicy);
    const contents: string[] = [];

    for (const update of [
      { type: "text-delta", text: "...is feasible." },
      { type: "thinking-delta", text: "internal plan" },
      { type: "text-delta", text: "Let me check the session keys." },
    ] as const) {
      for (const chunk of chunksFromInteractionUpdate(update, state, stream)) {
        const content = chunk?.choices[0]?.delta.content;
        if (content) contents.push(content);
      }
    }

    expect(contents).toEqual(["...is feasible.", "\nLet me check the session keys."]);
    expect(state.text).toBe("...is feasible.\nLet me check the session keys.");
  });

  test("live mode keeps existing separator when text already ends in whitespace", () => {
    const state = createStreamState("composer-2");
    const stream = streamContext(livePolicy);
    const contents: string[] = [];

    for (const update of [
      { type: "text-delta", text: "Checking.\n" },
      { type: "thinking-delta", text: "plan" },
      { type: "text-delta", text: "Done." },
    ] as const) {
      for (const chunk of chunksFromInteractionUpdate(update, state, stream)) {
        const content = chunk?.choices[0]?.delta.content;
        if (content) contents.push(content);
      }
    }

    expect(contents).toEqual(["Checking.\n", "Done."]);
  });

  test("final-content mode emits one content chunk at turn-end", () => {
    const chunks = collectInterleavedTurn(finalContentPolicy);
    const contents = chunks
      .map((c) => c.choices[0]?.delta.content)
      .filter(Boolean);
    const reasoning = chunks
      .map((c) => c.choices[0]?.delta.reasoning_content)
      .filter(Boolean);

    expect(reasoning).toEqual(["think A", "think B"]);
    expect(contents).toEqual(["early textfinal text"]);
  });

  test("preamble-as-reasoning re-routes early text before later thinking", () => {
    const chunks = collectInterleavedTurn(preamblePolicy);
    const contents = chunks
      .map((c) => c.choices[0]?.delta.content)
      .filter(Boolean);
    const reasoning = chunks
      .map((c) => c.choices[0]?.delta.reasoning_content)
      .filter(Boolean);

    expect(reasoning).toEqual(["think A", "early text", "think B"]);
    expect(contents).toEqual(["final text"]);
  });

  test("emits buffered text as content at turn-end when only text in turn", () => {
    const state = createStreamState("composer-2");
    const stream = streamContext(finalContentPolicy);

    expect([
      ...chunksFromInteractionUpdate(
        { type: "text-delta", text: "Only response." },
        state,
        stream,
      ),
    ]).toHaveLength(0);

    const flushed = [
      ...chunksFromInteractionUpdate({ type: "turn-ended" }, state, stream),
    ];
    expect(flushed[0]?.choices[0]?.delta.content).toBe("Only response.");
  });

  test("final-content buffers text when only cursor tool-calls are enabled", () => {
    const state = createStreamState("composer-2");

    expect([
      ...chunksFromInteractionUpdate(
        { type: "text-delta", text: "Calling tool." },
        state,
        streamContext(withCursorTools),
      ),
    ]).toHaveLength(0);

    const tool = [
      ...chunksFromInteractionUpdate(
        {
          type: "tool-call-started",
          callId: "call-1",
          toolName: "search",
        } as never,
        state,
        streamContext(withCursorTools),
      ),
    ];
    expect(tool[0]?.choices[0]?.delta.tool_calls?.[0]?.function?.name).toBe(
      "search",
    );
    expect(state.pendingText).toBe("Calling tool.");

    const flushed = [
      ...chunksFromInteractionUpdate(
        { type: "turn-ended" },
        state,
        streamContext(withCursorTools),
      ),
    ];
    expect(flushed[0]?.choices[0]?.delta.content).toBe("Calling tool.");
  });

  test("client-tool turn respects preamble-as-reasoning for visible text", () => {
    const state = createStreamState("composer-2");
    const stream = clientToolPreambleStream;

    expect([
      ...chunksFromInteractionUpdate(
        { type: "text-delta", text: "I'll check.\n" },
        state,
        stream,
      ),
    ]).toHaveLength(0);
    expect(state.pendingText).toBe("I'll check.\n");

    const reasoning = [
      ...chunksFromInteractionUpdate(
        { type: "thinking-delta", text: "planning" },
        state,
        stream,
      ),
    ];
    expect(reasoning[0]?.choices[0]?.delta.reasoning_content).toBe(
      "I'll check.\n",
    );
    expect(reasoning[1]?.choices[0]?.delta.reasoning_content).toBe("planning");
  });

  test("passes assistant text through untouched on the client-tool path (no marker parsing)", () => {
    const state = createStreamState("composer-2");
    // Marker-like syntax must NOT be parsed any more — the bridge captures
    // native customTool invocations, and assistant text is streamed verbatim.
    const text = [
      "Checking.\n",
      "<|tool_calls_begin|><|tool_call_begin|>\n",
      "Glob\n",
      "<|tool_call_end|><|tool_calls_end|>",
    ].join("");

    const chunks = [
      ...chunksFromInteractionUpdate(
        { type: "text-delta", text },
        state,
        clientToolLiveStream,
      ),
    ];

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.choices[0]?.delta.content).toBe(text);
    expect(chunks[0]?.choices[0]?.delta.tool_calls).toBeUndefined();
    expect(state.toolCalls.size).toBe(0);
    expect(state.text).toBe(text);
  });

  test("suppresses SDK tool-call events on the client-tool path", () => {
    const state = createStreamState("composer-2");
    const chunks = [
      ...chunksFromInteractionUpdate(
        {
          type: "tool-call-started",
          callId: "call-1",
          toolName: "Read",
        } as never,
        state,
        clientToolEchoStream,
      ),
    ];
    expect(chunks).toHaveLength(0);
    expect(state.toolCalls.size).toBe(0);
  });

  // Tool lifecycle (start/result) is narrated ONLY on the run.stream() tool_call
  // path (stream.ts). The onDelta path must stay silent for those events even
  // when nativeProgress is on, so each event yields exactly one progress line.
  test("onDelta does not narrate tool-call lifecycle when nativeProgress is on", () => {
    const state = createStreamState("composer-2");
    const stream = streamContext(nativeProgressPolicy);

    const started = [
      ...chunksFromInteractionUpdate(
        { type: "tool-call-started", callId: "c1", toolName: "read" } as never,
        state,
        stream,
      ),
    ];
    const completed = [
      ...chunksFromInteractionUpdate(
        { type: "tool-call-completed" } as never,
        state,
        stream,
      ),
    ];
    expect(started).toHaveLength(0);
    expect(completed).toHaveLength(0);
    expect(state.reasoningText).toBe("");
    expect(state.toolCalls.size).toBe(0);
  });

  test("narrates incremental shell stdout when nativeProgress is on (thinking off)", () => {
    const state = createStreamState("composer-2");
    const chunks = [
      ...chunksFromInteractionUpdate(
        { type: "shell-output-delta", event: { stdout: "compiling...\n" } } as never,
        state,
        streamContext(nativeProgressPolicy),
      ),
    ];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.choices[0]?.delta.reasoning_content).toBe(
      "  compiling...\n",
    );
  });

  test("does not narrate shell stdout when nativeProgress is off", () => {
    const state = createStreamState("composer-2");
    const chunks = [
      ...chunksFromInteractionUpdate(
        { type: "shell-output-delta", event: { stdout: "compiling...\n" } } as never,
        state,
        streamContext(livePolicy),
      ),
    ];
    expect(chunks).toHaveLength(0);
    expect(state.reasoningText).toBe("");
  });
});
