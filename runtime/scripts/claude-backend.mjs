// Claude Code print mode adapter for the shared detached runner.

export const CLAUDE_MIN_VERSION = "2.1.286";
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function supportsClaudeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)\b/.exec(version ?? "");
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  const [minMajor, minMinor, minPatch] = CLAUDE_MIN_VERSION.split(".").map(Number);
  return major > minMajor || (major === minMajor && (minor > minMinor || (minor === minMinor && patch >= minPatch)));
}

// Use the direct Anthropic API and avoid forwarding alternate authentication or proxy headers.
export const CLAUDE_ENV_UNSET = [
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_FOUNDRY_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"
];

export function buildClaudeArgs({ model, effort }) {
  const tools = "Read,Glob,Grep";
  return ["--bare", "--restricted", "--print", "--output-format", "json", "--no-session-persistence",
    "--permission-mode", "dontAsk", "--permission-prompts", "none", "--tools", tools,
    "--allowedTools", tools, "--disallowedTools", "mcp__*", "--model", model, "--effort", effort];
}

export function readClaudeOutput(output) {
  const events = { thread_id: null, turns_completed: 0, usage: {}, failures: [], warnings: 0 };
  let result;
  try { result = JSON.parse(output); } catch { return { events, finalMessage: null }; }
  if (result?.type !== "result") return { events, finalMessage: null };
  events.thread_id = result.session_id ?? null;
  events.usage = result.usage ?? {};
  const message = typeof result.result === "string" ? result.result : null;
  if (result.subtype === "success" && result.is_error === false && message?.trim()) {
    events.turns_completed = 1;
    return { events, finalMessage: message };
  }
  const errors = Array.isArray(result.errors) ? result.errors.filter((error) => typeof error === "string" && error.trim()) : [];
  events.failures = errors.length ? errors : [message || result.subtype || "No Claude result text"];
  return { events, finalMessage: events.failures.join("\n") };
}
