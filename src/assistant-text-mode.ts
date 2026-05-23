import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { ChatCompletionRequest } from "./openai.js";

export const ASSISTANT_TEXT_MODES = [
  "live",
  "final-content",
  "preamble-as-reasoning",
] as const;

export type AssistantTextMode = (typeof ASSISTANT_TEXT_MODES)[number];

export const DEFAULT_ASSISTANT_TEXT_MODE: AssistantTextMode = "live";

const assistantTextModeSchema = z.enum(ASSISTANT_TEXT_MODES);

export function parseAssistantTextMode(
  value: string | undefined,
): AssistantTextMode | undefined {
  if (value === undefined) return undefined;
  const parsed = assistantTextModeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function resolveAssistantTextMode(
  request: ChatCompletionRequest,
  config: AppConfig,
): AssistantTextMode {
  if (request.cursor_assistant_text_mode !== undefined) {
    return request.cursor_assistant_text_mode;
  }
  return config.CURSOR_ASSISTANT_TEXT_MODE ?? DEFAULT_ASSISTANT_TEXT_MODE;
}
