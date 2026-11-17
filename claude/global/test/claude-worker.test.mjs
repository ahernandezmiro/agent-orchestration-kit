// End-to-end tests for the Claude worker gateway (claude-delegate.mjs) against an installed
// runtime and a stub `claude` binary. Covers auth modes, isolation, edit roles, the quota gate
// and reporting. The stub echoes its arguments, cwd and environment so the tests can check what a
// real Claude Code process would receive.
//
//   node --test claude/global/test/claude-worker.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const review = fileURLToPath(new URL("R001-slug-registry.yaml", import.meta.url));
const stub = `
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  if (process.env.ANTHROPIC_API_KEY) process.exit(99);
  console.log(process.env.TEST_CLAUDE_VERSION || "2.1.286 (Claude Code)");
  process.exit(0);
}
const input = fs.readFileSync(0, "utf8");
const bare = args.includes("--bare");
if (bare ? !process.env.ANTHROPIC_API_KEY : process.env.ANTHROPIC_API_KEY) process.exit(98);
if (process.env.ANTHROPIC_BASE_URL) process.exit(97);
for (const file of (process.env.TEST_EDIT_FILES || "").split(",").filter(Boolean)) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "edited by stub\\n");
}
const mode = process.env.TEST_CLAUDE_FAILURE;
const env = Object.fromEntries(["CLAUDE_CODE_DISABLE_CLAUDE_MDS", "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
  "CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS", "CLAUDE_CODE_OAUTH_TOKEN"].map((k) => [k, process.env[k] ?? null]));
console.log(JSON.stringify({ type: "result", subtype: mode === "budget" ? "error_max_budget_usd" : mode ? "error_during_execution" : "success",
  is_error: Boolean(mode), session_id: "stub-claude", usage: { input_tokens: 3, output_tokens: 5 }, total_cost_usd: 0.25,
  ...(mode ? { errors: mode === "budget" ? [] : ["stub execution failure"] } : { result: "status: completed" }),
  args, input, cwd: process.cwd(), env }));
`;

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orch-claude-worker-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, "codex home");
  const runtime = path.join(codexHome, "orchestration");
  const claudeConfig = path.join(home, ".claude");
  const stubPath = path.join(home, "stub-claude.mjs");
  fs.writeFileSync(stubPath, stub);
  const snapshot = path.join(home, "usage.json");
  const setUsage = (fiveHour, sevenDay = 10) => fs.writeFileSync(snapshot, JSON.stringify({
    fiveHour: { usedPercent: fiveHour, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
    sevenDay: { usedPercent: sevenDay, resetsAt: Math.floor(Date.now() / 1000) + 86400 } }));
  setUsage(20);
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeConfig,
    CLAUDE_BIN: stubPath, ORCH_BACKEND: "exec", ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
    ANTHROPIC_BASE_URL: "https://example.invalid", CLAUDE_QUOTA_SNAPSHOT: snapshot };
  for (const name of ["ORCH_CLAUDE_MODEL", "ORCH_CLAUDE_AUTH", "CLAUDE_USAGE_URL"]) delete env[name];
  const node = (script, args = [], extra = {}) => spawnSync(process.execPath, [script, ...args], {
    cwd: home, env: { ...env, ...extra }, encoding: "utf8", timeout: 30000
  });
  const install = node(path.join(repo, "codex", "install.mjs"), ["--runtime-only"]);
  assert.equal(install.status, 0, install.stdout + install.stderr);

  const project = path.join(home, "project");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "a.txt"), "original\n");
  fs.writeFileSync(path.join(project, "other.txt"), "original\n");
  const git = (...args) => spawnSync("git", ["-C", project, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "init");
  const packet = (role, editable = "[src/]") => {
    const file = path.join(home, `${role}-${Math.random().toString(36).slice(2, 8)}.yaml`);
    fs.writeFileSync(file, [`id: C-${role}`, "objective: change src/a.txt", `editable_paths: ${editable}`,
      "acceptance_criteria:", "  - src/a.txt is edited", "required_checks:", "  - node --test", ""].join("\n"));
    return file;
  };
  const gateway = (name) => (args, extra) => node(path.join(runtime, "scripts", name), args, extra);
  const dispatch = gateway("claude-delegate.mjs");
  const runRecord = (stdout) => JSON.parse(success(dispatch(["show", /DELEGATE: run=(\S+)/.exec(stdout)[1], "--json"])));
  const workerOutput = (run) => JSON.parse(fs.readFileSync(path.join(run.exec.job_dir, "events.jsonl"), "utf8"));
  const events = () => fs.readFileSync(path.join(runtime, "telemetry", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { home, runtime, claudeConfig, project, setUsage, snapshot, packet, dispatch, codex: gateway("codex-delegate.mjs"), runRecord, workerOutput, events, node };
}

function success(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ""));
  return result.stdout;
}

