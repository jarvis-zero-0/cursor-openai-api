import { isRecord } from "./guards.js";
import type { MarkerParserEvent, ParsedToolCall } from "./types.js";

const TOOL_CALLS_BEGIN = "<|tool_calls_begin|>";
const TOOL_CALLS_END = "<|tool_calls_end|>";
const TOOL_CALL_BEGIN = "<|tool_call_begin|>";
const TOOL_CALL_END = "<|tool_call_end|>";
const TOOL_SEP = "<|tool_sep|>";
const TOOL_MARKER_CANDIDATES = [
  TOOL_CALLS_BEGIN,
  TOOL_CALLS_END,
  TOOL_CALL_BEGIN,
  TOOL_CALL_END,
  TOOL_SEP,
].flatMap((marker) => [
  marker,
  marker.replaceAll("|", "｜").replaceAll("_", "▁"),
]);

function canonicalizeComposerToolMarkers(value: string): string {
  return value.replace(
    /<\s*[|｜]\s*(tool[_▁]calls[_▁]begin|tool[_▁]calls[_▁]end|tool[_▁]call[_▁]begin|tool[_▁]call[_▁]end|tool[_▁]sep)\s*[|｜]\s*>/g,
    (_match, marker: string) => `<|${marker.replaceAll("▁", "_")}|>`,
  );
}

export function findComposerToolMarker(
  value: string,
  marker: string,
): { index: number; length: number } | null {
  const markerPattern = marker.replaceAll("_", "[_▁]");
  const pattern = new RegExp(`<\\s*[|｜]\\s*${markerPattern}\\s*[|｜]\\s*>`);
  const match = pattern.exec(value);
  return match ? { index: match.index, length: match[0].length } : null;
}

function toolMarkerPrefixIndex(value: string): number {
  const max = Math.min(
    value.length,
    Math.max(...TOOL_MARKER_CANDIDATES.map((candidate) => candidate.length)),
  );
  for (let length = max; length >= 1; length -= 1) {
    const index = value.length - length;
    const suffix = value.slice(index);
    if (TOOL_MARKER_CANDIDATES.some((candidate) => candidate.startsWith(suffix))) {
      return index;
    }
  }
  return -1;
}

function extractToolCallsBody(normalized: string): string | null {
  const begin = findComposerToolMarker(normalized, "tool_calls_begin");
  if (!begin) return null;
  const afterBegin = normalized.slice(begin.index + begin.length);
  const end = findComposerToolMarker(afterBegin, "tool_calls_end");
  if (!end) return null;
  return afterBegin.slice(0, end.index);
}

function parseToolCallsFromBody(body: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  let searchFrom = 0;
  for (;;) {
    const slice = body.slice(searchFrom);
    const begin = findComposerToolMarker(slice, "tool_call_begin");
    if (!begin) break;
    const contentStart = begin.index + begin.length;
    const afterContentStart = slice.slice(contentStart);
    const end = findComposerToolMarker(afterContentStart, "tool_call_end");
    if (!end) break;
    const callBody = afterContentStart.slice(0, end.index);
    const call = parseComposerToolCallBody(callBody);
    if (call) calls.push(call);
    searchFrom += contentStart + end.index + end.length;
  }
  return calls;
}

export function parseComposerToolCalls(value: string): ParsedToolCall[] {
  const normalized = canonicalizeComposerToolMarkers(value);
  const body = extractToolCallsBody(normalized);
  if (body === null) return [];
  return parseToolCallsFromBody(body);
}

