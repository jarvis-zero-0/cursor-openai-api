import { z } from "zod";
import {
  ASSISTANT_TEXT_MODES,
  DEFAULT_ASSISTANT_TEXT_MODE,
} from "./assistant-text-mode.js";

const envSchema = z.object({
  CURSOR_API_KEY: z.string().min(1, "CURSOR_API_KEY is required"),
  CURSOR_CWD: z.string().min(1).default(process.cwd()),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default("0.0.0.0"),
  DEFAULT_MODEL: z.string().default("composer-2.5"),
  AUTH_KEY: z.string().optional(),
  DEBUG_STREAM: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v === "true" || v === "1"),
  CURSOR_INCLUDE_THINKING: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  // Cursor runs its own tools locally; keep them hidden unless explicitly requested.
  CURSOR_EMIT_TOOL_CALLS: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v === "true" || v === "1"),
  CURSOR_ASSISTANT_TEXT_MODE: z
    .enum(ASSISTANT_TEXT_MODES)
    .optional()
    .default(DEFAULT_ASSISTANT_TEXT_MODE),
  CURSOR_ENABLE_SESSIONS: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  CURSOR_AUTO_SESSION: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  CURSOR_SESSION_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
  CURSOR_SESSION_MAX: z.coerce.number().int().positive().default(64),
  // Stream stall hardening. The proxy otherwise has no TTFB/idle bound, so a slow
  // upstream prefill surfaces to the consumer as an indefinite silent hang.
  // TTFB: max wait from `agent.send` to the first emitted delta before the run is
  // cancelled and a 504 is returned. Default 15min — a legitimate large-context
  // Opus prefill can run ~10min before it emits its first chunk, and these
  // timeouts (not the best-effort heartbeat) are the real protection.
  CURSOR_STREAM_TTFB_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(900000),
  // Idle: max gap between emitted deltas mid-stream before the run is cancelled.
  // Default 5min to tolerate multi-minute mid-stream Opus thinking pauses.
  CURSOR_STREAM_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(300000),
  // Heartbeat: SSE comment ping cadence while awaiting the first delta, so the
  // consumer sees liveness during a slow prefill. Best-effort only (see
  // startSseHeartbeat); `0` disables it, hence nonnegative rather than positive.
  CURSOR_STREAM_HEARTBEAT_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(15000),
  // Client-tool schema tiering (provider-neutral, env-only — no request fields).
  // `tiered` (default) keeps high-frequency resident tools' full schemas and
  // renders the long tail as compact signatures to cut the customTools channel's
  // token cost. See src/client-tools/catalog.ts.
  CURSOR_TOOL_TIER: z.enum(["full", "tiered", "brief"]).optional(),
  // Comma-separated tool names kept resident (full schema) in `tiered` mode.
  // Opt-in only: when unset, no tool is resident and `tiered` mode renders
  // every tool as a compact signature.
  CURSOR_TOOL_RESIDENT: z.string().optional(),
  // Comma-separated absolute paths a native worker leaf's `cursor_cwd` may
  // resolve under. Lets a delegated leaf run with its repo's cwd (so the SDK's
  // `project` setting source loads that repo's .cursor/rules + AGENTS.md) while
  // keeping cwd selection bounded. Unset → [] (no cwd override is ever honored).
  CURSOR_CWD_ALLOWLIST: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
});

export type AppConfig = z.infer<typeof envSchema>;

const CURSOR_API_KEY_DOCS_URL =
  "https://cursor.com/dashboard/integrations";

function formatConfigError(
  env: NodeJS.ProcessEnv,
  issues: z.core.$ZodIssue[],
): string {
  const apiKey = env.CURSOR_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return [
      "CURSOR_API_KEY is not set.",
      "",
      "Create a key in Cursor Dashboard → Integrations:",
      `  ${CURSOR_API_KEY_DOCS_URL}`,
      "",
      "Then export it before starting the server:",
      '  export CURSOR_API_KEY="cursor_..."',
      "  bun run start",
    ].join("\n");
  }

  const details = issues
    .map((issue) => {
      const field = issue.path.join(".") || "configuration";
      return `  ${field}: ${issue.message}`;
    })
    .join("\n");

  return ["Invalid configuration:", details].join("\n");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(formatConfigError(env, parsed.error.issues));
  }
  return parsed.data;
}
