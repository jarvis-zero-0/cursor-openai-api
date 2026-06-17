/**
 * Formats a native worker's tool activity (SDKToolUseMessage from run.stream())
 * into one-line `reasoning_content` progress markers (Option (b)). Used only by
 * stream.ts `chunksFromSdkMessage` when `policy.nativeProgress` is set. Lines
 * end with "\n" so consecutive markers render separately in the thinking
 * channel.
 *
 *   status "running"   → "→ {name}({args})"
 *   status "completed" → "✓ {name} → {result}"
 *   status "error"     → "✗ {name} → {result}"
 */

// Matches the SDKToolUseMessage fields the proxy narrates (see @cursor/sdk
// messages.d.ts). Kept structural so stream.ts can pass the message directly.
export interface ToolProgressInput {
  name: string;
  status: "running" | "completed" | "error";
  args?: unknown;
  result?: unknown;
  truncated?: { args?: boolean; result?: boolean };
}

const FIELD_MAX = 200;

function clamp(value: string, alreadyTruncated: boolean): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length > FIELD_MAX) return `${oneLine.slice(0, FIELD_MAX)}…`;
  return alreadyTruncated ? `${oneLine}…` : oneLine;
}

function pickScalar(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  const record = asRecord(args);
  if (record) {
    const primary = pickScalar(record, [
      "path",
      "command",
      "pattern",
      "globPattern",
      "query",
    ]);
    if (primary !== undefined) return primary;
  }
  return JSON.stringify(args);
}

function summarizeResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  const record = asRecord(result);
  if (record) {
    // SDK shape: { status: "success", value: {...} } | { status: "error", error }.
    const value = asRecord(record.value);
    if (value) {
      const primary = pickScalar(value, [
        "content",
        "stdout",
        "totalFiles",
        "linesCreated",
        "fileSize",
      ]);
      if (primary !== undefined) return primary;
    }
    if (record.error !== undefined) {
      return typeof record.error === "string"
        ? record.error
        : JSON.stringify(record.error);
    }
  }
  return JSON.stringify(result);
}

// Incremental shell stdout (the hypothetical SDK `shell-output-delta` update)
// would arrive while a `shell` tool is still running, between its "→ shell(cmd)"
// start line and the "✓ shell → …" completion line. Narrate each chunk as an
// indented progress line, reusing the same 200-char clamp. Distinct from the tool
// lifecycle events narrated in stream.ts, so no double-emit.
//
// NOTE (probed @cursor/sdk 1.0.13): no shell-output-delta is emitted today; full
// stdout lands in the tool_call completion result (`result.value.stdout`), which
// summarizeResult() already surfaces. This helper is forward-looking.
export function formatShellOutputProgressLine(
  chunk: string,
): string | undefined {
  const line = clamp(chunk, false);
  return line ? `  ${line}\n` : undefined;
}

export function formatToolProgressLine(
  message: ToolProgressInput,
): string | undefined {
  const name = message.name || "tool";
  if (message.status === "running") {
    const args = clamp(summarizeArgs(message.args), message.truncated?.args === true);
    return `→ ${name}(${args})\n`;
  }
  const mark = message.status === "error" ? "✗" : "✓";
  const result = clamp(
    summarizeResult(message.result),
    message.truncated?.result === true,
  );
  return result ? `${mark} ${name} → ${result}\n` : `${mark} ${name}\n`;
}
