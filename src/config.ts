import { z } from "zod";
import {
  ASSISTANT_TEXT_MODES,
  DEFAULT_ASSISTANT_TEXT_MODE,
} from "./assistant-text-mode.js";
import {
  CURSOR_TOOL_MODES,
  DEFAULT_CURSOR_TOOL_MODE,
} from "./tool-mode.js";
import { TOOL_TIER_MODES } from "./client-tools/catalog.js";

const envSchema = z.object({
  CURSOR_API_KEY: z.string().min(1, "CURSOR_API_KEY is required"),
  CURSOR_CWD: z.string().min(1).default(process.cwd()),
  // Comma-separated absolute roots a per-request `cursor_cwd` override may point
  // at. Empty/unset = unrestricted (CURSOR_CWD is always implicitly allowed).
  // The Hermes workspace lives outside the proxy repo and holds secrets, so gate
  // any opt-in cwd override here rather than letting callers pick arbitrary paths.
  CURSOR_CWD_ALLOWLIST: z.string().optional(),
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
  CURSOR_TOOL_MODE: z
    .enum(CURSOR_TOOL_MODES)
    .optional()
    .default(DEFAULT_CURSOR_TOOL_MODE),
  CURSOR_ASSISTANT_TEXT_MODE: z
    .enum(ASSISTANT_TEXT_MODES)
    .optional()
    .default(DEFAULT_ASSISTANT_TEXT_MODE),
  // When false, /v1/models omits the synthetic `*-slow` / `*-fast` rows
  // (requests for those ids still resolve). Defaults to true.
  CURSOR_EMIT_SPEED_ALIASES: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  // Comma-separated catalog ids for GET /v1/models. Default: latest curated set.
  // Use "*" to expose the full Cursor catalog (no filter).
  CURSOR_MODEL_ALLOWLIST: z.string().optional(),
  // Default client-tool filtering (client-mode marker path). Each is a
  // comma-separated list; per-request fields/metadata override these.
  // Reduces the injected tool inventory so unused schemas never cost tokens.
  CURSOR_ENABLED_TOOLSETS: z.string().optional(),
  CURSOR_TOOL_ALLOWLIST: z.string().optional(),
  CURSOR_TOOL_DENYLIST: z.string().optional(),
  // When toolset filtering is active, keep tools with no known toolset.
  // Defaults to true (fail open) so a stale map never strips a needed tool.
  CURSOR_TOOLSETS_KEEP_UNMAPPED: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true" || v === "1")),
  // Progressive disclosure of the client-mode inventory. `full` (default) keeps
  // every schema; `tiered` gives resident tools full schemas and the rest brief
  // signatures; `brief` renders all tools as signatures. Per-request override:
  // cursor_tool_tier.
  CURSOR_TOOL_TIER: z.enum(TOOL_TIER_MODES).optional(),
  // Comma-separated tool names kept resident (full schema) in `tiered` mode.
  CURSOR_TOOL_RESIDENT: z.string().optional(),
  // Optional path to append a JSONL record of every client tool call (Phase 3
  // usage telemetry for tuning resident vs brief tiers).
  CURSOR_TOOL_USAGE_LOG: z.string().optional(),
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
