import { contentToText } from "./content-parts.js";
import { buildClientToolPromptSections } from "./client-tools/prompt.js";
import type { ClientToolSpec } from "./client-tools/types.js";
import type { ChatMessage } from "./openai.js";
import type { PromptExtras } from "./messages.js";
import type { CursorToolMode } from "./tool-mode.js";

export interface NativeToolContext {
  workspacePath?: string;
  proxyBaseUrl?: string;
}

export function buildNativeToolDirective(ctx?: NativeToolContext): string {
  const lines = [
    "ROLE: You are a standalone Cursor SDK agent — a fully autonomous worker with native tooling.",
    "",
    "CAPABILITIES:",
    "- Full Cursor built-in tools: Read, Shell, Write, Grep, Glob, StrReplace, EditNotebook, ReadLints, Task, SwitchMode, etc.",
    "- You can read files, edit code, run commands, search the codebase, and make changes autonomously.",
    "- Multi-step work happens inside this single turn — use as many tool calls as needed to complete the task.",
    "",
    "TOOL ROUTING (authoritative for this request):",
    "- Use Cursor built-in tools directly. Do NOT use the Hermes/client marker protocol (<|tool_calls_begin|>, CLIENT TOOL INVENTORY, read_file/terminal via markers).",
    "- If SYSTEM messages describe Hermes tools or marker invocation, they do not apply — you are fully delegated with native SDK access.",
    "- Do not narrate instruction conflicts or ask to switch modes. Just do the work.",
    "",
    "COMPLETION / RETURNING CONTROL:",
    "- You are a delegated worker, not the main thread. When your turn ends, control returns to the orchestrator that called you.",
    "- Signal completion by ending your turn with a final text response — there is no done/stop token to emit. That final text is returned verbatim to the orchestrator as the task result.",
    "- Write a clear, actionable summary: files changed, tests passed/failed, errors encountered, decisions made.",
    "- The orchestrator cannot see your intermediate tool calls unless cursor_emit_tool_calls is enabled — your final text IS the deliverable.",
    "- Do not ask follow-up questions — if blocked, explain what you tried and what failed.",
    "- Do not suggest next steps unless the task description asks for recommendations.",
  ];

  if (ctx?.workspacePath) {
    lines.push("", `WORKSPACE: ${ctx.workspacePath}`);
  }

  if (ctx?.proxyBaseUrl) {
    lines.push(
      "",
      "SELF-REFERENCING (calling other models):",
      `- The OpenAI-compatible proxy is at ${ctx.proxyBaseUrl}`,
      "- To call another model for a subtask, use Shell with curl:",
      `    curl -s ${ctx.proxyBaseUrl}/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"composer-2.5","messages":[{"role":"user","content":"..."}]}'`,
      "- Use sparingly — prefer doing work directly with your SDK tools.",
    );
  }

  return lines.join("\n");
}

export const NATIVE_TOOL_DIRECTIVE = buildNativeToolDirective();

function formatToolCalls(message: ChatMessage): string {
  if (!message.tool_calls?.length) return "";
  const lines = message.tool_calls.map((tc) => {
    const fn = tc.function;
    return `tool_call id=${tc.id} name=${fn.name} arguments=${fn.arguments}`;
  });
  return `\n${lines.join("\n")}`;
}

function formatAssistantReasoning(message: ChatMessage): string {
  const reasoning = message.reasoning_content ?? message.reasoning ?? "";
  if (!reasoning.trim()) return "";
  return `\nreasoning_content:\n${reasoning.trim()}`;
}

function formatMessage(message: ChatMessage): string {
  const role = message.role.toUpperCase();
  const content = contentToText(message.content);
  const name = message.name ? ` (${message.name})` : "";
  const toolCallId = message.tool_call_id
    ? `\ntool_call_id: ${message.tool_call_id}`
    : "";
  const functionCall = message.function_call
    ? `\nfunction_call: ${message.function_call.name}(${message.function_call.arguments})`
    : "";
  const toolCalls = formatToolCalls(message);
  const reasoning =
    message.role === "assistant" ? formatAssistantReasoning(message) : "";
  return `## ${role}${name}\n${content}${reasoning}${toolCallId}${functionCall}${toolCalls}`.trim();
}

export function serializeMessagesToPrompt(
  messages: ChatMessage[],
  extras?: PromptExtras,
  clientToolSpecs?: ClientToolSpec[],
  toolMode?: CursorToolMode,
  nativeCtx?: NativeToolContext,
): string {
  if (clientToolSpecs?.length) {
    const sections = buildClientToolPromptSections(
      messages,
      clientToolSpecs,
      extras?.toolChoice,
    );
    return appendPromptOptions(sections, extras, { skipTools: true }).join("\n");
  }

  const sections: string[] = [];
  if (toolMode === "native") {
    sections.push(buildNativeToolDirective(nativeCtx), "");
  }
  sections.push(
    "You are responding through an OpenAI-compatible API proxy. Follow the conversation below.",
    "",
    ...messages.map(formatMessage),
  );

  return appendPromptOptions(sections, extras).join("\n");
}

function appendPromptOptions(
  sections: string[],
  extras?: PromptExtras,
  options?: { skipTools?: boolean },
): string[] {
  if (!options?.skipTools && extras?.tools?.length) {
    sections.push(
      "",
      "## CLIENT_TOOLS (OpenAI function schemas — best-effort; you may use your own tools)",
      JSON.stringify(extras.tools, null, 2),
    );
  }
  if (extras?.toolChoice != null) {
    sections.push("", `tool_choice: ${JSON.stringify(extras.toolChoice)}`);
  }
  if (extras?.temperature != null) {
    sections.push(`temperature: ${extras.temperature}`);
  }
  if (extras?.topP != null) {
    sections.push(`top_p: ${extras.topP}`);
  }
  if (extras?.maxTokens != null) {
    sections.push(`max_tokens: ${extras.maxTokens}`);
  }
  if (extras?.stop != null) {
    const stop = Array.isArray(extras.stop) ? extras.stop : [extras.stop];
    sections.push(`stop: ${JSON.stringify(stop)}`);
  }
  if (extras?.seed != null) {
    sections.push(`seed: ${extras.seed}`);
  }
  if (extras?.frequencyPenalty != null) {
    sections.push(`frequency_penalty: ${extras.frequencyPenalty}`);
  }
  if (extras?.presencePenalty != null) {
    sections.push(`presence_penalty: ${extras.presencePenalty}`);
  }
  if (extras?.verbosity != null) {
    sections.push(`verbosity: ${extras.verbosity}`);
  }
  if (extras?.responseFormat != null) {
    sections.push(
      "",
      "## RESPONSE_FORMAT",
      JSON.stringify(extras.responseFormat, null, 2),
    );
  }
  if (extras?.passthrough && Object.keys(extras.passthrough).length > 0) {
    sections.push(
      "",
      "## API_PARAMETERS",
      JSON.stringify(extras.passthrough, null, 2),
    );
  }
  return sections;
}
