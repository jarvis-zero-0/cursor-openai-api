// The complete system framing the proxy injects on the native client-tool path:
// one short built-in containment steer and nothing else. The caller's client
// tools are registered as native SDK customTools and captured by the bridge as
// OpenAI tool_calls. The path carries only Hermes's WHO/WHAT (which already
// arrives in the upstream messages) plus this steer, so it never duplicates or
// fights Composer's baked-in Cursor identity. Hermes provides the persona/task;
// the model is genuinely a Cursor agent, so we do not contradict either.
//
// The SDK cannot disable/allowlist the always-live built-in Read/Shell/Grep/
// Write, so the lightest defensible default is this nudge toward the
// caller-provided tools (which run on the caller's control plane, the correct
// executor) over Cursor's built-ins.
export const NATIVE_CLIENT_TOOL_STEER =
  "You have caller-provided tools available natively (files, shell, search, " +
  "delegation, memory, and more). Prefer them over Cursor's built-in tools for " +
  "those operations — they run on the caller's control plane, the correct " +
  "execution context.";
