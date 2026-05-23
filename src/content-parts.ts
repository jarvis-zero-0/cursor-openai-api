import type { SDKImage } from "@cursor/sdk";
import type { ContentPartInput } from "./content-part-schema.js";
import type { ChatMessage } from "./openai.js";

export type ContentPart = ContentPartInput;

export function partToText(part: ContentPart): string {
  if (part.type === "text" && part.text) return part.text;
  if (part.type === "input_text" && part.text) return part.text;
  if (
    (part.type === "image_url" || part.type === "input_image") &&
    part.image_url?.url
  ) {
    return `[image: ${part.image_url.url}]`;
  }
  return `[${part.type ?? "unknown"}]`;
}

function isContentPart(part: unknown): part is ContentPart {
  return typeof part === "object" && part !== null && "type" in part;
}

export function contentToText(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => (isContentPart(part) ? partToText(part) : "[unknown]"))
    .join("\n");
}

export function parseDataUrl(url: string): SDKImage | undefined {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(url.trim());
  if (!match) return undefined;
  return { data: match[2]!, mimeType: match[1]! };
}

export function partToImage(part: ContentPart): SDKImage | undefined {
  if (part.type !== "image_url" && part.type !== "input_image") {
    return undefined;
  }
  const url = part.image_url?.url?.trim();
  if (!url) return undefined;
  return parseDataUrl(url) ?? { url };
}

export function extractImagesFromContent(
  content: ChatMessage["content"],
): SDKImage[] {
  if (content == null || typeof content === "string") return [];
  const images: SDKImage[] = [];
  for (const part of content) {
    if (!isContentPart(part)) continue;
    const image = partToImage(part);
    if (image) images.push(image);
  }
  return images;
}

export function contentHasImages(content: ChatMessage["content"]): boolean {
  return extractImagesFromContent(content).length > 0;
}
