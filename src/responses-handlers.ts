import {
  ResponsesStreamTranslator,
  chatCompletionToResponse,
  responsesToChatRequest,
  type ResponseObject,
  type ResponsesRequest,
  type ResponsesStreamWrite,
} from "./responses.js";
import { streamChatCompletion, runChatCompletion } from "./chat-handlers.js";
import type { OpenAIUsage } from "./openai.js";
import type { ProxyContext } from "./proxy-context.js";
import type { SessionRequestHeaders } from "./session-keys.js";

export async function runResponse(
  proxy: ProxyContext,
  request: ResponsesRequest,
  headers?: SessionRequestHeaders,
  abortSignal?: AbortSignal,
): Promise<{ body: ResponseObject; headers: Record<string, string> }> {
  const chatRequest = responsesToChatRequest(request);
  const { body, headers: cursorHeaders } = await runChatCompletion(
    proxy,
    chatRequest,
    headers,
    abortSignal,
  );
  return {
    body: chatCompletionToResponse(body, request),
    headers: cursorHeaders,
  };
}

export async function streamResponse(
  proxy: ProxyContext,
  request: ResponsesRequest,
  writeEvent: ResponsesStreamWrite,
  headers?: SessionRequestHeaders,
  abortSignal?: AbortSignal,
): Promise<Record<string, string>> {
  const chatRequest = responsesToChatRequest(request);
  const model = chatRequest.model ?? proxy.config.DEFAULT_MODEL;
  const translator = new ResponsesStreamTranslator(
    request,
    model,
    writeEvent,
  );
  await translator.emitLifecycleStart();

  let usage: OpenAIUsage | undefined;

  const { headers: responseHeaders } = await streamChatCompletion(
    proxy,
    chatRequest,
    async (chunk, chunkHeaders) => {
      if (chunk === "[DONE]") return;
      if (chunk.model) {
        translator.response.model = chunk.model;
      }
      if (chunk.usage) usage = chunk.usage;
      await translator.handleChatChunk(chunk);
    },
    headers,
    abortSignal,
  );

  await translator.finish(usage);
  return responseHeaders;
}
