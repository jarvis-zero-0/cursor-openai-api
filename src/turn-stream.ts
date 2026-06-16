import type { AppConfig } from "./config.js";
import {
  emitAssistantText,
  flushAssistantText,
} from "./assistant-output.js";
import type { ClientToolTextHandler } from "./client-tools/text-handler.js";
import { createClientToolTextHandler } from "./client-tools/text-handler.js";
import { parseClientTools } from "./client-tools/request.js";
import { filterClientTools } from "./client-tools/filter.js";
import type { ClientToolSpec } from "./client-tools/types.js";
import type { ChatCompletionChunk, ChatCompletionRequest } from "./openai.js";
import type { StreamState } from "./stream.js";
import { resolveTurnPolicy, type TurnPolicy } from "./turn-policy.js";

export interface AssistantTextStream {
  pushDelta(
    state: StreamState,
    policy: TurnPolicy,
    text: string,
  ): Generator<ChatCompletionChunk | null>;
  flushTurn(
    state: StreamState,
    policy: TurnPolicy,
  ): Generator<ChatCompletionChunk | null>;
}

export interface TurnStreamContext {
  policy: TurnPolicy;
  clientToolSpecs?: ClientToolSpec[];
  assistantText: AssistantTextStream;
}

export function defaultAssistantTextStream(): AssistantTextStream {
  return {
    *pushDelta(state, policy, text) {
      const chunk = emitAssistantText(state, policy, text);
      if (chunk) yield chunk;
    },
    *flushTurn(state, policy) {
      const chunk = flushAssistantText(state, policy);
      if (chunk) yield chunk;
    },
  };
}

function asAssistantTextStream(handler: ClientToolTextHandler): AssistantTextStream {
  return {
    pushDelta: handler.pushText,
    flushTurn: handler.flush,
  };
}

export function resolveTurnStreamContext(
  request: ChatCompletionRequest,
  config: AppConfig,
): TurnStreamContext {
  const policy = resolveTurnPolicy(request, config);
  if (!policy.clientToolLoop) {
    return {
      policy,
      assistantText: defaultAssistantTextStream(),
    };
  }

  const specs = filterClientTools(parseClientTools(request.tools), request, config);
  return {
    policy,
    clientToolSpecs: specs,
    assistantText: asAssistantTextStream(createClientToolTextHandler(specs)),
  };
}
