import { describe, expect, test } from "bun:test";
import {
  pruneEmptyToolArguments,
  toOpenAiToolCalls,
} from "../../src/client-tools/openai-map.js";

const delegateSpec = {
  name: "delegate_task",
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string" },
      context: { type: "string" },
      tasks: { type: "array" },
      toolsets: { type: "array", items: { type: "string" } },
    },
  },
};

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

  test("drops empty tasks string so delegate_task keeps goal", () => {
    const [call] = toOpenAiToolCalls({
      toolCalls: [
        {
          name: "delegate_task",
          arguments: { tasks: "", goal: "Fix the bug", context: "Repo path" },
        },
      ],
      tools: [delegateSpec],
      responseId: "chatcmpl_abc123",
    });
    expect(JSON.parse(call!.function.arguments)).toEqual({
      goal: "Fix the bug",
      context: "Repo path",
    });
  });
});

describe("pruneEmptyToolArguments", () => {
  test("removes null, undefined, and blank strings", () => {
    expect(
      pruneEmptyToolArguments({
        goal: "ok",
        context: "  ",
        tasks: "",
        model: null,
        toolsets: undefined,
      }),
    ).toEqual({ goal: "ok" });
  });
});
