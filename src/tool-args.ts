export function normalizeToolArguments(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) return "{}";
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    return JSON.stringify(trimmed);
  }
}
