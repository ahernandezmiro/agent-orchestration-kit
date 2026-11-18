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
const args = process.argv.slice(2);
if (args.includes("--version")) {
  if (process.env.ANTHROPIC_API_KEY) process.exit(99);
  console.log(process.env.TEST_CLAUDE_VERSION || "2.1.286 (Claude Code)");
  process.exit(0);
}
const input = fs.readFileSync(0, "utf8");
if (!process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_BASE_URL) process.exit(98);
const failed = process.env.TEST_CLAUDE_FAILURE === "1";
console.log(JSON.stringify({ type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed,
  session_id: "stub-claude", usage: { input_tokens: 3, output_tokens: 5 },
  ...(failed ? { errors: ["stub execution failure"] } : { result: "verdict: pass" }), args, input }));
`;

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orch-codex-lead-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, "custom codex home");
  const runtime = path.join(codexHome, "orchestration");
  const skill = path.join(home, ".agents", "skills", "orchestration-kit");
  const stubPath = path.join(home, "stub-claude.mjs");
  fs.writeFileSync(stubPath, stub);
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, CODEX_HOME: codexHome,
    CLAUDE_BIN: stubPath, CODEX_BIN: stubPath, ORCH_BACKEND: "exec", ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "ignored", ANTHROPIC_BASE_URL: "https://example.invalid" };
  delete env.ORCH_CLAUDE_MODEL;
  const node = (script, args = [], extra = {}) => spawnSync(process.execPath, [script, ...args], {
    cwd: home, env: { ...env, ...extra }, encoding: "utf8", timeout: 20000
  });
  return { home, codexHome, runtime, skill, node,
    install: (...args) => node(path.join(repo, "codex", "install.mjs"), args),
    dispatch: (args, extra) => node(path.join(runtime, "scripts", "claude-delegate.mjs"), args, extra) };
}

function success(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ""));
  return result.stdout;
}

test("Codex installer --check reports the shared preflight and a foreign skill, changing nothing", (t) => {
  const f = fixture(t);
  const clean = f.install("--check");
  assert.match(clean.stdout, /Preflight:[\s\S]*\[(ok|!!)\] codex CLI[\s\S]*\[ok\] model config[\s\S]*\[ok\] Codex lead skill location/);
  assert.equal(fs.existsSync(f.runtime), false, "preflight installs nothing");
  fs.mkdirSync(f.skill, { recursive: true });
  fs.writeFileSync(path.join(f.skill, "SKILL.md"), "someone else's skill\n");
  const foreign = f.install("--check");
  assert.equal(foreign.status, 1);
  assert.match(foreign.stdout, /\[!!\] Codex lead skill location — .* holds a skill the kit did not install/);
  assert.equal(f.install("--check", "--dry-run").status, 2, "--check cannot be combined with --dry-run");
});

test("Codex installer stages explicit lead skill and usable gateway, preserving user instructions and run data", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.codexHome);
  const agents = path.join(f.codexHome, "AGENTS.md");
  fs.writeFileSync(agents, "personal instructions\n");
  success(f.install("--dry-run"));
  assert.equal(fs.existsSync(f.skill), false);
  assert.equal(fs.existsSync(f.runtime), false);
  success(f.install());
  const skill = fs.readFileSync(path.join(f.skill, "SKILL.md"), "utf8");
  assert.ok(skill.includes(f.runtime.split(path.sep).join("/")));
  assert.match(fs.readFileSync(path.join(f.skill, "agents", "openai.yaml"), "utf8"), /allow_implicit_invocation: false/);
  const dry = f.node(path.join(f.runtime, "scripts", "codex-delegate.mjs"), ["run", "--role", "astra-review",
    "--packet", review, "--cwd", f.home, "--dry-run"]);
  assert.match(success(dry), /DRY RUN: codex exec/);
  success(f.install());
  success(f.install("--uninstall"));
  assert.equal(fs.existsSync(f.skill), false);
  assert.equal(fs.readFileSync(agents, "utf8"), "personal instructions\n");
  assert.ok(fs.readdirSync(path.join(f.runtime, "runs")).some((name) => name.endsWith(".run.json")));
});

test("Claude Code and Codex install identical runtime assets independently of lead registration", (t) => {
  const f = fixture(t);
  const claudeHome = path.join(f.home, ".claude");
  const claudeRuntime = path.join(claudeHome, "orchestration");
  success(f.node(path.join(repo, "claude", "install.mjs"), ["--runtime-only"]));
  success(f.install("--runtime-only"));

  function files(dir, prefix = "") {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const relative = path.join(prefix, entry.name);
      return entry.isDirectory() ? files(path.join(dir, entry.name), relative) : [relative];
    });
  }
  assert.deepEqual(fs.readdirSync(claudeRuntime), fs.readdirSync(f.runtime));
  assert.deepEqual(files(claudeRuntime), files(f.runtime));
  for (const file of files(f.runtime).filter((file) => file !== "deployed.json")) {
    assert.deepEqual(fs.readFileSync(path.join(claudeRuntime, file)), fs.readFileSync(path.join(f.runtime, file)), file);
  }
  assert.equal(fs.existsSync(f.skill), false);
  assert.deepEqual(fs.readdirSync(claudeHome), ["orchestration"]);

  const packed = success(f.node(path.join(f.runtime, "scripts", "pack-telemetry.mjs"), ["--dry-run"]));
  assert.ok(packed.includes(f.runtime));
});
