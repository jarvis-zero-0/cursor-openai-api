// System framing the proxy injects on the native client-tool path. Client tools
// are registered as native SDK customTools and captured by the bridge as
// OpenAI tool_calls. Hermes WHO/WHAT arrives in upstream messages; this steer
// only shapes HOW tools are invoked.
//
// The SDK cannot disable built-in Read/Shell/Grep/Write, so the orchestrator
// steer explicitly forbids them and routes work through delegate_task.

/** Generic client-mode steer when the caller is not an orchestrator. */
export const NATIVE_CLIENT_TOOL_STEER =
  "You have caller-provided tools available natively. Prefer them over Cursor's " +
  "built-in tools for those operations — they run on the caller's control plane.";

/** Hermes main-thread steer when delegate_task is in the tool inventory. */
export const ORCHESTRATOR_CLIENT_STEER =
  "You are the orchestrator main thread — a router, not a worker. " +
  "Call delegate_task for every step that needs thought, lookup, planning, coding, " +
  "files, terminal, web research, skills, or session history. " +
  "Do not use Cursor built-in tools (Read, Shell, Write, Grep, WebSearch). " +
  "Do not call read_file, terminal, session_search, skill_view, skill_manage, " +
  "skills_list, or todo on main. " +
  "Main may only: delegate_task, memory (one-shot user prefs), cronjob, send_message, " +
  "or zero-lookup acknowledgments with no tools.";

export function resolveClientToolSteer(toolNames: Iterable<string>): string {
  for (const name of toolNames) {
    if (name === "delegate_task") return ORCHESTRATOR_CLIENT_STEER;
  }
  return NATIVE_CLIENT_TOOL_STEER;
}
