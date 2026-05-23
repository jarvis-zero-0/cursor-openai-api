export interface ClientToolSpec {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type MarkerParserEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCall: ParsedToolCall };
