// Claude Code print mode adapter for the shared detached runner.

import fs from "node:fs";
import path from "node:path";

export const CLAUDE_MIN_VERSION = "2.1.286";
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const CLAUDE_AUTH_MODES = ["subscription", "api"];
const READ_TOOLS = "Read,Glob,Grep";
const WRITE_TOOLS = "Read,Glob,Grep,Edit,Write";

export function supportsClaudeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)\b/.exec(version ?? "");
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  const [minMajor, minMinor, minPatch] = CLAUDE_MIN_VERSION.split(".").map(Number);
  return major > minMajor || (major === minMajor && (minor > minMinor || (minor === minMinor && patch >= minPatch)));
}

// Never forward a third-party provider, proxy or nested-session marker to a worker.
const SHARED_UNSET = [
  "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_FOUNDRY_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"
];

/**
 * Environment changes for a Claude worker.
 * Input: auth mode. Output: { unset: string[], set: { name: value } }.
 * subscription: drop API keys so Claude Code uses the user's own login.
 * api: drop OAuth tokens so only ANTHROPIC_API_KEY authenticates (--bare enforces it too).
 * Both: keep CLAUDE.md files, auto memory and built-in subagents out of the run.
 */
export function claudeWorkerEnv(auth) {
  const unset = auth === "api"
    ? [...SHARED_UNSET, "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]
    : [...SHARED_UNSET, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
  return {
    unset,
    set: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1" }
  };
}

/**
 * Turn packet editable_paths into Claude Code permission rules, relative to the run's cwd.
 * Input: entries, cwd. Output: { rules } or { error }.
 * A directory (trailing slash, or an existing directory) becomes Edit(./dir/**); a file or glob
 * becomes Edit(./entry). Absolute paths, `..`, and characters the CLI would split or misparse
 * (whitespace, commas, parentheses) are rejected.
 */
export function editRulesFor(entries, cwd) {
  if (!entries.length) return { error: "editable_paths is empty; a Claude write run needs at least one path" };
  const rules = [];
  for (const raw of entries) {
    const entry = raw.trim().replace(/\\/g, "/");
    if (!entry) return { error: "editable_paths has an empty entry" };
    if (/[\s,()]/.test(entry)) return { error: `editable_paths entry '${raw}' contains whitespace, a comma or a parenthesis` };
    if (entry.startsWith("/") || entry.startsWith("~") || /^[A-Za-z]:/.test(entry)) return { error: `editable_paths entry '${raw}' must be relative to --cwd` };
    if (entry.split("/").includes("..")) return { error: `editable_paths entry '${raw}' must not contain '..'` };
    const relative = entry.replace(/^(\.\/)+/, "");
    if (!relative || relative === ".") return { error: `editable_paths entry '${raw}' names the whole working directory; list paths instead` };
    const glob = /[*?[\]{}]/.test(relative);
    let directory = relative.endsWith("/");
    if (!glob && !directory) {
      try { directory = fs.statSync(path.join(cwd, relative)).isDirectory(); } catch { directory = false; }
    }
    const clean = relative.replace(/\/+$/, "");
    rules.push(directory ? `Edit(./${clean}/**)` : `Edit(./${clean})`);
  }
  return { rules: [...new Set(rules)] };
}

/**
 * Argument vector for one Claude Code print-mode run.
 * Input: { model, effort, auth, write, editRules, maxBudgetUsd }. Output: string[].
 */
export function buildClaudeArgs({ model, effort, auth = "subscription", write = false, editRules = [], maxBudgetUsd = null }) {
  if (!CLAUDE_AUTH_MODES.includes(auth)) throw new Error(`unsupported Claude auth mode: ${auth}`);
  if (write && !editRules.length) throw new Error("a Claude write run needs edit rules");
  const args = auth === "api" ? ["--bare"] : [];
  args.push("--restricted", "--strict-mcp-config", "--disable-slash-commands", "--print", "--output-format", "json",
    "--no-session-persistence", "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--settings", JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
    "--tools", write ? WRITE_TOOLS : READ_TOOLS,
    "--allowedTools", [READ_TOOLS, ...(write ? editRules : [])].join(","),
    "--disallowedTools", "mcp__*,Agent");
  if (maxBudgetUsd != null) args.push("--max-budget-usd", String(maxBudgetUsd));
  args.push("--model", model, "--effort", effort);
  return args;
}

/** Generated prompt section for Claude runs; the frozen prompt files stay unchanged. */
export function claudeEnvironmentNote(write) {
  return ["## Worker environment",
    write
      ? "You can read and edit files. You have no shell and cannot run commands, tests or builds. The lead runs the checks. In your report, list each required check with result `not-run`."
      : "You can read files. You have no shell and cannot run commands, tests or builds."].join("\n");
}

function failureHint(result, failures) {
  if (result.subtype === "error_max_budget_usd") return "budget";
  const text = failures.join("\n");
  if (/usage[_ ]limit|rate[_ ]limit|limit reached/i.test(text)) return "quota";
  if (/not logged in|\/login|authenticat|oauth token|invalid api key|credential/i.test(text)) return "auth";
  return null;
}

export function readClaudeOutput(output) {
  const events = { thread_id: null, turns_completed: 0, usage: {}, failures: [], warnings: 0, cost_usd: null, hint: null };
  let result;
  try { result = JSON.parse(output); } catch { return { events, finalMessage: null }; }
  if (result?.type !== "result") return { events, finalMessage: null };
  events.thread_id = result.session_id ?? null;
  events.usage = result.usage ?? {};
  const cost = Number(result.total_cost_usd);
  if (result.total_cost_usd != null && Number.isFinite(cost)) events.cost_usd = cost;
  const message = typeof result.result === "string" ? result.result : null;
  if (result.subtype === "success" && result.is_error === false && message?.trim()) {
    events.turns_completed = 1;
    return { events, finalMessage: message };
  }
  const errors = Array.isArray(result.errors) ? result.errors.filter((error) => typeof error === "string" && error.trim()) : [];
  events.failures = errors.length ? errors : [message || result.subtype || "No Claude result text"];
  events.hint = failureHint(result, events.failures);
  return { events, finalMessage: events.failures.join("\n") };
}