function parseComposerToolCallBody(value: string): ParsedToolCall | null {
  const trimmedBody = value.trim();
  const jsonBody = parseJsonToolCallBody(trimmedBody);
  if (jsonBody) return jsonBody;

  const parts = value.split(TOOL_SEP);
  const name = (parts.shift() || "").trim();
  if (!name) return null;

  if (!parts.length) {
    const inline = parseInlineToolCall(name);
    return inline ?? { name, arguments: {} };
  }

  const args: Record<string, unknown> = {};
  for (const part of parts) {
    const trimmed = part.replace(/^\s+/, "");
    if (!trimmed) continue;
    const match = /^([^\r\n]+)(?:\r?\n([\s\S]*))?$/.exec(trimmed);
    if (!match) continue;
    const key = match[1]?.trim();
    if (!key) continue;
    const rawValue = (match[2] || "").trim();
    args[key] = parseComposerToolArgument(rawValue);
  }

  return { name, arguments: args };
}

function parseJsonToolCallBody(value: string): ParsedToolCall | null {
  if (!value.startsWith("{") || !value.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || typeof parsed.name !== "string" || !parsed.name.trim()) {
      return null;
    }
    const rawArguments = parsed.arguments;
    let args: Record<string, unknown> = {};
    if (isRecord(rawArguments)) {
      args = rawArguments;
    } else if (typeof rawArguments === "string" && rawArguments.trim()) {
      const decoded = JSON.parse(rawArguments) as unknown;
      if (isRecord(decoded)) args = decoded;
    }
    return { name: parsed.name.trim(), arguments: args };
  } catch {
    return null;
  }
}

function parseInlineToolCall(value: string): ParsedToolCall | null {
  const match = /^([A-Za-z0-9_.-]+)\s*(?:\(([\s\S]*)\)|\[([\s\S]*)\])?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const name = match[1]?.trim();
  if (!name) return null;
  const rawArgs = (match[2] ?? match[3] ?? "").trim();
  const args = rawArgs ? parseInlineToolArguments(rawArgs) : {};
  return { name, arguments: args };
}

function parseInlineToolArguments(value: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const part of splitInlineArguments(value)) {
    const match = /^([A-Za-z0-9_.-]+)\s*[:=]\s*([\s\S]*)$/.exec(part.trim());
    if (!match || match[1] === undefined) continue;
    args[match[1]] = parseComposerToolArgument((match[2] ?? "").trim());
  }
  return args;
}

function splitInlineArguments(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote && value[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function parseComposerToolArgument(value: string): unknown {
  if (!value) return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

export class ClientToolMarkerFilter {
  private buffer = "";

  push(delta: string): MarkerParserEvent[] {
    this.buffer += delta;
    return this.drain(false);
  }

  flush(): MarkerParserEvent[] {
    return this.drain(true);
  }

  private drain(force: boolean): MarkerParserEvent[] {
    const events: MarkerParserEvent[] = [];
    for (;;) {
      const begin = findComposerToolMarker(this.buffer, "tool_calls_begin");
      if (!begin) {
        if (!this.buffer.trim()) {
          if (force) this.buffer = "";
          break;
        }
        const prefixIndex = force ? -1 : toolMarkerPrefixIndex(this.buffer);
        if (prefixIndex !== -1) {
          const visible = this.buffer.slice(0, prefixIndex);
          if (visible.trim()) events.push({ type: "text", text: visible });
          this.buffer = this.buffer.slice(prefixIndex);
          break;
        }
        const visible = this.buffer;
        if (visible) events.push({ type: "text", text: visible });
        this.buffer = "";
        break;
      }

      if (begin.index > 0) {
        const before = this.buffer.slice(0, begin.index);
        if (before.trim()) events.push({ type: "text", text: before });
        this.buffer = this.buffer.slice(begin.index);
        continue;
      }

      const end = findComposerToolMarker(
        this.buffer.slice(begin.length),
        "tool_calls_end",
      );
      if (!end) {
        if (force) {
          events.push({ type: "text", text: this.buffer });
          this.buffer = "";
        }
        break;
      }

      const blockEnd = begin.length + end.index + end.length;
      const block = this.buffer.slice(0, blockEnd);
      for (const toolCall of parseComposerToolCalls(block)) {
        events.push({ type: "tool_call", toolCall });
      }
      this.buffer = this.buffer.slice(blockEnd).replace(/^\s+/, "");
    }
    return events;
  }
}
