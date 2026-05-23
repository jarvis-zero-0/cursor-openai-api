import type { ChatCompletionChunk, OpenAIUsage } from "../openai.js";
import { mapOpenAIUsageToResponsesUsage } from "./output-builder.js";
import { emptyOutputTextPart } from "./output-items.js";
import { ResponseOutputAccumulator } from "./output-accumulator.js";
import type { ResponseObject, ResponsesRequest } from "./schema.js";
import { buildResponseShellFromRequest } from "./output-builder.js";
import { makeResponseId } from "./schema.js";

export type ResponsesStreamWrite = (
  event: string,
  data: Record<string, unknown>,
) => Promise<void>;

export class ResponsesStreamTranslator {
  readonly response: ResponseObject;
  private readonly write: ResponsesStreamWrite;
  private readonly output = new ResponseOutputAccumulator();
  private seq = 0;
  private started = false;
  private contentPartStarted = false;

  constructor(
    request: ResponsesRequest,
    model: string,
    write: ResponsesStreamWrite,
    responseId = makeResponseId(),
  ) {
    this.write = write;
    this.response = buildResponseShellFromRequest(request, model);
    this.response.id = responseId;
  }

  get messageItemId(): string {
    return this.output.messageItemId;
  }

  get reasoningItemId(): string {
    return this.output.reasoningItemId;
  }

  private nextSeq(): number {
    return ++this.seq;
  }

  private async emit(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.write(type, { type, sequence_number: this.nextSeq(), ...payload });
  }

  async emitLifecycleStart(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.emit("response.created", { response: { ...this.response } });
    await this.emit("response.in_progress", { response: { ...this.response } });
  }

  private async ensureReasoningItem(): Promise<void> {
    const reasoning = this.output.ensureReasoningItem();
    if (!reasoning.created) return;
    await this.emit("response.output_item.added", {
      output_index: reasoning.outputIndex,
      item: reasoning.item,
    });
  }

  private async ensureMessageItem(): Promise<void> {
    const message = this.output.ensureMessageItem();
    if (!message.created) return;
    await this.emit("response.output_item.added", {
      output_index: message.outputIndex,
      item: message.item,
    });
    await this.emit("response.content_part.added", {
      item_id: this.output.messageItemId,
      output_index: message.outputIndex,
      content_index: 0,
      part: emptyOutputTextPart(),
    });
    this.contentPartStarted = true;
  }

  async handleChatChunk(chunk: ChatCompletionChunk): Promise<void> {
    await this.emitLifecycleStart();
    const delta = chunk.choices[0]?.delta;
    if (!delta) return;

    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) {
      await this.ensureReasoningItem();
      this.output.appendReasoning(reasoning);
      await this.emit("response.reasoning_summary_text.delta", {
        item_id: this.output.reasoningItemId,
        output_index: this.output.reasoningIndex,
        delta: reasoning,
      });
    }

    if (delta.content) {
      await this.ensureMessageItem();
      this.output.appendText(delta.content);
      await this.emit("response.output_text.delta", {
        item_id: this.output.messageItemId,
        output_index: this.output.messageIndex,
        content_index: 0,
        delta: delta.content,
      });
    }

    if (delta.tool_calls?.length) {
      for (const tc of delta.tool_calls) {
        await this.handleToolCallDelta(tc);
      }
    }
  }

  private async handleToolCallDelta(
    tc: NonNullable<ChatCompletionChunk["choices"][0]["delta"]["tool_calls"]>[0],
  ): Promise<void> {
    const update = this.output.applyToolCallDelta(tc);
    if (!update) return;

    if (update.added) {
      await this.emit("response.output_item.added", {
        output_index: update.added.outputIndex,
        item: update.added.item,
      });
    }

    if (update.argsDelta) {
      await this.emit("response.function_call_arguments.delta", {
        item_id: update.itemId,
        output_index: update.outputIndex,
        call_id: update.callId,
        delta: update.argsDelta,
      });
    }
  }

  async finish(usage?: OpenAIUsage): Promise<void> {
    await this.emitLifecycleStart();

    const reasoningItem = this.output.completedReasoningItem();
    if (reasoningItem && this.output.reasoningStarted) {
      await this.emit("response.output_item.done", {
        output_index: this.output.reasoningIndex,
        item: reasoningItem,
      });
    }

    for (const update of this.output.completedFunctionCallUpdates()) {
      await this.emit("response.function_call_arguments.done", {
        item_id: update.item.id,
        output_index: update.outputIndex,
        call_id: update.callId,
        name: update.item.name,
        arguments: update.item.arguments,
      });
      await this.emit("response.output_item.done", {
        output_index: update.outputIndex,
        item: update.item,
      });
    }

    const messageItem = this.output.completedMessageItem();

    if (this.contentPartStarted) {
      await this.emit("response.output_text.done", {
        item_id: this.output.messageItemId,
        output_index: this.output.messageIndex,
        content_index: 0,
        text: this.output.messageText,
      });
      await this.emit("response.content_part.done", {
        item_id: this.output.messageItemId,
        output_index: this.output.messageIndex,
        content_index: 0,
        part: this.output.messageContentPart(),
      });
    }

    if (this.output.messageStarted) {
      await this.emit("response.output_item.done", {
        output_index: this.output.messageIndex,
        item: messageItem,
      });
    }

    this.response.status = "completed";
    this.response.output = this.output.completedOutputItems();
    this.response.usage = mapOpenAIUsageToResponsesUsage(usage);

    await this.emit("response.completed", { response: { ...this.response } });
  }
}
