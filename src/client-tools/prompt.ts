import { contentToText } from "../content-parts.js";
import type { ChatMessage } from "../openai.js";
import { parseToolChoice } from "./request.js";
import type { ClientToolSpec } from "./types.js";

// Slim steer for the client-tool path. The tools themselves reach the model as
// SDK `customTools` (registered in agent-turn.ts) and are captured natively —
// there is no marker protocol and no in-prompt tool inventory/schema dump.
const TOOL_SYSTEM_DIRECTIVE = [
  "You are serving an OpenAI-compatible API request through Cursor Composer.",
  "Executable tools are registered and available to you; call them through your native tool channel when the task needs them.",
  "Answer directly when no tool is needed.",
  "Do not emit duplicate tool calls. Call each required operation once, then continue after the tool result returns on the next turn.",
  "Never claim that tools are unavailable. Never tell the user to switch modes.",
].join("\n");

// Hermes orchestrator self-serve tools — the ones the main thread MAY call
// directly instead of delegating, because they are cheap lookups or irreducible
// Hermes-only operations, not substantive work.
//
// SSOT: the canonical role-tagged tool manifest
//   .hermes/hermes-agent/agent/hermes_tool_surface.py :: orchestrator_tools()
// whose orchestrator role is: web_search, skill_view, skills_list, skill_manage,
// send_message, memory, session_search, delegate_task, cronjob, clarify.
// The engine projects that manifest into each request's `tools[]`, so the live
// surface is whatever the request carries; we list below only the subset the
// orchestrator may run *on the main thread* (delegate_task is the loop-only
// delegation tool, handled separately above). This is intentionally NOT a
// second hand-maintained authority: we intersect it with the tools actually
// present this turn, so the directive can never name a tool the engine did not
// send. Keep this list in sync with the manifest's orchestrator role.
const ORCHESTRATOR_SELF_SERVE_TOOLS: readonly string[] = [
  "skill_view",
  "skills_list",
  "skill_manage",
  "session_search",
  "web_search",
  "memory",
  "cronjob",
  "send_message",
  "clarify",
];

// Built when delegate_task is present — steers the model to act as a thin
// orchestrator/router rather than doing substantive work on the main thread.
// The self-serve line is derived from the tools actually present this turn so it
// stays faithful to the manifest projection (see ORCHESTRATOR_SELF_SERVE_TOOLS).
function buildDelegationDirective(toolNames: ReadonlySet<string>): string {
  const selfServe = ORCHESTRATOR_SELF_SERVE_TOOLS.filter((name) =>
    toolNames.has(name),
  );
  const lines = [
    "You are an orchestrator/router. Do NOT do substantive work yourself.",
    "For anything needing file read, shell, search, code, heavy research, diagnosis, verification, or planning: call delegate_task instead.",
    "Flow: classify the request → delegate_task (set model/effort/toolsets/cwd appropriately) → synthesize the worker's summary into a final response.",
  ];
  if (selfServe.length > 0) {
    lines.push(
      "You MAY run these Hermes self-serve tools directly on the main thread " +
        "(cheap lookups or irreducible Hermes-only operations, not substantive " +
        `work): ${selfServe.join(", ")}.`,
    );
  } else {
    lines.push(
      "Only a zero-lookup acknowledgement or a single irreducible Hermes-only " +
        "operation may run directly on the main thread.",
    );
  }
  return lines.join("\n");
}

export function formatClientToolMessage(message: ChatMessage): string {
  const role = message.role.toUpperCase();
  const content = contentToText(message.content);

  if (message.role === "tool") {
    const toolCallId = message.tool_call_id ?? "";
    const toolName = message.name ?? "";
    const label = [
      toolName ? `name=${toolName}` : "",
      toolCallId ? `tool_call_id=${toolCallId}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `TOOL RESULT${label ? ` (${label})` : ""}: ${content || "[empty]"}`;
  }

  const lines = [`${role}: ${content || "[empty]"}`];
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    lines.push(`${role} TOOL_CALLS: ${JSON.stringify(message.tool_calls)}`);
  }
  const reasoning = message.reasoning_content ?? message.reasoning ?? "";
  if (message.role === "assistant" && reasoning.trim()) {
    lines.push(`ASSISTANT REASONING: ${reasoning.trim()}`);
  }
  return lines.join("\n");
}

export function buildClientToolPromptSections(
  messages: ChatMessage[],
  tools: ClientToolSpec[],
  toolChoice: unknown,
): string[] {
  const parsedToolChoice = parseToolChoice(toolChoice);

  const sections: string[] = [TOOL_SYSTEM_DIRECTIVE];

  const toolNames = new Set(tools.map((t) => t.name));
  const isOrchestrator = toolNames.has("delegate_task");
  if (isOrchestrator) {
    console.debug(
      "[client-tools/prompt] delegate_task detected — injecting DELEGATION_DIRECTIVE",
    );
    sections.push(buildDelegationDirective(toolNames));
  }

  if (
    parsedToolChoice &&
    typeof parsedToolChoice === "object" &&
    parsedToolChoice.type === "function"
  ) {
    sections.push(
      `If you call a tool, use the ${parsedToolChoice.functionName} tool.`,
    );
  } else if (parsedToolChoice === "required") {
    sections.push("You must call at least one tool.");
  }

  sections.push("", "Conversation:");
  for (const message of messages) {
    sections.push(formatClientToolMessage(message));
  }

  return sections;
}
