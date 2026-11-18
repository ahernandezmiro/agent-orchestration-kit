// Preflight checks shared by every lead's installer: the worker CLIs, logins and model ids the
// runtime at `destination` would use. Changes nothing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveCodexBin, resolveWorkerBin } from "./scripts/exec-backend.mjs";
import { CLAUDE_MIN_VERSION, supportsClaudeVersion } from "./scripts/claude-backend.mjs";
import { deploymentModelSelection } from "./install-runtime.mjs";

/**
 * Reporter that prints one preflight line and remembers failures.
 * Output: { check(label, pass, detail), info(text), ok() }.
 */
export function preflightReporter() {
  let ok = true;
  return {
    check(label, pass, detail) {
      console.log(`  [${pass ? "ok" : "!!"}] ${label}${detail ? ` — ${detail}` : ""}`);
      if (!pass) ok = false;
    },
    info(text) { console.log(`  [info] ${text}`); },
    ok: () => ok
  };
}

/**
 * Check what the runtime at `destination` needs. Codex workers are required (the default worker
 * tier); Claude workers are optional, so their CLI is reported as info.
 * Input: install destination, reporter. Output: { codexBin } for installer-specific follow-ups.
 */
export function runtimePreflight(destination, report) {
  const major = Number(process.versions.node.split(".")[0]);
  report.check("node >= 18", major >= 18, process.version);

  const codexBin = resolveCodexBin();
  report.check("codex CLI", codexBin.ok, codexBin.ok ? `${codexBin.command} (${codexBin.source})` : `${codexBin.reason}: ${codexBin.detail}`);
  // No shell: a shell with arguments triggers DEP0190 on Node 24.
  const login = codexBin.ok ? spawnSync(codexBin.command, [...codexBin.prefixArgs, "login", "status"], { encoding: "utf8", shell: false }) : null;
  const loginOut = login ? `${login.stdout ?? ""}${login.stderr ?? ""}` : "Codex CLI unavailable";
  report.check("codex logged in", Boolean(login && login.status === 0 && /logged in/i.test(loginOut)), loginOut.trim().split("\n").pop());

  let selection = null;
  try {
    selection = deploymentModelSelection(destination);
    report.check("model config (config/models.json + models.local.json)", true);
  } catch (error) {
    report.check("model config (config/models.json + models.local.json)", false, error.message);
  }
  if (selection) {
    const cache = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "models_cache.json");
    let slugs = [];
    try {
      const data = JSON.parse(fs.readFileSync(cache, "utf8"));
      slugs = (data.models ?? data).map((m) => m.slug);
    } catch { /* cache missing until Codex has run once */ }
    for (const model of [...new Set(Object.values(selection.selection).map((role) => role.model))]) {
      report.check(`model id ${model}`, slugs.includes(model), slugs.length ? "" : "models_cache.json not readable; run codex once");
    }
  }

  const claudeEnv = { ...process.env };
  delete claudeEnv.ANTHROPIC_API_KEY;
  const claudeBin = resolveWorkerBin("claude", "CLAUDE_BIN", { env: claudeEnv });
  const claudeAuth = selection?.claude?.auth ?? "subscription";
  if (!claudeBin.ok) report.info(`Claude workers unavailable: claude CLI ${claudeBin.reason} (${claudeBin.detail})`);
  else if (!supportsClaudeVersion(claudeBin.version)) report.info(`Claude workers unavailable: Claude Code ${CLAUDE_MIN_VERSION}+ required (found ${claudeBin.version})`);
  else report.info(`Claude workers ready: ${claudeBin.version}, auth ${claudeAuth}${claudeAuth === "api" && !process.env.ANTHROPIC_API_KEY ? " (ANTHROPIC_API_KEY not set in this shell)" : ""}`);
  return { codexBin };
}
