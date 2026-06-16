/**
 * Static map of Hermes client tool names → the toolset they belong to.
 *
 * The proxy only ever sees a flat OpenAI `tools` array (names + JSON schemas)
 * with no grouping metadata, so toolset-based filtering needs a name→toolset
 * lookup. This mirrors Hermes Agent's own toolset names (`file`, `terminal`,
 * `browser`, `delegation`, …) so a request can ask for `enabled_toolsets` the
 * same way a Hermes cron job does.
 *
 * Tools not listed here fall into the synthetic `UNMAPPED_TOOLSET` bucket.
 * Toolset filtering keeps unmapped tools unless the caller opts out, so a stale
 * map never silently drops a tool the model genuinely needs.
 */

export const UNMAPPED_TOOLSET = "other";

export const TOOL_TOOLSETS: Readonly<Record<string, string>> = {
  // file
  read_file: "file",
  write_file: "file",
  patch: "file",
  search_files: "file",
  // terminal / process control
  terminal: "terminal",
  process: "terminal",
  execute_code: "coding",
  // browser automation
  browser_back: "browser",
  browser_click: "browser",
  browser_console: "browser",
  browser_get_images: "browser",
  browser_navigate: "browser",
  browser_press: "browser",
  browser_scroll: "browser",
  browser_snapshot: "browser",
  browser_type: "browser",
  // desktop automation
  computer_use: "computer_use",
  // delegation / scheduling
  delegate_task: "delegation",
  cronjob: "cronjob",
  // memory / recall
  memory: "memory",
  session_search: "session_search",
  // skills
  skill_manage: "skills",
  skill_view: "skills",
  skills_list: "skills",
  // messaging / interaction
  send_message: "messaging",
  clarify: "interaction",
  todo: "todo",
  text_to_speech: "tts",
};

/** Toolset a tool belongs to, or `UNMAPPED_TOOLSET` when unknown. */
export function toolsetForTool(name: string): string {
  return TOOL_TOOLSETS[name] ?? UNMAPPED_TOOLSET;
}

/** Sorted list of every known toolset name (excludes the synthetic bucket). */
export function knownToolsets(): string[] {
  return [...new Set(Object.values(TOOL_TOOLSETS))].sort();
}

/** Expand a set of toolset names into the concrete tool names they contain. */
export function toolNamesForToolsets(toolsets: Iterable<string>): Set<string> {
  const wanted = new Set(toolsets);
  const names = new Set<string>();
  for (const [tool, toolset] of Object.entries(TOOL_TOOLSETS)) {
    if (wanted.has(toolset)) names.add(tool);
  }
  return names;
}
