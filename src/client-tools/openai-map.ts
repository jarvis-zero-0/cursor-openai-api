import { normalizeToolArguments } from "../tool-args.js";
import { isRecord } from "./guards.js";
import type { ClientToolSpec, ParsedToolCall } from "./types.js";

export interface OpenAiToolCallOut {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

function normalizeToolName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function resolveToolSpec(
  emittedName: string,
  tools: ClientToolSpec[],
): ClientToolSpec | undefined {
  const exact = tools.find((tool) => tool.name === emittedName);
  if (exact) return exact;
  const normalized = normalizeToolName(emittedName);
  return tools.find((tool) => normalizeToolName(tool.name) === normalized);
}

function toolParameterProperties(tool: ClientToolSpec | undefined): string[] {
  const parameters = isRecord(tool?.parameters) ? tool.parameters : undefined;
  const properties = isRecord(parameters?.properties)
    ? parameters.properties
    : undefined;
  return properties ? Object.keys(properties) : [];
}

function aliasToolArgument(
  key: string,
  properties: string[],
): string | undefined {
  const normalized = normalizeToolName(key);
  const aliases: Record<string, string[]> = {
    globpattern: ["pattern"],
    targeting: ["path", "directory", "cwd"],
    targetdirectory: ["path", "directory", "cwd"],
    filepath: ["filePath", "path"],
    targetfile: ["filePath", "path"],
    absolutepath: ["filePath", "path"],
    path: ["filePath", "path"],
    commandline: ["command"],
    cmd: ["command"],
    newcontents: ["content", "newString"],
    contents: ["content"],
  };
  const candidates = aliases[normalized] ?? [];
  return candidates.find((candidate) => properties.includes(candidate));
}

/** Drop null/undefined and whitespace-only strings from tool args. */
export function pruneEmptyToolArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && !value.trim()) continue;
    output[key] = value;
  }
  return output;
}

export function normalizeToolArgumentsForSchema(
  args: Record<string, unknown>,
  tool: ClientToolSpec | undefined,
): Record<string, unknown> {
  const properties = toolParameterProperties(tool);
  if (!properties.length) return args;

  const normalizedProperties = new Map(
    properties.map((property) => [normalizeToolName(property), property]),
  );
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const target = properties.includes(key)
      ? key
      : normalizedProperties.get(normalizeToolName(key)) ||
        aliasToolArgument(key, properties);
    output[target || key] = value;
  }
  return output;
}

export function toOpenAiToolCalls(input: {
  toolCalls: ParsedToolCall[];
  tools: ClientToolSpec[];
  responseId: string;
  startIndex?: number;
}): OpenAiToolCallOut[] {
  return input.toolCalls.map((toolCall, offset) => {
    const index = (input.startIndex ?? 0) + offset;
    const tool = resolveToolSpec(toolCall.name, input.tools);
    const name = tool?.name ?? toolCall.name;
    const toolArguments = pruneEmptyToolArguments(
      normalizeToolArgumentsForSchema(toolCall.arguments ?? {}, tool),
    );
    const argsJson = normalizeToolArguments(JSON.stringify(toolArguments));
    const idSuffix = input.responseId.replace(/[^A-Za-z0-9]/g, "").slice(-18);
    return {
      id: `call_${idSuffix}_${index}`,
      type: "function",
      function: {
        name,
        arguments: argsJson,
      },
    };
  });
}
