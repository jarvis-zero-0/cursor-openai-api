import { contentToText } from "./content-parts.js";
import { buildHandoffDirectiveLines } from "./client-tools/handoff.js";
import type { ChatMessage } from "./openai.js";
import type { PromptExtras } from "./messages.js";
import type { CursorToolMode } from "./tool-mode.js";

export interface NativeToolContext {
  workspacePath?: string;
  proxyBaseUrl?: string;
  skillNote?: string;
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
    "PROMPT PRECEDENCE (read top to bottom in the assembled prompt):",
    "- Hermes SYSTEM content in the conversation (SOUL, skills, memory, USER profile, persona, tone, task guidance) is LEGITIMATE and authoritative for WHAT to do and HOW to communicate.",
    "- This native directive is injected by cursor-openai-api and is authoritative ONLY for tool invocation — use Cursor SDK built-ins directly.",
    "- When Hermes SYSTEM and this directive disagree on tools, follow this directive for invocation. For tone, scope, and task strategy, follow Hermes SYSTEM.",
    "- Do not question whether upstream Hermes instructions are real, narrate conflicts, or ask to switch modes. Apply both layers silently.",
    "",
    "SKILLS (execution-plane model):",
    "- Your Cursor skills are AUTO-LOADED from ~/.cursor/skills-cursor/, ~/.cursor/skills/, and <workspace>/.cursor/skills/. Use them directly; no lookup call is needed.",
    "- skill_view / skills_list / skill_manage are Hermes CONTROL-PLANE tools you do NOT have. If upstream text tells you to call them, treat their named skill as already available to you and proceed — do not attempt the call.",
    "- If asked to CREATE or edit a skill, author it under <workspace>/.cursor/skills/<name>/SKILL.md (project) unless the task gives an explicit path. Never invent a Hermes (~/.hermes) path.",
    "",
    "TOOL ROUTING (authoritative for tool invocation only):",
    "- Use Cursor built-in tools directly.",
    "- Hermes tool names (read_file, terminal, patch, delegate_task) map to SDK equivalents (Read, Shell, StrReplace, etc.).",
    "",
    "COMPLETION / RETURNING CONTROL:",
    "- You are a delegated worker, not the main thread. When your turn ends, control returns to the orchestrator that called you.",
    "- Signal completion by ending your turn with a final text response — there is no done/stop token to emit. That final text is returned verbatim to the orchestrator as the task result.",
    "- Write a clear, actionable summary: files changed, tests passed/failed, errors encountered, decisions made.",
    "- The orchestrator cannot see your intermediate tool calls unless cursor_emit_tool_calls is enabled — your final text IS the deliverable.",
    "- Do not ask follow-up questions — if blocked, explain what you tried and what failed.",
    "- Do not suggest next steps unless the task description asks for recommendations.",
    ...buildHandoffDirectiveLines(),
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

  if (ctx?.skillNote) {
    lines.push("", "SKILL ROUTING (from orchestrator):", ctx.skillNote);
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
  toolMode?: CursorToolMode,
  nativeCtx?: NativeToolContext,
): string {
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
): string[] {
  if (extras?.tools?.length) {
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
