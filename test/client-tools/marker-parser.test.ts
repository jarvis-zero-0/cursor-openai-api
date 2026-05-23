import { describe, expect, test } from "bun:test";
import {
  ClientToolMarkerFilter,
  parseComposerToolCalls,
} from "../../src/client-tools/marker-parser.js";

describe("parseComposerToolCalls", () => {
  test("parses sep-format tool calls", () => {
    const marker = [
      "<|tool_calls_begin|><|tool_call_begin|>",
      "Glob",
      "<|tool_sep|>targeting",
      "/Users/example/project/**",
      "<|tool_sep|>glob_pattern",
      "*",
      "<|tool_call_end|><|tool_calls_end|>",
    ].join("\n");
    expect(parseComposerToolCalls(marker)).toEqual([
      {
        name: "Glob",
        arguments: {
          targeting: "/Users/example/project/**",
          glob_pattern: "*",
        },
      },
    ]);
  });

  test("parses full-width markers", () => {
    expect(
      parseComposerToolCalls(
        "< | tool_calls_begin | >< | tool_call_begin | >\nRead< | tool_sep | >path\nREADME.md< | tool_call_end | >< | tool_calls_end | >",
      ),
    ).toEqual([{ name: "Read", arguments: { path: "README.md" } }]);
  });

  test("parses inline bracket arguments", () => {
    expect(
      parseComposerToolCalls(
        "<|tool_calls_begin|><|tool_call_begin|>\nGlob [targeting=/Users/example/project/**, glob_pattern=*]\n<|tool_call_end|><|tool_calls_end|>",
      ),
    ).toEqual([
      {
        name: "Glob",
        arguments: {
          targeting: "/Users/example/project/**",
          glob_pattern: "*",
        },
      },
    ]);
  });

  test("parses JSON tool-call bodies", () => {
    expect(
      parseComposerToolCalls(
        '<|tool_calls_begin|><|tool_call_begin|>{"name":"read","arguments":{"filePath":"README.md"}}<|tool_call_end|><|tool_calls_end|>',
      ),
    ).toEqual([{ name: "read", arguments: { filePath: "README.md" } }]);
  });
});

describe("ClientToolMarkerFilter", () => {
  test("streams text before tool markers incrementally", () => {
    const marker = [
      "Checking the workspace.\n",
      "<|tool_calls_begin|><|tool_call_begin|>\n",
      "Glob\n",
      "<|tool_sep|>glob_pattern\n",
      "*\n",
      "<|tool_call_end|><|tool_calls_end|>",
    ].join("");
    const filter = new ClientToolMarkerFilter();
    const first = filter.push(marker.slice(0, 45));
    const second = filter.push(marker.slice(45));
    const flushed = filter.flush();

    expect(first).toEqual([{ type: "text", text: "Checking the workspace.\n" }]);
    expect(second).toEqual([
      {
        type: "tool_call",
        toolCall: { name: "Glob", arguments: { glob_pattern: "*" } },
      },
    ]);
    expect(flushed).toEqual([]);
  });

  test("does not emit leading whitespace before split tool-call markers", () => {
    const filter = new ClientToolMarkerFilter();
    const part1 = "Visible\n<|tool_calls_begin|><|tool_call_begin|>\nRead<|tool_sep|>path\n";
    const part2 = "README.md<|tool_call_end|><|tool_calls_end|>";
    const events = [...filter.push(part1), ...filter.push(part2), ...filter.flush()];
    expect(events[0]).toEqual({ type: "text", text: "Visible\n" });
    expect(events[1]?.type).toBe("tool_call");
  });
});
