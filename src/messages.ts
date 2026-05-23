import type { SDKUserMessage } from "@cursor/sdk";
import {
  contentHasImages,
  contentToText,
  extractImagesFromContent,
} from "./content-parts.js";
import {
  CHAT_COMPLETION_REQUEST_KEYS,
  type ChatCompletionRequest,
  type ChatMessage,
} from "./openai.js";
import type { ClientToolSpec } from "./client-tools/types.js";
import { serializeMessagesToPrompt } from "./prompt.js";

export interface PromptExtras {
  tools?: ChatCompletionRequest["tools"];
  toolChoice?: ChatCompletionRequest["tool_choice"];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string | string[];
  seed?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  verbosity?: string;
  responseFormat?: unknown;
  passthrough?: Record<string, unknown>;
}

export function promptExtrasFromRequest(
  request: ChatCompletionRequest,
): PromptExtras {
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (!CHAT_COMPLETION_REQUEST_KEYS.has(key)) {
      passthrough[key] = value;
    }
  }
  return {
    tools: request.tools,
    toolChoice: request.tool_choice,
    temperature: request.temperature,
    topP: request.top_p,
    maxTokens: request.max_tokens,
    stop: request.stop,
    seed: request.seed,
    frequencyPenalty: request.frequency_penalty,
    presencePenalty: request.presence_penalty,
    verbosity: request.verbosity,
    responseFormat: request.response_format,
    ...(Object.keys(passthrough).length > 0 ? { passthrough } : {}),
  };
}

export { extractImagesFromContent } from "./content-parts.js";

type SendPayloadKind = "client-tools" | "sdk-user-message" | "plain-text" | "full-prompt";

function classifySendPayload(
  messages: ChatMessage[],
  extras?: PromptExtras,
  clientToolSpecs?: ClientToolSpec[],
): SendPayloadKind {
  if (clientToolSpecs?.length) return "client-tools";
  const userOnly =
    messages.length > 0 && messages.every((m) => m.role === "user");
  if (!userOnly || extras?.tools?.length) return "full-prompt";
  if (messages.length === 1) {
    const images = extractImagesFromContent(messages[0]!.content);
    if (images.length > 0) return "sdk-user-message";
    return "plain-text";
  }
  if (messages.every((m) => !contentHasImages(m.content))) return "plain-text";
  return "full-prompt";
}

export function buildSendPayload(
  messages: ChatMessage[],
  extras?: PromptExtras,
  clientToolSpecs?: ClientToolSpec[],
): string | SDKUserMessage {
  switch (classifySendPayload(messages, extras, clientToolSpecs)) {
    case "client-tools":
      return serializeMessagesToPrompt(messages, extras, clientToolSpecs);
    case "sdk-user-message": {
      const message = messages[0]!;
      const text = contentToText(message.content).trim();
      const images = extractImagesFromContent(message.content);
      return { text: text || "See attached image(s).", images };
    }
    case "plain-text":
      return messages
        .map((m) => contentToText(m.content))
        .filter(Boolean)
        .join("\n\n");
    case "full-prompt":
      return serializeMessagesToPrompt(messages, extras);
  }
}
