export interface ClientToolSpec {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

// Subagent handoff contract types — re-exported here so callers have a single
// import site alongside ClientToolSpec / ParsedToolCall.
export type {
  Handoff,
  HandoffArtifact,
  HandoffUnresolved,
  HandoffRecommendation,
  HandoffMetrics,
  HandoffVerify,
  HandoffStatus,
  HandoffArtifactKind,
  HandoffVerifyMethod,
  HandoffSeverity,
  HandoffToolMode,
  HandoffParseResult,
} from "./handoff.js";
