import fs from "node:fs";
import path from "node:path";

/**
 * Minimal, dependency-free `.env` loader. The proxy is launched under launchd as
 * `node dist/index.js`, which (unlike `bun run`) does NOT auto-load `.env` — so a
 * value present only in the repo `.env` (e.g. `CURSOR_CWD_ALLOWLIST`) would never
 * reach `process.env` and security/cwd defaults would silently differ from the
 * documented config. This bridges that gap.
 *
 * Precedence: an existing `process.env` value ALWAYS wins (so the launchd plist /
 * shell env remains authoritative); `.env` only fills in keys that are unset.
 * Parsing is intentionally simple (KEY=VALUE, `#` comments, optional surrounding
 * quotes) and never throws — a missing or malformed file is a no-op.
 */
export function loadDotEnv(
  file: string = path.resolve(process.cwd(), ".env"),
  env: NodeJS.ProcessEnv = process.env,
): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return; // no .env present — fine.
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!key || Object.prototype.hasOwnProperty.call(env, key)) {
      // process.env (plist / shell) wins; don't overwrite an existing value.
      if (env[key] !== undefined) continue;
    }

    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}
