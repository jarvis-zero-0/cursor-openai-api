import type { ChatCompletionResponse, OpenAIUsage } from "../openai.js";
import { normalizeResponseMetadata } from "../metadata.js";
import type {
  ResponseObject,
  ResponsesRequest,
  ResponsesUsage,
} from "./schema.js";
import { makeResponseId } from "./schema.js";
import { assembleOutputItemsFromChoice } from "./output-accumulator.js";

export function mapOpenAIUsageToResponsesUsage(
  usage?: OpenAIUsage,
): ResponsesUsage | null {
  if (!usage) return null;
  const result: ResponsesUsage = {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  };
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (cached != null && cached > 0) {
    result.input_tokens_details = { cached_tokens: cached };
  }
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (reasoning != null && reasoning > 0) {
    result.output_tokens_details = { reasoning_tokens: reasoning };
  }
  return result;
}

export function buildResponseShellFromRequest(
  request: ResponsesRequest,
  model: string,
  status: ResponseObject["status"] = "in_progress",
): ResponseObject {
  return {
    id: makeResponseId(),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: [],
    instructions: request.instructions ?? null,
    error: null,
    incomplete_details: null,
    max_output_tokens: request.max_output_tokens ?? null,
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    previous_response_id: null,
    reasoning: {
      effort: request.reasoning?.effort ?? null,
      summary: request.reasoning?.summary ?? null,
    },
    store: request.store ?? true,
    temperature: request.temperature ?? null,
    text: { format: { type: "text" } },
    tool_choice: request.tool_choice ?? "auto",
    tools: request.tools ?? [],
    top_p: request.top_p ?? null,
    truncation: request.truncation ?? "disabled",
    usage: null,
    user: request.user ?? null,
    metadata: normalizeResponseMetadata(request.metadata),
  };
}

export function chatCompletionToResponse(
  completion: ChatCompletionResponse,
  request: ResponsesRequest,
): ResponseObject {
  const choice = completion.choices[0];
  if (!choice) {
    throw new Error("Chat completion has no choices");
  }
  const shell = buildResponseShellFromRequest(request, completion.model, "completed");
  shell.id = makeResponseId();
  shell.created_at = completion.created;
  shell.output = assembleOutputItemsFromChoice(choice.message);
  shell.usage = mapOpenAIUsageToResponsesUsage(completion.usage);
  return shell;
}
