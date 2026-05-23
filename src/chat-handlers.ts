import { executeAgentTurn, type ChatChunkWriter } from "./agent-turn.js";
import { buildCompletionResponse } from "./completion-response.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "./openai.js";
import type { ProxyContext } from "./proxy-context.js";
import type { SessionRequestHeaders } from "./session-keys.js";

export interface ChatHandlerResult {
  body: ChatCompletionResponse;
  headers: Record<string, string>;
}

export async function runChatCompletion(
  proxy: ProxyContext,
  request: ChatCompletionRequest,
  headers?: SessionRequestHeaders,
  abortSignal?: AbortSignal,
): Promise<ChatHandlerResult> {
  const outcome = await executeAgentTurn({
    proxy,
    request,
    headers,
    abortSignal,
  });
  const body = buildCompletionResponse(
    outcome.state,
    outcome.meta.snapshot(),
    outcome.finalText,
  );
  return { body, headers: outcome.meta.headers() };
}

export async function streamChatCompletion(
  proxy: ProxyContext,
  request: ChatCompletionRequest,
  write: ChatChunkWriter,
  headers?: SessionRequestHeaders,
  abortSignal?: AbortSignal,
): Promise<{ headers: Record<string, string>; model: string }> {
  const outcome = await executeAgentTurn(
    { proxy, request, headers, abortSignal },
    { stream: { write } },
  );
  return {
    headers: outcome.meta.headers(),
    model: outcome.state.model,
  };
}