const arg = (args, flag) => args[args.indexOf(flag) + 1];

// R1, R5, R11
test("subscription is the default: no --bare, API key withheld, isolation set, login passed through", (t) => {
  const f = fixture(t);
  const key = "sk-ant-api-should-not-reach";
  const out = success(f.dispatch(["run", "--role", "astra-review", "--packet", review, "--cwd", f.project], { ANTHROPIC_API_KEY: key }));
  assert.match(out, /QUOTA GATE: OK backend=claude auth=subscription role=astra-review/);
  const run = f.runRecord(out);
  const worker = f.workerOutput(run);
  assert.ok(!worker.args.includes("--bare"));
  for (const flag of ["--restricted", "--strict-mcp-config", "--disable-slash-commands"]) assert.ok(worker.args.includes(flag), flag);
  assert.equal(arg(worker.args, "--disallowedTools"), "mcp__*,Agent");
  assert.ok(!worker.args.includes("--max-budget-usd"));
  assert.deepEqual(worker.env, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1", CLAUDE_CODE_OAUTH_TOKEN: "subscription-token" });
  assert.equal(run.claude_auth, "subscription");
  assert.equal(run.model, "sonnet");
  assert.equal(run.quota_gate.allowed, true);
  assert.equal(run.quota_gate.five_hour.usedPercent, 20);
  assert.equal(run.claude_cost_usd, 0.25);
  assert.equal(run.status, "completed");
  const spec = fs.readFileSync(path.join(run.exec.job_dir, "spec.json"), "utf8");
  assert.ok(!spec.includes(key) && !JSON.stringify(run).includes(key));
});

// R1, R8 (API-key mode)
test("API-key mode is opt-in: needs the key, runs bare with a per-run cap and gates on recorded spend", (t) => {
  const f = fixture(t);
  const args = ["run", "--role", "astra-review", "--packet", review, "--cwd", f.project];
  const api = { ORCH_CLAUDE_AUTH: "api" };
  const missing = f.dispatch(args, api);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^claude-delegate: Claude auth is 'api': set ANTHROPIC_API_KEY/);
  const withKey = { ...api, ANTHROPIC_API_KEY: "sk-ant-api-test" };
  const out = success(f.dispatch(args, withKey));
  assert.match(out, /QUOTA GATE: OK backend=claude auth=api role=astra-review — \$10\.00 budget - \$0\.00 spent/);
  const run = f.runRecord(out);
  const worker = f.workerOutput(run);
  assert.equal(worker.args[0], "--bare");
  assert.equal(arg(worker.args, "--max-budget-usd"), "1");
  assert.equal(worker.env.CLAUDE_CODE_OAUTH_TOKEN, null);
  assert.deepEqual([run.claude_auth, run.claude_max_budget_usd, run.claude_cost_usd], ["api", 1, 0.25]);

  const capped = f.dispatch(args, { ...withKey, TEST_CLAUDE_FAILURE: "budget" });
  assert.equal(capped.status, 1);
  assert.equal(f.runRecord(capped.stdout).failure_hint, "budget");

  const quotaFile = path.join(f.runtime, "config", "quota.json");
  const quota = JSON.parse(fs.readFileSync(quotaFile, "utf8"));
  quota.claude.api.budget_usd = 1.4; // two runs at $0.25 recorded, $1 needed
  fs.writeFileSync(quotaFile, JSON.stringify(quota));
  const blocked = f.dispatch(args, withKey);
  assert.equal(blocked.status, 5, blocked.stdout + blocked.stderr);
  assert.match(blocked.stdout, /QUOTA GATE: BLOCKED backend=claude auth=api .* \$0\.50 spent/);
});

