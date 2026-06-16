#!/usr/bin/env bun
/**
 * Measure the serialized size of the client-mode tool inventory and the savings
 * from per-request tool filtering. Estimates tokens with a chars/4 heuristic
 * (labeled as an estimate — not a real tokenizer).
 *
 * Usage:
 *   bun run scripts/measure-tool-tokens.ts [--tools <path>] \
 *     [--allow a,b] [--deny browser_*,cronjob] [--toolsets file,terminal] \
 *     [--no-keep-unmapped]
 *
 * The tools file is either a bare Hermes inventory ([{name,description,parameters}])
 * or an OpenAI tools array ([{type:'function',function:{...}}]).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ClientToolSpec } from "../src/client-tools/types.js";
import { applyToolFilter, type ToolFilter } from "../src/client-tools/filter.js";
import { toolsetForTool } from "../src/client-tools/toolsets.js";
import {
  DEFAULT_RESIDENT_TOOLS,
  briefToolLine,
  splitToolTiers,
  type ToolTierPolicy,
} from "../src/client-tools/catalog.js";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function toSpec(entry: unknown): ClientToolSpec {
  const obj = entry as Record<string, unknown>;
  const fn = (obj.function ?? obj) as Record<string, unknown>;
  return {
    name: String(fn.name),
    ...(typeof fn.description === "string" ? { description: fn.description } : {}),
    ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
  };
}

/** Mirror appendChatTools: one JSON line per tool. */
function serializeTool(spec: ClientToolSpec): string {
  return JSON.stringify({
    name: spec.name,
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.parameters !== undefined ? { parameters: spec.parameters } : {}),
  });
}

function estTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function totalChars(specs: ClientToolSpec[]): number {
  return specs.reduce((sum, spec) => sum + serializeTool(spec).length + 1, 0);
}

/** Chars when rendered under a tier policy (full schema + brief signatures). */
function tierChars(specs: ClientToolSpec[], tier: ToolTierPolicy): number {
  const { full, brief } = splitToolTiers(specs, tier);
  const fullChars = full.reduce(
    (sum, spec) => sum + serializeTool(spec).length + 1,
    0,
  );
  const briefChars = brief.reduce(
    (sum, spec) => sum + briefToolLine(spec).length + 1,
    0,
  );
  return fullChars + briefChars;
}

function asList(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== "string") return undefined;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function report(label: string, specs: ClientToolSpec[], baseline: number): void {
  const chars = totalChars(specs);
  const tokens = estTokens(chars);
  const pct = baseline > 0 ? Math.round((1 - chars / baseline) * 100) : 0;
  const saved = pct > 0 ? `  (-${pct}%)` : "";
  console.log(
    `  ${label.padEnd(34)} ${String(specs.length).padStart(2)} tools  ` +
      `${String(chars).padStart(6)} chars  ~${String(tokens).padStart(5)} tok${saved}`,
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const toolsPath =
    typeof args.tools === "string"
      ? resolve(args.tools)
      : resolve(here, "fixtures/hermes-tools.sample.json");

  const raw = JSON.parse(readFileSync(toolsPath, "utf8")) as unknown[];
  const specs = raw.map(toSpec);
  const baseline = totalChars(specs);

  console.log(`\nTool inventory: ${toolsPath}`);
  console.log(`(token counts are chars/4 estimates, not a real tokenizer)\n`);

  console.log("Per-toolset breakdown:");
  const byToolset = new Map<string, ClientToolSpec[]>();
  for (const spec of specs) {
    const ts = toolsetForTool(spec.name);
    (byToolset.get(ts) ?? byToolset.set(ts, []).get(ts)!).push(spec);
  }
  for (const [ts, group] of [...byToolset.entries()].sort()) {
    report(ts, group, 0);
  }

  console.log("\nFull inventory:");
  report("ALL TOOLS (no filter)", specs, 0);

  console.log("\nFilter scenarios (vs full inventory):");
  const scenarios: Array<{ label: string; filter: ToolFilter }> = [
    {
      label: "deny browser_*,computer_use,cronjob",
      filter: {
        deny: ["browser_*", "computer_use", "cronjob"],
        keepUnmapped: true,
      },
    },
    {
      label: "toolsets=file,terminal,coding",
      filter: {
        toolsets: ["file", "terminal", "coding"],
        keepUnmapped: false,
      },
    },
    {
      label: "toolsets=file,terminal (keep unmapped)",
      filter: { toolsets: ["file", "terminal"], keepUnmapped: true },
    },
    {
      label: "allow=read_file,write_file,patch,terminal",
      filter: {
        allow: ["read_file", "write_file", "patch", "terminal"],
        keepUnmapped: false,
      },
    },
  ];

  const cliFilter: ToolFilter = {
    allow: asList(args.allow),
    deny: asList(args.deny),
    toolsets: asList(args.toolsets),
    keepUnmapped: args["no-keep-unmapped"] !== true,
  };
  const hasCli = cliFilter.allow || cliFilter.deny || cliFilter.toolsets;

  for (const { label, filter } of scenarios) {
    report(label, applyToolFilter(specs, filter), baseline);
  }

  console.log("\nTier scenarios (progressive disclosure, vs full inventory):");
  const tierScenarios: Array<{ label: string; tier: ToolTierPolicy }> = [
    {
      label: "tiered (resident full + rest brief)",
      tier: { mode: "tiered", resident: new Set(DEFAULT_RESIDENT_TOOLS) },
    },
    { label: "brief (all signatures)", tier: { mode: "brief", resident: new Set() } },
  ];
  for (const { label, tier } of tierScenarios) {
    const chars = tierChars(specs, tier);
    const pct = Math.round((1 - chars / baseline) * 100);
    console.log(
      `  ${label.padEnd(34)} ${String(specs.length).padStart(2)} tools  ` +
        `${String(chars).padStart(6)} chars  ~${String(estTokens(chars)).padStart(5)} tok  (-${pct}%)`,
    );
  }

  if (hasCli) {
    console.log("\nCLI filter:");
    report("custom (from args)", applyToolFilter(specs, cliFilter), baseline);
  }
  console.log("");
}

main();
