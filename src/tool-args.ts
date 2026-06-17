export function normalizeToolArguments(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) return "{}";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    // Unwrap double-encoded JSON objects (model/proxy sometimes stringify twice).
    if (typeof parsed === "string") {
      const inner = parsed.trim();
      if (
        (inner.startsWith("{") && inner.endsWith("}")) ||
        (inner.startsWith("[") && inner.endsWith("]"))
      ) {
        try {
          JSON.parse(inner);
          return inner;
        } catch {
          // keep outer string encoding
        }
      }
    }
    return trimmed;
  } catch {
    return JSON.stringify(trimmed);
  }
}
