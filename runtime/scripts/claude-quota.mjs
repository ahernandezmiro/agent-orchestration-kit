// Claude quota gate for claude-delegate.mjs. Same contract as the Codex gate (quota-gate.mjs):
// deterministic, fails closed, exit 5 when blocked, reservations for runs in flight.
//
// Subscription mode (default) reads the account's 5-hour and 7-day usage. Sources, in order:
//   1. CLAUDE_QUOTA_SNAPSHOT=<file.json>  test/override hook:
//      { fiveHour: { usedPercent, resetsAt }, sevenDay: { usedPercent, resetsAt } } (resetsAt: epoch s)
//   2. live: GET https://api.anthropic.com/api/oauth/usage with the user's own Claude Code login
//      token (undocumented endpoint used by Anthropic's clients and usage monitors). The token is
//      read from Claude Code's credentials file into memory for this one request; it is never
//      written, logged or refreshed.
//   No source -> blocked. Override, checked first: a Claude Code transcript that recorded a
//   usage_limit_reached rejection whose reset time is still ahead blocks until that time.
// API-key mode gates on a local dollar budget built from each run's total_cost_usd estimate.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ONGOING_STATUSES = ["running", "submitted_background"];
const FINAL_STATUSES = ["completed", "failed", "cancelled", "git_guard_violation", "abandoned"];
const SUBSCRIPTION_WINDOW_MINUTES = 300;
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

function isNumber(value, min, max = Infinity) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Load the `claude` block of config/quota.json.
 * Input: file path, Claude role names. Output: { subscription, api } rules. Throws naming the file.
 */
export function loadClaudeQuotaRules(file, roleNames) {
  if (!fs.existsSync(file)) throw new Error(`quota config not found: ${file} (re-run the deploy script)`);
  let config;
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`invalid JSON in ${file}: ${e.message}`); }
  const claude = config.claude;
  if (!claude || typeof claude !== "object") throw new Error(`${file}: missing 'claude' block (re-run the deploy script)`);
  const roles = (block, label, max) => {
    const values = claude[block]?.roles ?? {};
    for (const name of Object.keys(values)) if (!roleNames.includes(name)) throw new Error(`${file}: claude.${block} has unknown role '${name}'`);
    for (const name of roleNames) {
      if (!isNumber(values[name], 0, max)) throw new Error(`${file}: claude.${block}.roles.${name} needs ${label} (got ${JSON.stringify(values[name])})`);
    }
    return values;
  };
  const sub = claude.subscription ?? {};
  const api = claude.api ?? {};
  const rules = {
    subscription: {
      windowMinutes: SUBSCRIPTION_WINDOW_MINUTES,
      readTimeoutMs: sub.read_timeout_ms ?? 10000,
      // null turns the weekly check off explicitly (for plans without a weekly limit); a missing
      // key keeps the default, and then a missing weekly reading blocks.
      sevenDayMinRemaining: Object.hasOwn(sub, "seven_day_min_remaining") ? sub.seven_day_min_remaining : 10,
      roles: roles("subscription", "a percent between 0 and 100", 100)
    },
    api: {
      windowMinutes: api.window_minutes ?? 1440,
      budgetUsd: api.budget_usd,
      roles: roles("api", "a dollar amount >= 0")
    }
  };
  if (!Number.isInteger(rules.subscription.readTimeoutMs) || rules.subscription.readTimeoutMs < 1000) throw new Error(`${file}: claude.subscription.read_timeout_ms must be an integer >= 1000`);
  if (rules.subscription.sevenDayMinRemaining !== null && !isNumber(rules.subscription.sevenDayMinRemaining, 0, 100)) {
    throw new Error(`${file}: claude.subscription.seven_day_min_remaining must be a percent between 0 and 100, or null to turn the weekly check off`);
  }
  if (!Number.isInteger(rules.api.windowMinutes) || rules.api.windowMinutes < 1) throw new Error(`${file}: claude.api.window_minutes must be a positive integer`);
  if (!isNumber(rules.api.budgetUsd, 0)) throw new Error(`${file}: claude.api.budget_usd must be a dollar amount >= 0`);
  return rules;
}

