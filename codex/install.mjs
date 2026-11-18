#!/usr/bin/env node
// Install the Codex lead skill and its local gateway without changing Codex settings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deploymentRecord, installRuntime } from "../runtime/install-runtime.mjs";
import { preflightReporter, runtimePreflight } from "../runtime/preflight.mjs";

const kit = fileURLToPath(new URL("../", import.meta.url));
const skill = path.join(os.homedir(), ".agents", "skills", "orchestration-kit");
const runtime = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "orchestration");
const skillFile = path.join(skill, "SKILL.md");
const agentFile = path.join(skill, "agents", "openai.yaml");
const marker = "<!-- Installed by the orchestration kit. -->";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const runtimeOnly = args.includes("--runtime-only");
const uninstall = args.includes("--uninstall");
const checkOnly = args.includes("--check");

if (args.some((arg) => !["--check", "--dry-run", "--uninstall", "--runtime-only"].includes(arg)) || (uninstall && runtimeOnly)
    || (checkOnly && (uninstall || dryRun))) {
  console.error("Usage: node codex/install.mjs [--check | --dry-run] [--runtime-only | --uninstall]");
  process.exit(2);
}

const installed = !runtimeOnly && fs.existsSync(skillFile) && fs.readFileSync(skillFile, "utf8").includes(marker);
const foreignSkill = !installed && fs.existsSync(skill) && fs.readdirSync(skill).length > 0;

if (checkOnly) {
  // Preflight only: changes nothing.
  console.log("Preflight:");
  const report = preflightReporter();
  runtimePreflight(runtime, report);
  if (!runtimeOnly) report.check("Codex lead skill location", !foreignSkill, foreignSkill ? `${skill} holds a skill the kit did not install` : skill);
  process.exit(report.ok() ? 0 : 1);
}

if (!runtimeOnly && foreignSkill) {
  console.error(`Refusing to overwrite or remove an existing skill at ${skill}`);
  process.exit(2);
}

if (uninstall) {
  if (installed && !dryRun) {
    fs.rmSync(skillFile);
    fs.rmSync(agentFile, { force: true });
    for (const dir of [path.dirname(agentFile), skill]) {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    }
  }
  console.log(`${dryRun ? "Would remove" : "Removed"} Codex lead skill. Gateway and run data remain at ${runtime}.`);
} else {
  const instructions = runtimeOnly ? null : buildSkill();
  console.log(`Gateway: ${runtime}`);
  if (instructions) console.log(`Codex lead skill: ${skillFile}`);
  if (!dryRun) {
    installRuntime(runtime);
    fs.writeFileSync(path.join(runtime, "deployed.json"), JSON.stringify(deploymentRecord(runtime, "codex"), null, 2) + "\n");
    if (instructions) {
      fs.mkdirSync(path.dirname(agentFile), { recursive: true });
      fs.copyFileSync(path.join(kit, "codex", "lead-skill", "agents", "openai.yaml"), agentFile);
      if (!installed || fs.readFileSync(skillFile, "utf8") !== instructions) fs.writeFileSync(skillFile, instructions);
      console.log("Start a new Codex session and invoke $orchestration-kit.");
    }
  }
}

function buildSkill() {
  const template = fs.readFileSync(path.join(kit, "codex", "lead-skill", "SKILL.md"), "utf8");
  return template.replace("{runtime}", () => runtime.split(path.sep).join("/"));
}
