import { z } from "zod";

export const chatMetadataSchema = z.record(z.string(), z.string());

export function normalizeChatMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      result[key] = value;
    } else if (value != null) {
      result[key] = String(value);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalizeResponseMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> {
  return normalizeChatMetadata(metadata) ?? {};
}
