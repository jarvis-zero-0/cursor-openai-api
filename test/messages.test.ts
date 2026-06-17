import { describe, expect, test } from "bun:test";
import {
  buildSendPayload,
  extractImagesFromContent,
  promptExtrasFromRequest,
} from "../src/messages.js";

describe("buildSendPayload", () => {
  test("uses SDKUserMessage when user message has image_url", () => {
    const payload = buildSendPayload([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/a.png" },
          },
        ],
      },
    ]);
    expect(typeof payload).toBe("object");
    if (typeof payload === "object" && payload !== null) {
      expect(payload.text).toContain("What is this?");
      expect(payload.images).toHaveLength(1);
      expect(payload.images![0]).toEqual({ url: "https://example.com/a.png" });
    }
  });

  test("parses data URL images for SDK", () => {
    const images = extractImagesFromContent([
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,abcd" },
      },
    ]);
    expect(images[0]).toEqual({ data: "abcd", mimeType: "image/png" });
  });

  test("includes stop and seed in prompt extras", () => {
    const extras = promptExtrasFromRequest({
      messages: [{ role: "user", content: "hi" }],
      stop: ["END"],
      seed: 42,
      frequency_penalty: 0.5,
    });
    expect(extras.stop).toEqual(["END"]);
    expect(extras.seed).toBe(42);
    expect(extras.frequencyPenalty).toBe(0.5);
  });

  describe("native client-tool payload", () => {
    const messages = [
      { role: "system" as const, content: "You are Hermes. Be concise." },
      { role: "user" as const, content: "List the files." },
    ];
    const extras = {
      tools: [{ type: "function" as const, function: { name: "read_file" } }],
      toolChoice: "auto",
    };
    const specs = [{ name: "read_file", description: "Read a file." }];

    function nativeClientPayload(): string {
      const payload = buildSendPayload(messages, extras, specs);
      expect(typeof payload).toBe("string");
      return payload as string;
    }

    test("dumps no tool schemas — tools are registered as native customTools", () => {
      const payload = nativeClientPayload();
      expect(payload).not.toContain("tool_calls_begin");
      expect(payload).not.toContain("CLIENT TOOL INVENTORY");
      expect(payload).not.toContain("cursor_tool_mode=client");
      expect(payload).not.toContain("WHO YOU ARE");
      // Tool schemas are registered as native customTools, not dumped in prompt.
      expect(payload).not.toContain("## CLIENT_TOOLS");
      // No tool_choice line leaks into the prompt either.
      expect(payload).not.toContain("tool_choice:");
    });

    test("keeps Hermes upstream content and prepends the containment steer", () => {
      const payload = nativeClientPayload();
      expect(payload).toContain("You are Hermes. Be concise.");
      expect(payload).toContain("List the files.");
      expect(payload).toContain("caller-provided tools");
    });

    // The slim native client-tool framing drops the generic proxy framing and
    // any identity contradiction — only Hermes WHO/WHAT (from the upstream
    // messages) + the minimal tool steer survive.
    test("drops the generic OpenAI-compatible proxy framing", () => {
      const payload = nativeClientPayload();
      expect(payload).not.toContain("OpenAI-compatible API proxy");
      expect(payload).not.toContain("Follow the conversation below");
    });

    test("leads with the slim tool steer, not a proxy/identity preamble", () => {
      const payload = nativeClientPayload();
      expect(payload.startsWith("You have caller-provided tools")).toBe(true);
      // No anti-Cursor identity block leaks onto this path.
      expect(payload).not.toContain("you are not the Cursor IDE");
      expect(payload).not.toContain("not your identity here");
    });
  });

  // Only the native client-tool path loses the generic proxy framing. The
  // full-prompt (`auto`) and `native` paths must keep it.
  describe("generic proxy framing is scoped to the native client-tool path", () => {
    const messages = [
      { role: "system" as const, content: "You are Hermes." },
      { role: "user" as const, content: "Refactor auth.ts" },
    ];

    test("auto/full-prompt path keeps the generic proxy framing", () => {
      const payload = buildSendPayload(messages);
      expect(typeof payload).toBe("string");
      expect(payload as string).toContain(
        "responding through an OpenAI-compatible API proxy",
      );
    });

    test("native path keeps the native directive and the generic framing", () => {
      const payload = buildSendPayload(
        messages,
        undefined,
        undefined,
        "native",
      );
      expect(typeof payload).toBe("string");
      expect(payload as string).toContain("standalone Cursor SDK agent");
      expect(payload as string).toContain(
        "responding through an OpenAI-compatible API proxy",
      );
    });
  });
});
