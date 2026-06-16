import { appendFileSync } from "node:fs";

/**
 * Phase 3 telemetry: record which client tools actually get called so the
 * resident vs brief tiers (catalog.ts) can be tuned from real usage instead of
 * guesses. In-memory counts are always kept (cheap); set CURSOR_TOOL_USAGE_LOG
 * to also append a JSONL audit trail. Telemetry must never break a turn.
 */

const counts = new Map<string, number>();

export function recordToolUsage(name: string): void {
  if (!name) return;
  counts.set(name, (counts.get(name) ?? 0) + 1);

  const logPath = process.env.CURSOR_TOOL_USAGE_LOG;
  if (!logPath) return;
  try {
    appendFileSync(
      logPath,
      `${JSON.stringify({ ts: new Date().toISOString(), tool: name })}\n`,
    );
  } catch {
    // Swallow telemetry errors — a bad log path must not fail the request.
  }
}

/** Tool call counts, highest first. */
export function getToolUsage(): Record<string, number> {
  return Object.fromEntries(
    [...counts.entries()].sort((a, b) => b[1] - a[1]),
  );
}

export function resetToolUsage(): void {
  counts.clear();
}
