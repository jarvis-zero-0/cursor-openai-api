/** Normalizes @cursor/sdk interaction updates (snake/camel variants) for the proxy stream layer. */
import type { InteractionUpdate } from "@cursor/sdk";

export type NormalizedInteractionUpdate =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "thinking-completed"; thinkingDurationMs?: number }
  | { type: "tool-call-started"; callId: string; name: string; args?: string }
  | { type: "partial-tool-call"; callId: string; name: string; args: string }
  | { type: "tool-call-completed" }
  | { type: "shell-output-delta"; text: string }
  | { type: "ignored"; sourceType: string; reason: string };

function ignored(sourceType: string, reason: string): NormalizedInteractionUpdate {
  return { type: "ignored", sourceType, reason };
}

function readString(raw: object, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = Reflect.get(raw, key);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function readDurationMs(raw: object): number | undefined {
  const value =
    Reflect.get(raw, "thinkingDurationMs") ??
    Reflect.get(raw, "thinking_duration_ms") ??
    Reflect.get(raw, "durationMs") ??
    Reflect.get(raw, "duration_ms");
  return typeof value === "number" ? value : undefined;
}

// NOTE (probed @cursor/sdk 1.0.13, 2026-06-16): the SDK does NOT currently emit
// `shell-output-delta` at all — a 5s streaming `for…sleep` shell command produced
// only `tool-call-started`/`tool-call-completed`, with the full stdout delivered
// in the completion's `result.value.stdout` (narrated by stream.ts). This handler
// is therefore defensive/forward-looking: if a future SDK starts streaming live
// stdout, we want to surface it without a code change. Because the real shape is
// unobserved, keep the extractor structural — pull a stdout-ish string from the
// likely keys (top-level or nested under `value`) and ignore anything we cannot
// read as text — better silent than narrating raw JSON noise. Tighten to a typed
// shape only once a real event is captured.
function readShellOutputChunk(raw: object): string | undefined {
  const event = Reflect.get(raw, "event");
  const record =
    typeof event === "object" && event !== null
      ? (event as Record<string, unknown>)
      : (raw as Record<string, unknown>);
  const keys = ["stdout", "output", "text", "chunk", "data", "content"];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const nested = record["value"];
  if (typeof nested === "object" && nested !== null) {
    for (const key of keys) {
      const value = (nested as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

function readArgsFragment(raw: object): string | undefined {
  const value =
    Reflect.get(raw, "argsDelta") ??
    Reflect.get(raw, "args_delta") ??
    Reflect.get(raw, "argumentsDelta") ??
    Reflect.get(raw, "arguments") ??
    Reflect.get(raw, "args") ??
    Reflect.get(raw, "input");
  if (typeof value === "string") return value;
  if (value !== undefined) return JSON.stringify(value);
  return undefined;
}

export function normalizeInteractionUpdate(
  update: InteractionUpdate,
): NormalizedInteractionUpdate {
  const type = update.type;

  if (type === "text-delta") {
    const text = Reflect.get(update, "text");
    return { type, text: typeof text === "string" ? text : "" };
  }

  if (type === "thinking-delta") {
    const text = Reflect.get(update, "text");
    return { type, text: typeof text === "string" ? text : "" };
  }

  if (type === "thinking-completed") {
    return { type, thinkingDurationMs: readDurationMs(update) };
  }

  if (type === "tool-call-started") {
    const callId = readString(update, "callId", "call_id");
    const name = readString(update, "toolName", "tool_name", "name");
    if (!callId || !name) {
      return ignored(type, "tool-call-started requires callId and tool name");
    }
    const args = readArgsFragment(update);
    return args !== undefined
      ? { type, callId, name, args }
      : { type, callId, name };
  }

  if (type === "partial-tool-call") {
    const callId = readString(update, "callId", "call_id");
    const name = readString(update, "toolName", "tool_name", "name");
    const args = readArgsFragment(update);
    if (!callId || args === undefined) {
      return ignored(type, "partial-tool-call requires callId and arguments");
    }
    if (!name) {
      return { type: "partial-tool-call", callId, name: "", args };
    }
    return { type, callId, name, args };
  }

  if (type === "tool-call-completed") {
    return { type: "tool-call-completed" };
  }

  if (type === "shell-output-delta") {
    const text = readShellOutputChunk(update);
    return text !== undefined
      ? { type: "shell-output-delta", text }
      : ignored(type, "shell-output-delta had no readable stdout chunk");
  }

  return ignored(type, "unsupported interaction update type");
}
