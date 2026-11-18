// Unit tests for the Claude worker backend (claude-backend.mjs) and the Claude quota gate
// (claude-quota.mjs). No real Claude CLI or network: the live usage read hits a local stub server.
//
//   node --test claude/global/test/claude-quota.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { buildClaudeArgs, claudeWorkerEnv, editRulesFor, protectedTouched, readClaudeOutput } from "../../../runtime/scripts/claude-backend.mjs";
import {
  claudeOngoing, evaluateApiGate, evaluateSubscriptionGate, loadClaudeQuotaRules, parseUsageResponse,
  readRejectionOverride, readSubscriptionSnapshot
} from "../../../runtime/scripts/claude-quota.mjs";

const ROLES = ["astra-review", "astra-investigate", "luna-implement", "sol-implement"];
const NOW = Date.parse("2026-11-17T12:00:00Z");
const SEC = (iso) => Date.parse(iso) / 1000;

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const subRules = { windowMinutes: 300, readTimeoutMs: 2000, sevenDayMinRemaining: 10,
  roles: { "astra-review": 15, "astra-investigate": 15, "luna-implement": 10, "sol-implement": 20 } };
const apiRules = { windowMinutes: 1440, budgetUsd: 10,
  roles: { "astra-review": 1, "astra-investigate": 1.5, "luna-implement": 2, "sol-implement": 3 } };

