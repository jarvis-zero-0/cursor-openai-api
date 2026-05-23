import { ProxyError } from "../errors.js";
import type { ChatCompletionRequest } from "../openai.js";
import { isRecord } from "./guards.js";
import type { ClientToolSpec } from "./types.js";

export type ParsedToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; functionName: string };

export function parseToolChoice(toolChoice: unknown): ParsedToolChoice | undefined {
  if (toolChoice === undefined || toolChoice === null) return undefined;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }
  if (
    isRecord(toolChoice) &&
    toolChoice.type === "function" &&
    isRecord(toolChoice.function) &&
    typeof toolChoice.function.name === "string"
  ) {
    return { type: "function", functionName: toolChoice.function.name };
  }
  return undefined;
}

export function isClientToolLoop(request: ChatCompletionRequest): boolean {
  if (request.tool_choice === "none") return false;
  const tools = request.tools;
  return Array.isArray(tools) && tools.length > 0;
}

export function parseClientTools(tools: unknown): ClientToolSpec[] {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) {
    throw new ProxyError(
      "tools must be an array",
      400,
      "invalid_request_error",
      "tools",
    );
  }
  return tools.map((tool, index) => {
    if (!isRecord(tool)) {
      throw new ProxyError(
        `tools[${index}] must be an object`,
        400,
        "invalid_request_error",
        `tools[${index}]`,
      );
    }
    if (tool.type !== "function") {
      throw new ProxyError(
        "Only function tools are supported",
        400,
        "invalid_request_error",
        `tools[${index}].type`,
      );
    }
    const fn = tool.function;
    if (!isRecord(fn)) {
      throw new ProxyError(
        `tools[${index}].function must be an object`,
        400,
        "invalid_request_error",
        `tools[${index}].function`,
      );
    }
    if (typeof fn.name !== "string" || !fn.name.trim()) {
      throw new ProxyError(
        "Tool function name is required",
        400,
        "invalid_request_error",
        `tools[${index}].function.name`,
      );
    }
    return {
      name: fn.name.trim(),
      ...(typeof fn.description === "string"
        ? { description: fn.description }
        : {}),
      ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
    };
  });
}