// R2, R3, R4, R6, R7
test("Claude implementation roles edit only through rules from editable_paths, with a no-shell note and a scope backstop", (t) => {
  const f = fixture(t);
  const dry = success(f.dispatch(["run", "--role", "luna-implement", "--packet", f.packet("luna-implement"), "--cwd", f.project, "--dry-run"]));
  assert.match(dry, /--tools Read,Glob,Grep,Edit,Write --allowedTools Read,Glob,Grep,Edit\(\.\/src\/\*\*\)/);
  assert.match(dry, /sandbox=edit-rules/);

  const out = success(f.dispatch(["run", "--role", "sol-implement", "--packet", f.packet("sol-implement"), "--cwd", f.project],
    { TEST_EDIT_FILES: "src/b.txt,other.txt" }));
  const run = f.runRecord(out);
  assert.equal(run.model, "opus");
  assert.equal(run.status, "completed");
  assert.deepEqual(run.claude_edit_rules, ["Edit(./src/**)"]);
  assert.deepEqual(run.editable_paths, ["src/"]);
  assert.deepEqual(run.out_of_scope_files, ["other.txt"]);
  assert.match(out, /SCOPE: 1 file\(s\) outside editable_paths: other\.txt/);
  assert.equal(run.git_guard.ok, true);
  assert.equal(path.resolve(f.workerOutput(run).cwd), path.resolve(f.project));
  const prompt = fs.readFileSync(run.prompt_file, "utf8");
  assert.match(prompt, /## Worker environment\nYou can read and edit files\. You have no shell/);
  assert.ok(prompt.indexOf("## Worker environment") < prompt.indexOf("## Task packet"));

  const codexDry = success(f.codex(["run", "--role", "luna-implement", "--packet", f.packet("luna-implement"), "--cwd", f.project, "--dry-run"]));
  const codexPrompt = fs.readFileSync(/DELEGATE: prompt=(.+)/.exec(codexDry)[1].trim(), "utf8");
  assert.ok(!codexPrompt.includes("## Worker environment"), "Codex prompts stay unchanged");
});

// R4, R7: whatever got past the CLI's rules, a change under .claude or inside .git fails the guard.
test("a worker change under .claude or to .git config or hooks fails the git guard with exit 3", (t) => {
  const f = fixture(t);
  for (const [file, reason] of [[".claude/settings.json", "protected_paths"], ["src/.Claude/notes.md", "protected_paths"], [".git/hooks/pre-commit", "git_internals"]]) {
    const result = f.dispatch(["run", "--role", "luna-implement", "--packet", f.packet("luna-implement"), "--cwd", f.project], { TEST_EDIT_FILES: file });
    assert.equal(result.status, 3, `${file}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /GIT GUARD: VIOLATION/);
    const run = f.runRecord(result.stdout);
    assert.equal(run.status, "git_guard_violation");
    assert.ok(run.git_guard.changed.includes(reason), `${file}: ${JSON.stringify(run.git_guard)}`);
    fs.rmSync(path.join(f.project, file), { force: true });
  }
  const clean = success(f.dispatch(["run", "--role", "luna-implement", "--packet", f.packet("luna-implement"), "--cwd", f.project], { TEST_EDIT_FILES: "src/ok.txt" }));
  assert.match(clean, /GIT GUARD: OK \(no commits, branch, ref, remote, stash, config or hook changes\)/);
});

// R2, R4
test("Claude gateway rejects luna-test and unsafe or empty editable_paths before submitting", (t) => {
  const f = fixture(t);
  for (const [role, editable, message] of [
    ["luna-test", "[src/]", /Claude delegation supports luna-implement, sol-implement, astra-review, astra-investigate/],
    ["luna-implement", "[]", /editable_paths is empty/],
    ["luna-implement", "[../outside]", /must not contain '\.\.'/],
    ["luna-implement", "[/etc]", /must be relative/]
  ]) {
    const result = f.dispatch(["run", "--role", role, "--packet", f.packet(role, editable), "--cwd", f.project]);
    assert.equal(result.status, 2, `${role} ${editable}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, message);
  }
  assert.ok(!fs.existsSync(path.join(f.runtime, "runs")) || !fs.readdirSync(path.join(f.runtime, "runs")).some((n) => n.endsWith(".run.json")));
});

// R8 (subscription mode)
test("subscription gate blocks on usage, unknown quota, a recorded rejection and reservations from the other runtime", (t) => {
  const f = fixture(t);
  const args = ["run", "--role", "luna-implement", "--packet", f.packet("luna-implement"), "--cwd", f.project];
  f.setUsage(95);
  const high = f.dispatch(args);
  assert.equal(high.status, 5, high.stdout + high.stderr);
  assert.match(high.stdout, /QUOTA GATE: BLOCKED backend=claude auth=subscription role=luna-implement — 5h effective 5% <= 10% required/);
  const blockedEvent = f.events().find((e) => e.type === "quota_gate_blocked");
  assert.equal(blockedEvent.backend, "claude");

  f.setUsage(10, 95);
  assert.match(f.dispatch(args).stdout, /7d remaining 5% <= 10% floor/);

  fs.writeFileSync(f.snapshot, "not json");
  const unknown = f.dispatch(args);
  assert.equal(unknown.status, 5);
  assert.match(unknown.stdout, /quota unknown/);

  f.setUsage(75);
  const otherRuns = path.join(f.home, ".claude", "orchestration", "runs");
  fs.mkdirSync(otherRuns, { recursive: true });
  fs.writeFileSync(path.join(otherRuns, "other.run.json"), JSON.stringify({ run_id: "other-lead-run", backend: "claude", claude_auth: "subscription",
    role: "sol-implement", status: "running", started_at: new Date().toISOString() }));
  const reserved = f.dispatch(args);
  assert.equal(reserved.status, 5);
  assert.match(reserved.stdout, /5h effective 5% <= 10% required; 5h remaining=25% reserved=20%/);
  fs.rmSync(otherRuns, { recursive: true });

  const transcripts = path.join(f.claudeConfig, "projects", "some-project");
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(path.join(transcripts, "session.jsonl"), JSON.stringify({ type: "assistant", apiError: "usage_limit_reached",
    apiErrorParams: { rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 1800, rateLimitType: "five_hour" } } }) + "\n");
  f.setUsage(0, 0);
  const rejected = f.dispatch(args);
  assert.equal(rejected.status, 5);
  assert.match(rejected.stdout, /subscription rejected a request; blocked until/);

  fs.rmSync(transcripts, { recursive: true });
  const quota = f.dispatch(["quota"]);
  assert.equal(quota.status, 0, quota.stdout + quota.stderr);
  assert.equal(quota.stdout.match(/QUOTA GATE: OK backend=claude auth=subscription/g).length, 4);
});

