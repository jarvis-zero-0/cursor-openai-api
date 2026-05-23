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
});
