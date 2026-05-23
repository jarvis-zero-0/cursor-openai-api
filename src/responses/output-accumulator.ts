import type { ChatCompletionResponse } from "../openai.js";
import {
  buildFunctionCallOutputItem,
  buildMessageOutputItem,
  buildReasoningOutputItem,
  emptyOutputTextPart,
  inProgressFunctionCallItem,
  inProgressMessageItem,
} from "./output-items.js";
import type {
  ResponseFunctionCallItem,
  ResponseMessageItem,
  ResponseOutputItem,
  ResponseOutputTextPart,
  ResponseReasoningItem,
} from "./schema.js";
import {
  makeFunctionCallItemId,
  makeMessageItemId,
  makeReasoningItemId,
} from "./schema.js";

type ChatToolCallDelta = NonNullable<
  ChatCompletionResponse["choices"][0]["message"]["tool_calls"]
>[0];

type StreamToolCallDelta = {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

interface FunctionCallState {
  itemId: string;
  outputIndex: number;
  callId: string;
  name: string;
  arguments: string;
}

type OutputSlot =
  | { type: "reasoning" }
  | { type: "function_call"; callId: string }
  | { type: "message" };

export interface StartedResponseItem<T extends ResponseOutputItem> {
  created: boolean;
  outputIndex: number;
  item: T;
}

export interface ToolCallDeltaUpdate {
  added?: StartedResponseItem<ResponseFunctionCallItem>;
  callId: string;
  itemId: string;
  outputIndex: number;
  argsDelta: string;
}

export class ResponseOutputAccumulator {
  readonly messageItemId = makeMessageItemId();
  readonly reasoningItemId = makeReasoningItemId();

  private textBuffer = "";
  private reasoningBuffer = "";
  private messageOutputIndex: number | undefined;
  private reasoningOutputIndex: number | undefined;
  private nextOutputIndex = 0;
  private readonly outputOrder: OutputSlot[] = [];
  private readonly functionCalls = new Map<string, FunctionCallState>();

  appendChatMessage(
    message: ChatCompletionResponse["choices"][0]["message"],
  ): void {
    if (message.reasoning_content) {
      this.ensureReasoningItem();
      this.appendReasoning(message.reasoning_content);
    }
    for (const toolCall of message.tool_calls ?? []) {
      this.addCompletedToolCall(toolCall);
    }
    this.ensureMessageItem();
    this.appendText(message.content ?? "");
  }

  appendText(text: string): void {
    this.textBuffer += text;
  }

  appendReasoning(text: string): void {
    this.reasoningBuffer += text;
  }

  ensureReasoningItem(): StartedResponseItem<ResponseReasoningItem> {
    const existing = this.reasoningOutputIndex;
    if (existing !== undefined) {
      return {
        created: false,
        outputIndex: existing,
        item: this.reasoningInProgressItem(),
      };
    }

    const outputIndex = this.allocateOutputIndex();
    this.reasoningOutputIndex = outputIndex;
    this.outputOrder.push({ type: "reasoning" });
    return {
      created: true,
      outputIndex,
      item: this.reasoningInProgressItem(),
    };
  }

  ensureMessageItem(): StartedResponseItem<ResponseMessageItem> {
    const existing = this.messageOutputIndex;
    if (existing !== undefined) {
      return {
        created: false,
        outputIndex: existing,
        item: inProgressMessageItem(this.messageItemId),
      };
    }

    const outputIndex = this.allocateOutputIndex();
    this.messageOutputIndex = outputIndex;
    this.outputOrder.push({ type: "message" });
    return {
      created: true,
      outputIndex,
      item: inProgressMessageItem(this.messageItemId),
    };
  }

  applyToolCallDelta(
    delta: StreamToolCallDelta,
  ): ToolCallDeltaUpdate | undefined {
    const callId = delta.id ?? `call_${delta.index}`;
    let entry = this.functionCalls.get(callId);
    let added: StartedResponseItem<ResponseFunctionCallItem> | undefined;

    if (!entry) {
      const name = delta.function?.name;
      if (!name) return undefined;
      entry = {
        itemId: makeFunctionCallItemId(),
        outputIndex: this.allocateOutputIndex(),
        callId,
        name,
        arguments: "",
      };
      this.functionCalls.set(callId, entry);
      this.outputOrder.push({ type: "function_call", callId });
      added = {
        created: true,
        outputIndex: entry.outputIndex,
        item: inProgressFunctionCallItem(entry.itemId, callId, name),
      };
    }

    const argsDelta = delta.function?.arguments ?? "";
    entry.arguments += argsDelta;
    return {
      added,
      callId,
      itemId: entry.itemId,
      outputIndex: entry.outputIndex,
      argsDelta,
    };
  }

  completedOutputItems(): ResponseOutputItem[] {
    const output: ResponseOutputItem[] = [];

    for (const slot of this.outputOrder) {
      const item = this.completedItemForSlot(slot);
      if (item) output.push(item);
    }

    if (!this.messageStarted) output.push(this.completedMessageItem());
    return output;
  }

  completedReasoningItem(): ResponseReasoningItem | undefined {
    if (!this.reasoningBuffer.trim()) return undefined;
    const item = buildReasoningOutputItem(this.reasoningBuffer);
    item.id = this.reasoningItemId;
    return item;
  }

  completedMessageItem(): ResponseMessageItem {
    const item = buildMessageOutputItem(this.textBuffer);
    item.id = this.messageItemId;
    return item;
  }

  completedFunctionCallUpdates(): Array<{
    callId: string;
    outputIndex: number;
    item: ResponseFunctionCallItem;
  }> {
    return [...this.functionCalls.values()].map((entry) => ({
      callId: entry.callId,
      outputIndex: entry.outputIndex,
      item: this.completedFunctionCallItem(entry),
    }));
  }

  messageContentPart(): ResponseOutputTextPart {
    return this.completedMessageItem().content[0] ?? emptyOutputTextPart();
  }

  get reasoningStarted(): boolean {
    return this.reasoningOutputIndex !== undefined;
  }

  get messageStarted(): boolean {
    return this.messageOutputIndex !== undefined;
  }

  get messageText(): string {
    return this.textBuffer;
  }

  get messageIndex(): number {
    return this.messageOutputIndex ?? 0;
  }

  get reasoningIndex(): number {
    return this.reasoningOutputIndex ?? 0;
  }

  private addCompletedToolCall(toolCall: ChatToolCallDelta): void {
    const existing = this.functionCalls.get(toolCall.id);
    if (existing) {
      existing.name = toolCall.function.name;
      existing.arguments = toolCall.function.arguments;
      return;
    }

    this.functionCalls.set(toolCall.id, {
      itemId: makeFunctionCallItemId(),
      outputIndex: this.allocateOutputIndex(),
      callId: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    });
    this.outputOrder.push({ type: "function_call", callId: toolCall.id });
  }

  private completedItemForSlot(slot: OutputSlot): ResponseOutputItem | undefined {
    if (slot.type === "reasoning") return this.completedReasoningItem();
    if (slot.type === "message") return this.completedMessageItem();
    const entry = this.functionCalls.get(slot.callId);
    return entry ? this.completedFunctionCallItem(entry) : undefined;
  }

  private completedFunctionCallItem(
    entry: FunctionCallState,
  ): ResponseFunctionCallItem {
    const item = buildFunctionCallOutputItem(
      entry.callId,
      entry.name,
      entry.arguments || "{}",
    );
    item.id = entry.itemId;
    return item;
  }

  private reasoningInProgressItem(): ResponseReasoningItem {
    return {
      id: this.reasoningItemId,
      type: "reasoning",
      summary: [],
    };
  }

  private allocateOutputIndex(): number {
    return this.nextOutputIndex++;
  }
}

export function assembleOutputItemsFromChoice(
  message: ChatCompletionResponse["choices"][0]["message"],
): ResponseOutputItem[] {
  const output = new ResponseOutputAccumulator();
  output.appendChatMessage(message);
  return output.completedOutputItems();
}
