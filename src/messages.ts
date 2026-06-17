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
import type { ToolTierPolicy } from "./client-tools/catalog.js";
import { serializeMessagesToPrompt, buildNativeToolDirective } from "./prompt.js";
import type { NativeToolContext } from "./prompt.js";
import { NATIVE_CLIENT_TOOL_STEER } from "./client-tools/prompt.js";
import type { CursorToolMode } from "./tool-mode.js";

export interface PromptExtras {
  tools?: ChatCompletionRequest["tools"];
  toolChoice?: ChatCompletionRequest["tool_choice"];
  toolTier?: ToolTierPolicy;
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

// serializeMessagesToPrompt prepends this generic proxy framing line on its
// full-prompt path. The native client-tool path wants the leanest possible
// system framing — only Hermes's WHO/WHAT (which already arrives in the upstream
// messages) plus the minimal NATIVE_CLIENT_TOOL_STEER — so this line is stripped
// from THAT path only. It is contradictory noise against Composer's baked-in
// Cursor identity ("you are an OpenAI-compatible API proxy" vs. the model's
// native Cursor self) and duplicates nothing Hermes needs. The plain / native /
// full-prompt paths keep it untouched. The literal is mirrored here
// intentionally; the dedicated native client-tool test asserts the framing is
// absent, so if the upstream wording drifts the strip becomes a no-op and the
// test fails loudly rather than regressing silently.
const GENERIC_PROXY_FRAMING_LINE =
  "You are responding through an OpenAI-compatible API proxy. Follow the conversation below.";

function stripGenericProxyFraming(body: string): string {
  if (body.startsWith(`${GENERIC_PROXY_FRAMING_LINE}\n\n`)) {
    return body.slice(GENERIC_PROXY_FRAMING_LINE.length + 2);
  }
  if (body.startsWith(`${GENERIC_PROXY_FRAMING_LINE}\n`)) {
    return body.slice(GENERIC_PROXY_FRAMING_LINE.length + 1);
  }
  if (body === GENERIC_PROXY_FRAMING_LINE) return "";
  return body;
}

type SendPayloadKind = "sdk-user-message" | "plain-text" | "full-prompt";

function classifySendPayload(
  messages: ChatMessage[],
  extras?: PromptExtras,
): SendPayloadKind {
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
  toolMode?: CursorToolMode,
  nativeCtx?: NativeToolContext,
): string | SDKUserMessage {
  if (clientToolSpecs?.length) {
    // Client tools are registered as native SDK customTools out-of-band, so the
    // prompt must NOT inject any tool-schema dump. Strip `tools` / `tool_choice`
    // from the prompt extras so the `## CLIENT_TOOLS` JSON dump and tool_choice
    // line are not emitted — those tools live in the customTools registration.
    // toolMode is left undefined so the native SDK directive is not injected
    // either. Hermes upstream content is serialized as-is with the generic
    // "OpenAI-compatible API proxy" framing stripped (it fights Composer's
    // native Cursor identity); a minimal built-in containment steer is prepended.
    const extrasNoTools: PromptExtras | undefined = extras
      ? { ...extras, tools: undefined, toolChoice: undefined }
      : extras;
    const body = stripGenericProxyFraming(
      serializeMessagesToPrompt(messages, extrasNoTools, undefined, undefined),
    );
    return [NATIVE_CLIENT_TOOL_STEER, body].filter(Boolean).join("\n\n");
  }
  switch (classifySendPayload(messages, extras)) {
    case "sdk-user-message": {
      const message = messages[0]!;
      const text = contentToText(message.content).trim();
      const images = extractImagesFromContent(message.content);
      return { text: text || "See attached image(s).", images };
    }
    case "plain-text":
      if (toolMode === "native" && messages.length === 1) {
        const text = contentToText(messages[0]!.content).trim();
        return [buildNativeToolDirective(nativeCtx), text].filter(Boolean).join("\n\n");
      }
      return messages
        .map((m) => contentToText(m.content))
        .filter(Boolean)
        .join("\n\n");
    case "full-prompt":
      return serializeMessagesToPrompt(messages, extras, toolMode, nativeCtx);
  }
}
