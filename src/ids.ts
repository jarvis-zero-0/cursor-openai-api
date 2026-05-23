export function makeId(prefix: string, separator: "-" | "_" = "_"): string {
  return `${prefix}${separator}${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
