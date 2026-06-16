import { contentToText } from "../content-parts.js";
import type { ChatMessage } from "../openai.js";
import type { ClientToolSpec } from "./types.js";

export interface ClientToolPromptPolicy {
  workspaceMutationRequired: boolean;
  workspaceMutationDone: boolean;
  rewriteUserMessages: boolean;
}

function isWorkspaceMutationToolName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ["write", "edit", "bash", "shell", "writefile", "patch", "terminal"].includes(
    normalized,
  );
}

function hasWorkspaceMutationIntent(messages: ChatMessage[]): boolean {
  const userText = messages
    .filter((m) => m.role === "user")
    .map((m) => contentToText(m.content))
    .join("\n")
    .toLowerCase();
  return /\b(make|create|build|add|write|generate|scaffold|implement|set up|setup)\b/.test(
    userText,
  );
}

function hasWorkspaceMutationToolCall(messages: ChatMessage[]): boolean {
  for (const message of messages) {
    if (typeof message.name === "string" && isWorkspaceMutationToolName(message.name)) {
      return true;
    }
    for (const toolCall of message.tool_calls ?? []) {
      if (isWorkspaceMutationToolName(toolCall.function.name)) return true;
    }
  }
  return false;
}

export function resolveClientToolPromptPolicy(
  messages: ChatMessage[],
  tools: ClientToolSpec[],
): ClientToolPromptPolicy {
  const workspaceMutationRequired = tools.length > 0 && hasWorkspaceMutationIntent(messages);
  const workspaceMutationDone =
    workspaceMutationRequired && hasWorkspaceMutationToolCall(messages);
  return {
    workspaceMutationRequired,
    workspaceMutationDone,
    rewriteUserMessages: workspaceMutationRequired,
  };
}

export function addWorkspaceActionToUserText(text: string): string {
  const userText = text || "[empty]";
  return [
    userText,
    "",
    "Workspace action required: create or update the necessary project files directly with the client's file/shell tools from CLIENT TOOL INVENTORY. Do not output code for the user to save.",
  ].join("\n");
}
