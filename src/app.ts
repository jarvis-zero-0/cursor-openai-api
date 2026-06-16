import { Hono } from "hono";
import type { AppConfig } from "./config.js";
import { mapCursorError } from "./errors.js";
import { listModels } from "./models.js";
import { runChatCompletion, streamChatCompletion } from "./chat-handlers.js";
import { runResponse, streamResponse } from "./responses-handlers.js";
import { proxyErrorResponse } from "./http-utils.js";
import { chatCompletionRequestSchema, openAIError } from "./openai.js";
import { registerOpenAIEndpoint } from "./openai-endpoint.js";
import { createProxyContext } from "./proxy-context.js";
import { responsesRequestSchema, type ResponsesStreamWrite } from "./responses.js";

export function createApp(config: AppConfig): Hono {
  const proxy = createProxyContext(config);
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") {
      await next();
      return;
    }
    if (config.AUTH_KEY) {
      const auth = c.req.header("Authorization");
      const expected = `Bearer ${config.AUTH_KEY}`;
      if (auth !== expected) {
        return openAIError("Invalid API key", "invalid_api_key", 401);
      }
    }
    await next();
  });

  app.get("/health", (c) =>
    c.json({ status: "ok", runtime: "cursor-openai-api" }),
  );

  app.get("/v1/sessions", (c) => {
    if (!config.CURSOR_ENABLE_SESSIONS) {
      return c.json({
        object: "list",
        data: [],
        sessions_enabled: false,
      });
    }
    return c.json({
      object: "list",
      data: proxy.sessions.listActiveSessions(),
      sessions_enabled: true,
    });
  });

  app.get("/v1/models", async (c) => {
    try {
      const models = await listModels(
        config.CURSOR_API_KEY,
        config.CURSOR_EMIT_SPEED_ALIASES,
        config.CURSOR_MODEL_ALLOWLIST,
      );
      return c.json(models);
    } catch (err) {
      return proxyErrorResponse(mapCursorError(err));
    }
  });

  registerOpenAIEndpoint(app, proxy, {
    path: "/v1/responses",
    schema: responsesRequestSchema,
    run: async ({ proxy, request, sessionHeaders, abortSignal }) =>
      runResponse(proxy, request, sessionHeaders, abortSignal),
    stream: async ({ proxy, request, sessionHeaders, abortSignal }, { stream, setHeaders }) => {
      const cursorHeaders = await streamResponse(
        proxy,
        request,
        (async (event, data) => {
          await stream.writeSSE({
            event,
            data: JSON.stringify(data),
          });
        }) satisfies ResponsesStreamWrite,
        sessionHeaders,
        abortSignal,
      );
      setHeaders(cursorHeaders);
    },
  });

  registerOpenAIEndpoint(app, proxy, {
    path: "/v1/chat/completions",
    schema: chatCompletionRequestSchema,
    run: async ({ proxy, request, sessionHeaders, abortSignal }) =>
      runChatCompletion(proxy, request, sessionHeaders, abortSignal),
    stream: async ({ proxy, request, sessionHeaders, abortSignal }, { stream, setHeaders }) => {
      const { headers: cursorHeaders } = await streamChatCompletion(
        proxy,
        request,
        async (chunk, chunkHeaders) => {
          setHeaders(chunkHeaders);
          if (chunk === "[DONE]") {
            await stream.writeSSE({ data: "[DONE]" });
            return;
          }
          await stream.writeSSE({ data: JSON.stringify(chunk) });
        },
        sessionHeaders,
        abortSignal,
      );
      setHeaders(cursorHeaders);
    },
  });

  app.notFound(() =>
    openAIError("Not found", "invalid_request_error", 404),
  );

  return app;
}