function epochSeconds(value) {
  if (value == null) return null;
  if (typeof value === "number") return value > 1e12 ? Math.floor(value / 1000) : value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

// A window reading, or INVALID when present but unusable (non-numeric or outside 0-100 %).
const INVALID = Symbol("invalid");
function readWindow(window) {
  if (window == null) return null;
  const raw = window.utilization ?? window.used_percentage ?? window.usedPercent ?? window.percent;
  const used = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return INVALID;
  const resetsRaw = window.resets_at ?? window.resetsAt;
  const resetsAt = epochSeconds(resetsRaw);
  if (resetsRaw != null && resetsAt == null) return INVALID;
  return { usedPercent: used, resetsAt };
}

/**
 * Normalize an /api/oauth/usage response or a snapshot override.
 * Input: parsed JSON. Output: { fiveHour, sevenDay|null } or { error }.
 * A window that is present but unusable makes the whole reading unusable (fail closed); an
 * absent weekly window is reported as null and judged by the gate's configuration.
 */
export function parseUsageResponse(body) {
  const limits = Array.isArray(body?.limits) ? body.limits : [];
  const byKind = (kind) => limits.find((l) => l?.kind === kind);
  const fiveHour = readWindow(body?.five_hour ?? body?.fiveHour ?? byKind("session"));
  const sevenDay = readWindow(body?.seven_day ?? body?.sevenDay ?? byKind("weekly_all"));
  if (fiveHour === INVALID || sevenDay === INVALID) return { error: "usage reading has an invalid window (utilization outside 0-100 or bad reset time)" };
  if (!fiveHour) return { error: "usage reading has no 5-hour window" };
  return { fiveHour, sevenDay };
}

function credentialsFile(env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), ".credentials.json");
}

// Tests point the live read at a local stub; the token is never sent anywhere else.
function usageUrl(env) {
  const override = env.CLAUDE_USAGE_URL;
  if (!override) return CLAUDE_USAGE_URL;
  const url = new URL(override);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("CLAUDE_USAGE_URL may only point at localhost");
  return url.href;
}

/**
 * The login token the worker itself will use, in Claude Code's order: CLAUDE_CODE_OAUTH_TOKEN
 * overrides stored credentials, so the gate reads the same account the worker draws on.
 * Output: { token, source } or throws an Error whose message never contains credential text.
 */
function loginToken(env, nowMs) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return { token: env.CLAUDE_CODE_OAUTH_TOKEN.trim(), source: "env" };
  const file = credentialsFile(env);
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { throw new Error(e.code === "ENOENT" ? `no credentials file at ${file} (keychain storage or not logged in)` : `credentials file at ${file} is not readable`); }
  let oauth;
  // JSON.parse messages quote the input; never surface them for this file.
  try { oauth = JSON.parse(text)?.claudeAiOauth ?? {}; } catch { throw new Error(`credentials file at ${file} is not valid JSON`); }
  text = null;
  if (typeof oauth.accessToken !== "string" || !oauth.accessToken) throw new Error("no subscription login in the credentials file");
  if (oauth.expiresAt != null && !(Number(oauth.expiresAt) > nowMs)) throw new Error("login token expired; run any claude command to refresh it");
  return { token: oauth.accessToken, source: "file" };
}