// R4: editable_paths become CLI-enforced Edit rules; unsafe entries fail before submission.
test("editRulesFor maps directories, files and globs and rejects unsafe entries", (t) => {
  const cwd = tmp(t, "edit-rules-");
  fs.mkdirSync(path.join(cwd, "lib"));
  assert.deepEqual(editRulesFor(["src/", "lib", "./docs/readme.md", "test/**/*.mjs", "src\\"], cwd).rules,
    ["Edit(./src/**)", "Edit(./lib/**)", "Edit(./docs/readme.md)", "Edit(./test/**/*.mjs)"]);
  for (const [entries, message] of [
    [[], /empty/], [["/etc/passwd"], /relative/], [["C:/x"], /relative/], [["~/x"], /relative/],
    [["src/../.."], /'\.\.'/], [["a b"], /whitespace/], [["a,b"], /comma/], [["Edit(x)"], /parenthesis/], [["./"], /whole working directory/],
    [["*"], /matches the whole working directory/], [["**"], /matches the whole working directory/], [["./**/*"], /matches the whole working directory/],
    [["*/?"], /matches the whole working directory/], [["src/", ".git/hooks"], /reaches \.git or \.claude/], [[".claude"], /reaches/],
    [["pkg/.GIT/config"], /reaches/],
    [[".g*/hooks"], /could match/], [["?claude/x"], /could match/], [["*t/config"], /could match/], [["pkg/.CL*"], /could match/],
    [[".[Gg]it/config"], /uses \[, \], \{, \}, : or ~/], [["{.git}/x"], /uses \[/], [["[.]git"], /uses \[/], [["src/[]]x"], /uses \[/],
    [[".git:stream"], /uses \[/], [["GIT~1/config"], /uses \[/], [["src/a~b"], /uses \[/],
    [[".git./config"], /ending in a dot/], [["pkg/.CLAUDE.../x"], /ending in a dot/], [[".gi?./x"], /ending in a dot/],
    [["src/.../x"], /ending in a dot/], [["src/*."], /ending in a dot/], [["src/**./x"], /ending in a dot/]
  ]) assert.match(editRulesFor(entries, cwd).error, message, JSON.stringify(entries));
});

// R1, R3: auth decides --bare; write roles get Edit/Write and nothing that runs code.
test("buildClaudeArgs varies by auth mode and role, never allows Bash, MCP or subagents", () => {
  const common = { model: "sonnet", effort: "high" };
  const sub = buildClaudeArgs({ ...common });
  assert.ok(!sub.includes("--bare"));
  assert.equal(buildClaudeArgs({ ...common, auth: "api" })[0], "--bare");
  for (const flag of ["--restricted", "--strict-mcp-config", "--disable-slash-commands"]) assert.ok(sub.includes(flag), flag);
  const value = (args, flag) => args[args.indexOf(flag) + 1];
  assert.deepEqual(JSON.parse(value(sub, "--settings")), { disableAllHooks: true, autoMemoryEnabled: false });
  assert.equal(value(sub, "--tools"), "Read,Glob,Grep");
  assert.equal(value(sub, "--disallowedTools"), "mcp__*,Agent");
  const write = buildClaudeArgs({ ...common, write: true, editRules: ["Edit(./src/**)"] });
  assert.equal(value(write, "--tools"), "Read,Glob,Grep,Edit,Write");
  assert.equal(value(write, "--allowedTools"), "Read,Glob,Grep,Edit(./src/**)");
  const deny = value(write, "--disallowedTools").split(",");
  assert.deepEqual(deny.slice(0, 2), ["mcp__*", "Agent"]);
  for (const rule of ["Edit(**/.git)", "Edit(**/.git/**)", "Edit(**/.GIT/**)", "Edit(**/.Git)", "Edit(**/.claude/**)", "Edit(**/.CLAUDE)", "Edit(**/.ClAuDe/**)",
    "Edit(**/.git.*)", "Edit(**/.gIt.*/**)", "Edit(**/.Claude.*/**)"]) {
    assert.ok(deny.includes(rule), `${rule}: deny rules outrank any glob allow rule, in every letter case and trailing-dot form`);
  }
  assert.equal(deny.length, 2 + (8 + 64) * 4);
  assert.equal(value(sub, "--disallowedTools"), "mcp__*,Agent", "read roles have no edit tools to deny");
  assert.deepEqual(protectedTouched(["src/a.js", ".Claude/settings.json", "pkg/.GIT/hooks/pre-commit", "docs/.github/x", "src/.git../config", "src/.git /config", "src/.claude. ./x"]),
    [".Claude/settings.json", "pkg/.GIT/hooks/pre-commit", "src/.git../config", "src/.git /config", "src/.claude. ./x"]);
  assert.ok(!write.join(" ").match(/Bash|PowerShell|WebFetch/));
  assert.ok(!sub.includes("--max-budget-usd"));
  assert.equal(value(buildClaudeArgs({ ...common, auth: "api", maxBudgetUsd: 2 }), "--max-budget-usd"), "2");
  assert.throws(() => buildClaudeArgs({ ...common, write: true }), /edit rules/);
  assert.throws(() => buildClaudeArgs({ ...common, auth: "oauth" }), /unsupported/);
});

// R1, R5: subscription runs drop API keys; every run disables CLAUDE.md, memory and built-in agents.
test("claudeWorkerEnv strips the other mode's credentials and sets the isolation variables", () => {
  const sub = claudeWorkerEnv("subscription");
  const api = claudeWorkerEnv("api");
  assert.ok(sub.unset.includes("ANTHROPIC_API_KEY") && !sub.unset.includes("CLAUDE_CODE_OAUTH_TOKEN"));
  assert.ok(api.unset.includes("CLAUDE_CODE_OAUTH_TOKEN") && !api.unset.includes("ANTHROPIC_API_KEY"));
  for (const env of [sub, api]) {
    assert.ok(env.unset.includes("ANTHROPIC_BASE_URL") && env.unset.includes("CLAUDECODE"));
    assert.deepEqual(env.set, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1" });
  }
});

test("readClaudeOutput records cost and classifies budget, quota and auth failures", () => {
  const ok = readClaudeOutput(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.42 }));
  assert.equal(ok.events.cost_usd, 0.42);
  const fail = (extra) => readClaudeOutput(JSON.stringify({ type: "result", is_error: true, ...extra })).events.hint;
  assert.equal(fail({ subtype: "error_max_budget_usd" }), "budget");
  assert.equal(fail({ subtype: "error_during_execution", errors: ["Claude AI usage limit reached|1794639600"] }), "quota");
  assert.equal(fail({ subtype: "error_during_execution", errors: ["Not logged in · Please run /login"] }), "auth");
  assert.equal(fail({ subtype: "error_during_execution", errors: ["something else"] }), null);
});

test("parseUsageResponse reads five_hour/seven_day and the limits[] form", () => {
  assert.deepEqual(parseUsageResponse({ five_hour: { utilization: 42, resets_at: "2026-11-17T15:00:00Z" }, seven_day: { utilization: 7.5, resets_at: null } }),
    { fiveHour: { usedPercent: 42, resetsAt: SEC("2026-11-17T15:00:00Z") }, sevenDay: { usedPercent: 7.5, resetsAt: null } });
  assert.deepEqual(parseUsageResponse({ limits: [{ kind: "session", percent: 3, resets_at: "2026-11-17T15:00:00Z" }, { kind: "weekly_all", percent: 50 }] }).sevenDay,
    { usedPercent: 50, resetsAt: null });
  assert.match(parseUsageResponse({ seven_day: { utilization: 1 } }).error, /no 5-hour window/);
  // Fail closed on readings that are present but unusable.
  for (const body of [{ five_hour: { utilization: -50 } }, { five_hour: { utilization: 140 } }, { five_hour: { utilization: "abc" } },
    { five_hour: { utilization: 10 }, seven_day: { utilization: -5 } }, { five_hour: { utilization: 10, resets_at: "not a date" } }]) {
    assert.match(parseUsageResponse(body).error, /invalid window/, JSON.stringify(body));
  }
  assert.equal(parseUsageResponse({ five_hour: { utilization: 10 } }).sevenDay, null, "an absent weekly window is reported as null");
});

// R8: same formula as the Codex gate on the 5-hour window, plus a 7-day floor; fails closed.
test("evaluateSubscriptionGate allows, blocks on either window, on a rejection, and when unknown", () => {
  const snap = (five, seven, resets = SEC("2026-11-17T14:00:00Z")) => ({ fiveHour: { usedPercent: five, resetsAt: resets }, sevenDay: seven == null ? null : { usedPercent: seven, resetsAt: resets }, source: "test" });
  const gate = (snapshot, extra = {}) => evaluateSubscriptionGate({ role: "luna-implement", snapshot, override: null, ongoing: [], rules: subRules, nowMs: NOW, ...extra });
  assert.equal(gate(snap(50, 20)).allowed, true);
  assert.match(gate(snap(90, 20)).reason, /5h effective 10% <= 10%/);
  assert.equal(gate(snap(50, 20), { ongoing: [{ reserved: 45 }] }).allowed, false);
  assert.match(gate(snap(10, 95)).reason, /7d remaining 5% <= 10% floor/);
  assert.match(gate(snap(10, null)).reason, /no valid 7-day reading/, "a missing weekly reading blocks by default");
  assert.equal(gate(snap(10, null), { rules: { ...subRules, sevenDayMinRemaining: null } }).allowed, true, "weekly check turned off explicitly");
  assert.match(gate(snap(10, 10, SEC("2026-11-17T11:00:00Z"))).reason, /already reset/, "a reading from a reset window blocks");
  assert.match(gate({ fiveHour: { usedPercent: -50, resetsAt: null }, sevenDay: { usedPercent: 0, resetsAt: null } }).reason, /no valid reading/);
  assert.match(gate(null).reason, /quota unknown/);
  assert.match(gate(snap(0, 0), { override: { resetsAt: SEC("2026-11-17T13:00:00Z") } }).reason, /rejected a request; blocked until 2026-11-17T13:00:00.000Z/);
});

test("claudeOngoing counts only Claude runs of the same auth mode within the window", () => {
  const runs = [
    { run_id: "a", backend: "claude", claude_auth: "subscription", role: "luna-implement", status: "running", started_at: "2026-11-17T11:00:00Z" },
    { run_id: "b", backend: "claude", claude_auth: "api", role: "luna-implement", status: "running", started_at: "2026-11-17T11:00:00Z" },
    { run_id: "c", backend: "exec", role: "luna-implement", status: "running", started_at: "2026-11-17T11:00:00Z" },
    { run_id: "d", backend: "claude", claude_auth: "subscription", role: "astra-review", status: "running", started_at: "2026-11-17T05:00:00Z" },
    { run_id: "e", backend: "claude", role: "astra-review", status: "submitted_background", started_at: "2026-11-17T11:30:00Z" },
    { run_id: "f", backend: "claude", claude_auth: "subscription", role: "astra-review", status: "running", started_at: "2026-11-17T11:00:00Z", quota_gate: { required: 40 } },
    { run_id: "g", backend: "claude", claude_auth: "api", role: "astra-review", status: "running", started_at: "2026-11-17T11:00:00Z", claude_max_budget_usd: 10, quota_gate: { required: 10 } }
  ];
  // A run keeps the amount it was admitted with, whatever this runtime's config says now.
  assert.deepEqual(claudeOngoing(runs, "subscription", subRules, NOW).map((r) => [r.run_id, r.reserved]), [["a", 10], ["f", 40]]);
  assert.deepEqual(claudeOngoing(runs, "api", apiRules, NOW).map((r) => [r.run_id, r.reserved]), [["b", 2], ["e", 1], ["g", 10]], "records without claude_auth are API-key runs");
});

test("evaluateApiGate sums recorded spend, charges unknown cost at the reservation and adds in-flight reservations", () => {
  const run = (id, extra) => ({ run_id: id, backend: "claude", claude_auth: "api", role: "luna-implement", started_at: "2026-11-17T10:00:00Z", ...extra });
  const runs = [
    run("spent", { status: "completed", claude_cost_usd: 3.5 }),
    run("unknown", { status: "failed" }),
    run("abandoned", { status: "abandoned", claude_max_budget_usd: 2 }),
    run("flight", { status: "running" }),
    run("old", { status: "completed", claude_cost_usd: 50, started_at: "2026-11-15T10:00:00Z" }),
    { ...run("sub", { status: "completed", claude_cost_usd: 50 }), claude_auth: "subscription" }
  ];
  // An abandoned run's worker may still be spending: its unknown cost counts its full cap.
  const ok = evaluateApiGate({ role: "astra-review", runs, rules: { ...apiRules, budgetUsd: 12 }, nowMs: NOW });
  assert.deepEqual([ok.allowed, ok.spent, ok.reserved], [true, 7.5, 2]);
  assert.match(ok.reason, /\$12\.00 budget - \$7\.50 spent - \$2\.00 reserved - \$1\.00 needed = \$1\.50/);
  assert.equal(evaluateApiGate({ role: "astra-review", runs, rules: apiRules, nowMs: NOW }).allowed, false);
  // A run capped at $10 by another runtime's config reserves $10 here, not this runtime's $2.
  const bigRun = run("big", { status: "running", claude_max_budget_usd: 10 });
  assert.equal(evaluateApiGate({ role: "astra-review", runs: [bigRun], rules: apiRules, nowMs: NOW }).allowed, false);
});

test("loadClaudeQuotaRules requires the claude block and validates every role and number", (t) => {
  const dir = tmp(t, "claude-quota-rules-");
  const file = path.join(dir, "quota.json");
  const write = (value) => fs.writeFileSync(file, JSON.stringify(value));
  const valid = { claude: { subscription: { roles: subRules.roles }, api: { budget_usd: 10, roles: apiRules.roles } } };
  write(valid);
  const rules = loadClaudeQuotaRules(file, ROLES);
  assert.equal(rules.subscription.windowMinutes, 300);
  assert.equal(rules.api.windowMinutes, 1440);
  for (const [value, message] of [
    [{ roles: {} }, /missing 'claude' block/],
    [{ claude: { ...valid.claude, subscription: { roles: { ...subRules.roles, "luna-test": 5 } } } }, /unknown role 'luna-test'/],
    [{ claude: { ...valid.claude, subscription: { roles: { ...subRules.roles, "sol-implement": 120 } } } }, /sol-implement needs a percent/],
    [{ claude: { ...valid.claude, api: { roles: apiRules.roles } } }, /budget_usd/]
  ]) { write(value); assert.throws(() => loadClaudeQuotaRules(file, ROLES), message); }
});

test("readRejectionOverride finds a recent usage_limit_reached whose reset is still ahead", (t) => {
  const projects = tmp(t, "claude-projects-");
  fs.mkdirSync(path.join(projects, "p"));
  const line = (resetsAt) => JSON.stringify({ type: "assistant", apiError: "usage_limit_reached", apiErrorParams: { rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" } } });
  const file = path.join(projects, "p", "s.jsonl");
  fs.writeFileSync(file, `{"type":"user"}\n${line(SEC("2026-11-17T11:00:00Z"))}\n`);
  assert.equal(readRejectionOverride({ projectsDir: projects, nowMs: NOW }), null, "reset already passed");
  fs.appendFileSync(file, `${line(SEC("2026-11-17T13:30:00Z"))}\n`);
  fs.utimesSync(file, NOW / 1000, NOW / 1000);
  assert.deepEqual(readRejectionOverride({ projectsDir: projects, nowMs: NOW }), { resetsAt: SEC("2026-11-17T13:30:00Z"), file });
  fs.utimesSync(file, NOW / 1000 - 6 * 3600, NOW / 1000 - 6 * 3600);
  assert.equal(readRejectionOverride({ projectsDir: projects, nowMs: NOW }), null, "transcripts older than the window are skipped");
});

// R8, R11: the live read uses the user's own token for one request and never leaks it.
test("readSubscriptionSnapshot reads the live endpoint with the stored login and keeps the token out of results", async (t) => {
  const config = tmp(t, "claude-config-");
  const token = "sk-ant-oat-test-token";
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ auth: req.headers.authorization, beta: req.headers["anthropic-beta"], url: req.url });
    res.writeHead(req.headers.authorization === `Bearer ${token}` ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify({ five_hour: { utilization: 30, resets_at: "2026-11-17T15:00:00Z" }, seven_day: { utilization: 60, resets_at: "2026-11-20T00:00:00Z" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const env = { CLAUDE_CONFIG_DIR: config, CLAUDE_USAGE_URL: `http://127.0.0.1:${server.address().port}/api/oauth/usage` };
  const credentials = (oauth) => fs.writeFileSync(path.join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth }));

  credentials({ accessToken: token, expiresAt: NOW + 3600_000 });
  const live = await readSubscriptionSnapshot({ readTimeoutMs: 2000, env, nowMs: NOW });
  assert.deepEqual(live.snapshot, { fiveHour: { usedPercent: 30, resetsAt: SEC("2026-11-17T15:00:00Z") }, sevenDay: { usedPercent: 60, resetsAt: SEC("2026-11-20T00:00:00Z") }, source: "live (credentials file)" });
  assert.deepEqual(seen[0], { auth: `Bearer ${token}`, beta: "oauth-2025-04-20", url: "/api/oauth/usage" });

  credentials({ accessToken: token, expiresAt: NOW - 1 });
  const expired = await readSubscriptionSnapshot({ readTimeoutMs: 2000, env, nowMs: NOW });
  assert.equal(expired.snapshot, null);
  assert.match(expired.errors[0], /expired/);
  assert.equal(seen.length, 1, "an expired token is never sent");

  fs.rmSync(path.join(config, ".credentials.json"));
  assert.match((await readSubscriptionSnapshot({ readTimeoutMs: 2000, env, nowMs: NOW })).errors[0], /no credentials file/);

  credentials({ accessToken: token });
  const remote = await readSubscriptionSnapshot({ readTimeoutMs: 2000, env: { ...env, CLAUDE_USAGE_URL: "https://example.com/usage" }, nowMs: NOW });
  assert.match(remote.errors[0], /only point at localhost/);
  // A malformed or truncated credentials file never echoes its content (JSON.parse messages quote input).
  const leaks = [];
  for (const text of [`{"claudeAiOauth":{"accessToken":"${token}"`, token, `${token}{}`]) {
    fs.writeFileSync(path.join(config, ".credentials.json"), text);
    const result = await readSubscriptionSnapshot({ readTimeoutMs: 2000, env, nowMs: NOW });
    assert.match(result.errors[0], /is not valid JSON/);
    leaks.push(result);
  }
  for (const result of [live, expired, remote, ...leaks]) assert.ok(!JSON.stringify(result).includes(token.slice(0, 10)));

  // CLAUDE_CODE_OAUTH_TOKEN overrides the file for the worker, so the gate must read that account too.
  const envToken = "sk-ant-oat-env-account";
  credentials({ accessToken: token });
  const fromEnv = await readSubscriptionSnapshot({ readTimeoutMs: 2000, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: envToken }, nowMs: NOW });
  assert.equal(seen.at(-1).auth, `Bearer ${envToken}`);
  assert.equal(fromEnv.snapshot, null, "the stub only accepts the file token, so the env account's usage is not borrowed");
  assert.match(fromEnv.errors[0], /answered 401/);

  const snapshotFile = path.join(config, "snap.json");
  fs.writeFileSync(snapshotFile, JSON.stringify({ fiveHour: { usedPercent: 5 }, sevenDay: { usedPercent: 1 } }));
  assert.equal((await readSubscriptionSnapshot({ readTimeoutMs: 2000, env: { ...env, CLAUDE_QUOTA_SNAPSHOT: snapshotFile } })).snapshot.fiveHour.usedPercent, 5);
});
