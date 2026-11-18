import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readModelSelection } from "./scripts/delegate.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = path.join(root, "runtime");
const runtimeDirs = ["scripts", "config", "templates", "prompts"];
export const dataDirs = ["runs", "telemetry", "overrides"];

function modelOverrideSource(destination) {
  return [path.join(runtime, "config", "models.local.json"),
    path.join(root, "claude", "global", "config", "models.local.json"),
    path.join(destination, "config", "models.local.json")].find((file) => fs.existsSync(file));
}

// Read exactly the model configuration installRuntime would deploy, without writing any files.
export function deploymentModelSelection(destination) {
  const override = modelOverrideSource(destination);
  return readModelSelection([path.join(runtime, "config", "models.json"), ...(override ? [override] : [])]);
}

export function installRuntime(destination) {
  const targetOverride = path.join(destination, "config", "models.local.json");
  const overrideSource = modelOverrideSource(destination);
  const modelOverride = overrideSource ? fs.readFileSync(overrideSource) : null;

  for (const dir of [...runtimeDirs, "shared", "claude", "codex"]) {
    fs.rmSync(path.join(destination, dir), { recursive: true, force: true });
  }
  for (const dir of runtimeDirs) fs.cpSync(path.join(runtime, dir), path.join(destination, dir), { recursive: true });
  fs.cpSync(path.join(root, "shared"), path.join(destination, "shared"), { recursive: true });
  if (modelOverride) fs.writeFileSync(targetOverride, modelOverride);

  for (const client of ["claude", "codex"]) {
    const docs = path.join(destination, client);
    fs.mkdirSync(docs, { recursive: true });
    for (const entry of fs.readdirSync(path.join(root, client), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) fs.copyFileSync(path.join(root, client, entry.name), path.join(docs, entry.name));
    }
  }
  for (const dir of dataDirs) fs.mkdirSync(path.join(destination, dir), { recursive: true });
}

export function deploymentRecord(destination, client) {
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const commit = git("rev-parse", "HEAD");
  const models = spawnSync(process.execPath, [path.join(destination, "scripts", "codex-delegate.mjs"), "models", "--json"], { encoding: "utf8" });
  // The Claude selection as configured, without the operator's ORCH_CLAUDE_* overrides of this shell.
  const claudeEnv = { ...process.env };
  delete claudeEnv.ORCH_CLAUDE_MODEL;
  delete claudeEnv.ORCH_CLAUDE_AUTH;
  const claude = spawnSync(process.execPath, [path.join(destination, "scripts", "claude-delegate.mjs"), "models", "--json"], { encoding: "utf8", env: claudeEnv });
  const claudeModels = claude.status === 0 ? JSON.parse(claude.stdout) : null;
  return {
    client,
    commit,
    dirty: commit ? git("status", "--porcelain") !== "" : null,
    deployed_at: new Date().toISOString(),
    host: os.hostname(),
    platform: process.platform,
    models: models.status === 0 ? JSON.parse(models.stdout).roles : null,
    claude: claudeModels ? { auth: claudeModels.auth, roles: claudeModels.roles } : null
  };
}