async function readLiveUsage({ timeoutMs, env, nowMs }) {
  let { token, source } = loginToken(env, nowMs);
  let response;
  try {
    response = await fetch(usageUrl(env), {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } finally { token = null; }
  if (!response.ok) throw new Error(`usage endpoint answered ${response.status}`);
  let body;
  try { body = await response.json(); } catch { throw new Error("usage endpoint answered with invalid JSON"); }
  const parsed = parseUsageResponse(body);
  if (parsed.error) throw new Error(parsed.error);
  return { ...parsed, source: `live (${source === "env" ? "CLAUDE_CODE_OAUTH_TOKEN" : "credentials file"})` };
}

/**
 * Read the subscription usage from the first source that answers.
 * Input: { readTimeoutMs, env, nowMs }. Output: Promise<{ snapshot|null, errors }>.
 */
export async function readSubscriptionSnapshot({ readTimeoutMs, env = process.env, nowMs = Date.now() }) {
  const errors = [];
  if (env.CLAUDE_QUOTA_SNAPSHOT) {
    try {
      let s;
      try { s = JSON.parse(fs.readFileSync(env.CLAUDE_QUOTA_SNAPSHOT, "utf8")); } catch { throw new Error("not a readable JSON file"); }
      const parsed = parseUsageResponse(s);
      if (parsed.error) throw new Error(parsed.error);
      return { snapshot: { ...parsed, source: `file:${env.CLAUDE_QUOTA_SNAPSHOT}` }, errors };
    } catch (e) {
      errors.push(`CLAUDE_QUOTA_SNAPSHOT: ${e.message}`);
      return { snapshot: null, errors };
    }
  }
  try {
    return { snapshot: await readLiveUsage({ timeoutMs: readTimeoutMs, env, nowMs }), errors };
  } catch (e) {
    errors.push(`live: ${e.name === "TimeoutError" ? `no answer within ${readTimeoutMs} ms` : e.message}`);
  }
  return { snapshot: null, errors };
}

/**
 * Latest subscription rejection still in force, from Claude Code transcripts.
 * Input: { projectsDir, nowMs }. Output: { resetsAt, file } or null.
 * Only top-level transcripts modified within the last 5 hours are read, newest first, at most 50.
 */
export function readRejectionOverride({ projectsDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects"), nowMs = Date.now() } = {}) {
  const cutoff = nowMs - SUBSCRIPTION_WINDOW_MINUTES * 60 * 1000;
  const files = [];
  let projects = [];
  try { projects = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return null; }
  for (const project of projects) {
    const dir = path.join(projectsDir, project.name);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      try { const mtime = fs.statSync(file).mtimeMs; if (mtime >= cutoff) files.push({ file, mtime }); } catch {}
    }
  }
  let latest = null;
  for (const { file } of files.sort((a, b) => b.mtime - a.mtime).slice(0, 50)) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    if (!text.includes("usage_limit_reached")) continue;
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes("usage_limit_reached")) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const resetsAt = epochSeconds(entry.apiErrorParams?.rate_limit_info?.resetsAt);
      if (entry.apiError === "usage_limit_reached" && resetsAt && resetsAt * 1000 > nowMs && (!latest || resetsAt > latest.resetsAt)) {
        latest = { resetsAt, file };
      }
    }
  }
  return latest;
}

/** Auth mode of a Claude run record; records from before auth modes existed were API-key runs. */
export function claudeAuthOf(run) {
  return run.claude_auth ?? "api";
}

/**
 * What a run reserved when it was admitted, so another runtime's configuration or a later config
 * change cannot shrink it: the per-run dollar cap for API-key runs, else the amount its gate
 * recorded, else (records from before amounts were recorded) the current role setting.
 */
export function recordedReservation(run, rules) {
  for (const value of [claudeAuthOf(run) === "api" ? run.claude_max_budget_usd : null, run.quota_gate?.required]) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return rules.roles[run.role] ?? 0;
}

/**
 * Claude runs of one auth mode that still hold a reservation.
 * Input: run records, mode, rules for that mode, nowMs. Output: [{ run_id, role, status, started_at, reserved }].
 */
export function claudeOngoing(runs, auth, rules, nowMs = Date.now()) {
  const windowMs = rules.windowMinutes * 60 * 1000;
  return runs
    .filter((r) => r.backend === "claude" && claudeAuthOf(r) === auth && ONGOING_STATUSES.includes(r.status)
      && nowMs - Date.parse(r.started_at || 0) < windowMs)
    .map((r) => ({ run_id: r.run_id, role: r.role, status: r.status, started_at: r.started_at, reserved: recordedReservation(r, rules) }));
}

/**
 * Subscription gate. Pure.
 * Input: { role, snapshot|null, override|null, ongoing, rules, nowMs }.
 * Output: { allowed, role, required, remaining, reserved, effective, seven_day_remaining, reason }.
 */
