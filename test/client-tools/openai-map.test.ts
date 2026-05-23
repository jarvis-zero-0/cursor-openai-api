import { describe, expect, test } from "bun:test";
import { toOpenAiToolCalls } from "../../src/client-tools/openai-map.js";

describe("toOpenAiToolCalls", () => {
  test("maps emitted Glob to client glob tool name", () => {
    const [call] = toOpenAiToolCalls({
      toolCalls: [{ name: "Glob", arguments: { glob_pattern: "*" } }],
      tools: [
        {
          name: "glob",
          parameters: {
            type: "object",
            properties: { glob_pattern: { type: "string" } },
          },
        },
      ],
      responseId: "chatcmpl_abc123",
      startIndex: 0,
    });
    expect(call?.function.name).toBe("glob");
    expect(JSON.parse(call!.function.arguments)).toEqual({ glob_pattern: "*" });
  });

  test("aliases path argument to filePath when schema expects filePath", () => {
    const [call] = toOpenAiToolCalls({
      toolCalls: [{ name: "Read", arguments: { path: "README.md" } }],
      tools: [
        {
          name: "read",
          parameters: {
            type: "object",
            properties: { filePath: { type: "string" } },
          },
        },
      ],
      responseId: "chatcmpl_abc123",
    });
    expect(call?.function.name).toBe("read");
    expect(JSON.parse(call!.function.arguments)).toEqual({
      filePath: "README.md",
    });
  });
});