// R9 and reporting
test("Claude gateway reports its config, names itself in errors, totals usage and splits metrics by auth", (t) => {
  const f = fixture(t);
  const explain = (role, extra) => JSON.parse(success(f.dispatch(["config", "--explain", role, "--cwd", f.project, "--json"], extra)));
  const review = explain("astra-review");
  assert.deepEqual([review.backend, review.model, review.model_source, review.effort, review.auth, review.auth_source],
    ["claude", "sonnet", "config", "high", "subscription", "config"]);
  assert.equal(explain("sol-implement").model, "opus");
  const env = explain("luna-implement", { ORCH_CLAUDE_MODEL: "claude-example", ORCH_CLAUDE_AUTH: "api" });
  assert.deepEqual([env.model, env.model_source, env.auth, env.auth_source], ["claude-example", "env", "api", "env"]);
  assert.equal(JSON.parse(success(f.codex(["config", "--explain", "astra-review", "--cwd", f.project, "--json"]))).backend, "codex");

  const writer = f.dispatch(["config", "--explain", "luna-test", "--cwd", f.project]);
  assert.equal(writer.status, 2);
  assert.match(writer.stderr, /^claude-delegate: Claude delegation supports/);
  assert.match(f.codex(["run"]).stderr, /^codex-delegate: /);
  const badAuth = f.dispatch(["models"], { ORCH_CLAUDE_AUTH: "oauth" });
  assert.equal(badAuth.status, 2);
  assert.match(badAuth.stderr, /ORCH_CLAUDE_AUTH must be one of: subscription, api/);

  const models = JSON.parse(success(f.dispatch(["models", "--json"])));
  assert.equal(models.auth, "subscription");
  assert.deepEqual(Object.keys(models.roles), ["luna-implement", "sol-implement", "astra-review", "astra-investigate"]);

  const launched = success(f.dispatch(["run", "--role", "astra-review", "--packet", fileURLToPath(new URL("R001-slug-registry.yaml", import.meta.url)), "--cwd", f.project, "--background"]));
  const runId = /DELEGATE: run=(\S+)/.exec(launched)[1];
  assert.match(success(f.dispatch(["collect", runId, "--wait"])), /status: completed/);
  assert.match(success(f.dispatch(["result", runId])), /status: completed/);
  assert.match(success(f.dispatch(["collect", runId])), /already finalized/);

  const metrics = JSON.parse(success(f.dispatch(["metrics", "--json"])));
  assert.deepEqual(metrics.claude_usage, { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 });
  assert.equal(metrics.claude_cost_usd, 0.25);
  assert.match(success(f.dispatch(["metrics", "--by", "backend"])), /^claude-subscription\t1\t/m);
});
