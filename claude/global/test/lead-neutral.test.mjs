// The lead (orchestrator) is whichever model the user selected for the session, so lead-side
// instruction text must name the role, never a model.
//
//   node --test claude/global/test/lead-neutral.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const GUARD = /\b(Opus|Fable|Sonnet|Haiku)\b/;

const INSTRUCTION_FILES = [
  "claude/global/CLAUDE.orchestration.md",
  "shared/ROUTING_POLICY.md",
  "claude/CLAUDE.md",
  ...fs.readdirSync(path.join(REPO, "claude")).filter((n) => /^ROLE_.*\.md$/.test(n)).map((n) => `claude/${n}`),
  ...fs.readdirSync(path.join(REPO, "claude", "global", "agents")).map((n) => `claude/global/agents/${n}`)
];

test("lead-side instruction files name no lead model", () => {
  for (const rel of INSTRUCTION_FILES) {
    const hit = fs.readFileSync(path.join(REPO, rel), "utf8").split("\n").findIndex((line) => GUARD.test(line));
    assert.equal(hit, -1, `${rel}:${hit + 1}`);
  }
});

test("synthesis role file is named for the lead", () => {
  assert.ok(fs.existsSync(path.join(REPO, "claude", "ROLE_LEAD_SYNTHESIS.md")));
  assert.equal(fs.existsSync(path.join(REPO, "claude", "ROLE_OPUS_SYNTHESIS.md")), false);
});

const USER_DOCS = ["README.md", "claude/GLOBAL_INSTALL.md", "claude/BOOTSTRAP.md", "claude/EXAMPLE_WORKFLOWS.md", "shared/README.md", "shared/MANUAL_SETUP.md"];

test("user docs name the lead by role", () => {
  for (const rel of USER_DOCS) {
    const lines = fs.readFileSync(path.join(REPO, rel), "utf8").split("\n");
    // The one allowed mention is a statement of what the kit was tested with.
    const hit = lines.findIndex((line) => GUARD.test(line) && !/tested with/i.test(line));
    assert.equal(hit, -1, `${rel}:${hit + 1}: ${lines[hit]}`);
  }
});

test("no file references the old names", () => {
  const walk = (dir) => fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : entry.name.endsWith(".mjs") ? [`${dir}/${entry.name}`] : []);
  const files = [...USER_DOCS, "deploy.ps1", "deploy.sh", ...walk("claude/global")].filter((rel) => !rel.endsWith("lead-neutral.test.mjs"));
  for (const rel of files) {
    const text = fs.readFileSync(path.join(REPO, rel), "utf8");
    for (const old of ["opus-usage", "ROLE_OPUS_SYNTHESIS", "CLAUDE.md block"]) {
      assert.equal(text.includes(old), false, `${rel} still mentions ${old}`);
    }
  }
});