export function evaluateSubscriptionGate({ role, snapshot, override, ongoing, rules, nowMs = Date.now() }) {
  const required = rules.roles[role];
  const reserved = ongoing.reduce((sum, r) => sum + r.reserved, 0);
  const base = { role, required, reserved, remaining: null, effective: null, seven_day_remaining: null };
  if (override) {
    return { ...base, allowed: false, reason: `subscription rejected a request; blocked until ${new Date(override.resetsAt * 1000).toISOString()}` };
  }
  const valid = (w) => w && typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100;
  if (!valid(snapshot?.fiveHour)) {
    return { ...base, allowed: false, reason: "quota unknown (no valid reading)" };
  }
  // A reading whose window has already reset no longer describes the current window: fail closed.
  const stale = (w) => w.resetsAt != null && w.resetsAt * 1000 <= nowMs;
  if (stale(snapshot.fiveHour) || (snapshot.sevenDay && stale(snapshot.sevenDay))) {
    return { ...base, allowed: false, reason: "quota unknown (reading is from a window that has already reset)" };
  }
  const weeklyChecked = rules.sevenDayMinRemaining !== null;
  if (weeklyChecked && !valid(snapshot.sevenDay)) {
    return { ...base, allowed: false, reason: "quota unknown (no valid 7-day reading; set seven_day_min_remaining to null if the plan has no weekly limit)" };
  }
  const remaining = 100 - snapshot.fiveHour.usedPercent;
  const effective = remaining - reserved;
  const sevenDayRemaining = snapshot.sevenDay ? 100 - snapshot.sevenDay.usedPercent : null;
  const result = { ...base, remaining, effective, seven_day_remaining: sevenDayRemaining };
  if (effective - required <= 0) return { ...result, allowed: false, reason: `5h effective ${effective}% <= ${required}% required` };
  if (weeklyChecked && sevenDayRemaining <= rules.sevenDayMinRemaining) {
    return { ...result, allowed: false, reason: `7d remaining ${sevenDayRemaining}% <= ${rules.sevenDayMinRemaining}% floor` };
  }
  return { ...result, allowed: true, reason: `5h effective ${effective}% > ${required}% required${sevenDayRemaining == null ? "" : `, 7d remaining ${sevenDayRemaining}%`}` };
}

/**
 * API-key spend gate. Pure.
 * Input: { role, runs, rules, nowMs }. Output: { allowed, role, required, budget, spent, reserved, reason, ongoing }.
 * spent: recorded cost of finalized API-key runs started within the window; a run with no
 * recorded cost counts its role's reservation.
 */
export function evaluateApiGate({ role, runs, rules, nowMs = Date.now() }) {
  const windowMs = rules.windowMinutes * 60 * 1000;
  const inWindow = runs.filter((r) => r.backend === "claude" && claudeAuthOf(r) === "api" && nowMs - Date.parse(r.started_at || 0) < windowMs);
  const spent = inWindow.filter((r) => FINAL_STATUSES.includes(r.status))
    // Unknown cost (including abandoned runs, whose worker may still be spending) counts the
    // run's full reservation.
    .reduce((sum, r) => sum + (Number.isFinite(r.claude_cost_usd) ? r.claude_cost_usd : recordedReservation(r, rules)), 0);
  const ongoing = claudeOngoing(runs, "api", rules, nowMs);
  const reserved = ongoing.reduce((sum, r) => sum + r.reserved, 0);
  const required = rules.roles[role];
  const left = rules.budgetUsd - spent - reserved - required;
  const money = (n) => `$${n.toFixed(2)}`;
  const allowed = left >= 0;
  return { allowed, role, required, budget: rules.budgetUsd, spent: Number(spent.toFixed(4)), reserved, ongoing,
    reason: `${money(rules.budgetUsd)} budget - ${money(spent)} spent - ${money(reserved)} reserved - ${money(required)} needed = ${money(left)}` };
}

/** One-line verdict for the terminal. */
export function formatClaudeGateLine(auth, decision, snapshot, ongoing) {
  const head = decision.allowed ? "QUOTA GATE: OK" : "QUOTA GATE: BLOCKED";
  const counts = {};
  for (const r of ongoing) counts[r.role] = (counts[r.role] ?? 0) + 1;
  const ongoingText = Object.entries(counts).map(([role, n]) => `${n}x ${role}`).join(", ") || "none";
  if (auth === "api") return `${head} backend=claude auth=api role=${decision.role} — ${decision.reason} (ongoing: ${ongoingText})`;
  const resets = (w) => (w?.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : "unknown");
  return `${head} backend=claude auth=subscription role=${decision.role} — ${decision.reason}; 5h remaining=${decision.remaining ?? "?"}% reserved=${decision.reserved}% resets=${resets(snapshot?.fiveHour)}; 7d remaining=${decision.seven_day_remaining ?? "?"}% resets=${resets(snapshot?.sevenDay)} (ongoing: ${ongoingText}) source=${snapshot?.source ?? "none"}`;
}
