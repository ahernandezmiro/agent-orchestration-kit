import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-model-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kit = path.join(dir, "kit");
  for (const name of ["runtime", "claude", "codex", "shared"]) {
    fs.cpSync(path.join(repo, name), path.join(kit, name), {
      recursive: true,
      filter: (file) => !["models.local.json", "runs", "telemetry", "overrides"].includes(path.basename(file))
    });
  }
  const home = path.join(dir, "home");
  const cache = path.join(home, ".codex", "models_cache.json");
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  const runtime = path.join(home, ".claude", "orchestration");
  const files = {
    current: path.join(kit, "runtime", "config", "models.local.json"),
    legacy: path.join(kit, "claude", "global", "config", "models.local.json"),
    installed: path.join(runtime, "config", "models.local.json")
  };
  const base = JSON.parse(fs.readFileSync(path.join(kit, "runtime", "config", "models.json"), "utf8"));
  const stub = path.join(dir, "codex.mjs");
  fs.writeFileSync(stub, `
    const args = process.argv.slice(2);
    if (args.includes("--version")) console.log("stub codex 1");
    else if (args[0] === "login") console.log("Logged in");
    else if (args[0] === "mcp-server") console.log("Usage: codex mcp-server");
    else process.exit(99);
  `);
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home,
    CODEX_HOME: path.join(home, ".codex"), CODEX_BIN: stub, ORCH_BACKEND: "exec" };
  delete env.CODEX_COMPANION;
  const node = (script, args) => spawnSync(process.execPath, [script, ...args], {
    cwd: kit, env, encoding: "utf8", timeout: 30000
  });
  const writeOverride = (source, value) => {
    fs.mkdirSync(path.dirname(files[source]), { recursive: true });
    fs.writeFileSync(files[source], typeof value === "string" ? value : JSON.stringify(value));
  };
  const override = (model) => ({ roles: Object.fromEntries(Object.keys(base.roles).map(role => [role, { model }])) });
  const setCache = (models) => fs.writeFileSync(cache, JSON.stringify({ models: models.map(slug => ({ slug })) }));
  const install = (...args) => node(path.join(kit, "claude", "install.mjs"), args);
  const models = (provider = "codex") => JSON.parse(success(node(path.join(runtime, "scripts", `${provider}-delegate.mjs`), ["models", "--json"]))).roles;
  return { home, runtime, files, base, writeOverride, override, setCache, install, models };
}

function success(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ""));
  return result.stdout;
}

function snapshot(dir) {
  const files = {};
  const visit = (parent) => {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      const file = path.join(parent, entry.name);
      if (entry.isDirectory()) visit(file);
      else files[path.relative(dir, file)] = { bytes: fs.readFileSync(file).toString("base64"), mtime: fs.statSync(file).mtimeMs };
    }
  };
  visit(dir);
  return files;
}

for (const [source, lowerPriority] of [["legacy", ["installed"]], ["current", ["legacy", "installed"]], ["installed", []]]) {
  test(`preflight and deployment agree on ${source} model overrides`, (t) => {
    const f = fixture(t);
    f.writeOverride(source, f.override("custom-model"));
    for (const lower of lowerPriority) f.writeOverride(lower, "{invalid ignored configuration");
    f.setCache(["custom-model"]);
    const before = snapshot(f.home);
    assert.match(success(f.install("--check")), /\[ok\] model id custom-model/);
    assert.deepEqual(snapshot(f.home), before, "preflight must not change the installation");
    success(f.install("--runtime-only"));
    assert.ok(Object.values(f.models()).every(role => role.model === "custom-model"));
  });
}

test("legacy overrides merge with current defaults instead of stale installed defaults", (t) => {
  const f = fixture(t);
  f.writeOverride("legacy", {
    roles: { "astra-review": { model: "review-model", effort: "low" } },
    claude: { roles: { review: { effort: "max" }, "astra-review": { model: "haiku", effort: "low" } } }
  });
  fs.mkdirSync(path.join(f.runtime, "config"), { recursive: true });
  fs.writeFileSync(path.join(f.runtime, "config", "models.json"), JSON.stringify({ roles: { "luna-test": { model: "stale" } } }));
  f.setCache([...Object.values(f.base.roles).map(role => role.model), "review-model"]);
  const checked = success(f.install("--check"));
  assert.match(checked, /\[ok\] model id review-model/);
  assert.doesNotMatch(checked, /model id stale/);
  success(f.install("--runtime-only"));
  assert.deepEqual(f.models(), { ...f.base.roles, review: { model: "review-model", effort: "low" } });
  assert.deepEqual(f.models("claude"), { ...f.base.claude.roles, review: { model: "haiku", effort: "max" } });
});

for (const [label, value, message] of [
  ["invalid JSON", "{invalid", /invalid JSON/],
  ["unknown role", { roles: { unknown: { model: "custom-model" } } }, /unknown role/],
  ["invalid effort", { roles: { "astra-review": { effort: "invalid" } } }, /effort must be/]
]) {
  test(`preflight rejects ${label} in the selected legacy override`, (t) => {
    const f = fixture(t);
    f.writeOverride("legacy", value);
    f.setCache(Object.values(f.base.roles).map(role => role.model));
    const before = snapshot(f.home);
    const result = f.install("--check");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, message);
    if (label !== "invalid effort") assert.ok(result.stdout.includes(f.files.legacy));
    assert.deepEqual(snapshot(f.home), before);
  });
}
