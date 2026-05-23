import type { ChatMessage } from "./openai.js";

export function stableMessageShape(message: ChatMessage): string {
  return JSON.stringify({
    content: message.content ?? null,
    function_call: message.function_call,
    name: message.name,
    role: message.role,
    reasoning: message.reasoning,
    reasoning_content: message.reasoning_content,
    tool_call_id: message.tool_call_id,
    tool_calls: message.tool_calls,
  });
}

export function hashMessageSnapshot(messages: ChatMessage[]): string {
  let h = 2166136261;
  for (const message of messages) {
    const shape = stableMessageShape(message);
    for (let i = 0; i < shape.length; i++) {
      h ^= shape.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x7c;
  }
  return `${(h >>> 0).toString(36)}:${messages.length}`;
}
