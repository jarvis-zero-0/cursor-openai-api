import { normalizeToolArguments } from "../tool-args.js";
import type {
  ResponseFunctionCallItem,
  ResponseMessageItem,
  ResponseOutputTextPart,
  ResponseReasoningItem,
} from "./schema.js";
import {
  makeFunctionCallItemId,
  makeMessageItemId,
  makeReasoningItemId,
} from "./schema.js";

export function buildReasoningOutputItem(text: string): ResponseReasoningItem {
  return {
    id: makeReasoningItemId(),
    type: "reasoning",
    summary: [{ type: "summary_text", text: text.trim() }],
  };
}

export function buildFunctionCallOutputItem(
  callId: string,
  name: string,
  args: string,
): ResponseFunctionCallItem {
  return {
    id: makeFunctionCallItemId(),
    type: "function_call",
    call_id: callId,
    name,
    arguments: normalizeToolArguments(args),
    status: "completed",
  };
}

export function buildMessageOutputItem(text: string): ResponseMessageItem {
  return {
    id: makeMessageItemId(),
    type: "message",
    status: "completed",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text,
        annotations: [],
      },
    ],
  };
}

export function inProgressFunctionCallItem(
  itemId: string,
  callId: string,
  name: string,
): ResponseFunctionCallItem {
  return {
    id: itemId,
    type: "function_call",
    call_id: callId,
    name,
    arguments: "",
    status: "in_progress",
  };
}

export function inProgressMessageItem(itemId: string): ResponseMessageItem {
  return {
    id: itemId,
    type: "message",
    status: "in_progress",
    role: "assistant",
    content: [],
  };
}

export function emptyOutputTextPart(): ResponseOutputTextPart {
  return { type: "output_text", text: "", annotations: [] };
}
