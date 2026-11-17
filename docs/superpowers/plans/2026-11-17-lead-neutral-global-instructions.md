# Lead-Neutral Global Instructions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The kit's lead-side instructions name a role ("the lead"), never a model, and reach Claude Code through a kit-owned `~/.claude/rules/orchestration-kit.md` instead of a block in the user's `CLAUDE.md`.

**Architecture:** A pure generator (`rules-file.mjs`) concatenates three source files into one flat rules file. `install.mjs` writes that file, records its hash, and removes the old managed block from `CLAUDE.md` once. The prompt freeze hashes the generated output.

**Tech Stack:** Node >= 18, ES modules, `node:test`, no dependencies.

**Spec:** `docs/superpowers/specs/2026-11-17-lead-neutral-global-instructions-design.md`

## Global Constraints

- Work on branch `lead-neutral-rules-file`, created from `main`. The branch is not deployable between Task 2 and Task 3.
- Lead vocabulary: "the lead" / "Lead" replaces "Opus", "Opus 5.5", "Claude Opus", "You (Opus)". Luna, Sol, Astra and all role ids stay unchanged.
- The five worker goldens (`claude/global/test/golden/*.golden.md`) must stay byte-identical. After every `prompt-freeze.mjs --update`, run `git diff --exit-code -- "claude/global/test/golden/*.golden.md"` and expect exit 0.
- Do not edit: `ROADMAP.md` history (only the one note in Task 6), `docs/superpowers/**` from before 2026-11-17, `astra_*.md`, `.orchestration/tasks/**`, `claude/ORCHESTRATION_TELEMETRY_PROPOSAL.md`, `codex/prompts/**`.
- The installer never creates, deletes or writes `~/.claude/CLAUDE.md` except to remove the `claude-md` managed block.
- Rules file path: `~/.claude/rules/orchestration-kit.md`. Backups of it: `~/.claude/orchestration/backups/orchestration-kit.md.bak-<stamp>`.
- Guard regex for lead model names: `/\b(Opus|Fable|Sonnet|Haiku)\b/`.
- Tests: `node --test claude/global/test/<file>`; installer tests use a temp `HOME`/`USERPROFILE` (existing `fixture(t)`).

## Review Focus

1. `~/.claude/rules/orchestration-kit.md` exists as a directory: install exits non-zero with a message naming the path, and `CLAUDE.md` is not modified. (Task 3)
2. `deployed.json` missing or not valid JSON while a rules file exists: treated as "no record", so the existing rules file is backed up before overwrite; install succeeds. (Task 3)
3. Kit is not a git checkout (`commit` is `null`): the header says `kit commit unknown` and generation succeeds. (Task 2)
4. `--dry-run`: no rules file, no backup, no `CLAUDE.md` change. (Task 3)
5. `--uninstall` when the rules file is already absent: exits 0. (Task 3)

---

### Task 1: Role-neutral wording in the lead's instruction sources

**Files:**
- Modify: `claude/global/CLAUDE.orchestration.md`, `shared/ROUTING_POLICY.md`, `claude/CLAUDE.md` (only if it names a model), `claude/ROLE_ASTRA_REVIEW.md`, `claude/ROLE_LUNA_DISPATCH.md`, `claude/global/agents/*.md` (body only, if they name the lead)
- Rename: `claude/ROLE_OPUS_SYNTHESIS.md` -> `claude/ROLE_LEAD_SYNTHESIS.md` (`git mv`)
- Create: `claude/global/test/lead-neutral.test.mjs`
- Modify: `claude/global/test/golden/static-prompts.sha256.json` (via `--update`)

**Interfaces:**
- Produces: source files free of lead model names; `ROLE_LEAD_SYNTHESIS.md` at its new path.

- [ ] **Step 1: Write the failing test** in `lead-neutral.test.mjs`

```js
const GUARD = /\b(Opus|Fable|Sonnet|Haiku)\b/;
const FILES = ["claude/global/CLAUDE.orchestration.md", "shared/ROUTING_POLICY.md", "claude/CLAUDE.md",
  ...fs.readdirSync(path.join(REPO, "claude")).filter((n) => /^ROLE_.*\.md$/.test(n)).map((n) => `claude/${n}`),
  ...fs.readdirSync(path.join(REPO, "claude/global/agents")).map((n) => `claude/global/agents/${n}`)];
test("lead-side instruction files name no lead model", () => {
  for (const rel of FILES) {
    const hit = fs.readFileSync(path.join(REPO, rel), "utf8").split("\n").findIndex((l) => GUARD.test(l));
    assert.equal(hit, -1, `${rel}:${hit + 1}`);
  }
});
test("synthesis role file is named for the lead", () => {
  assert.ok(fs.existsSync(path.join(REPO, "claude/ROLE_LEAD_SYNTHESIS.md")));
  assert.equal(fs.existsSync(path.join(REPO, "claude/ROLE_OPUS_SYNTHESIS.md")), false);
});
```

- [ ] **Step 2: Run** `node --test claude/global/test/lead-neutral.test.mjs`. Expected: both FAIL.

- [ ] **Step 3: Reword.** Exact text the spec fixes:
  - `CLAUDE.orchestration.md` title: `# Multi-Model Orchestration (lead + Codex workers)`
  - Its first paragraph starts: `You are the lead: the primary orchestrator.` and points at `ROLE_LEAD_SYNTHESIS.md`.
  - `major_rework`: `substantial lead repair or another worker pass was needed`.
  - Trailer instruction, replacing the current last two lines:
    ```
    End substantive engineering responses with one compact line that names roles, for example:
    `Orchestration: lead → Luna implementation → lead review` or `Orchestration: lead only — delegation not warranted.`
    Write "lead" for your own part. Do not put a model name there.
    ```
  - `ROUTING_POLICY.md` heading: `### Lead — primary orchestrator`, followed by the sentence `The lead is the model the user selected for this session; these rules apply whichever model that is.` `Do not waste Opus by default on:` becomes `Do not spend the lead by default on:`. Table cells `Opus` become `Lead`. Every other "Opus" becomes "the lead" with grammar adjusted; no rule changes meaning.
  - Leave the two `@` import lines in `CLAUDE.orchestration.md` for now (Task 2 removes them).

- [ ] **Step 4: Run** the test again. Expected: PASS.

- [ ] **Step 5: Re-baseline the freeze.** `node claude/global/test/prompt-freeze.mjs --update`, then `git diff --exit-code -- "claude/global/test/golden/*.golden.md"` (expect exit 0), then `node --test claude/global/test/` (expect all pass).

- [ ] **Step 6: Commit** `Name the orchestrator by role in lead-side instructions`.

---

### Task 2: Rules-file generator

**Files:**
- Create: `claude/global/scripts/rules-file.mjs`, `claude/global/test/rules-file.test.mjs`
- Modify: `claude/global/CLAUDE.orchestration.md` (delete the two `@~/.claude/orchestration/...` lines and the blank line they leave doubled)

**Interfaces:**
- Produces, from `rules-file.mjs`:
  - `export const RULES_FILE_NAME = "orchestration-kit.md"`
  - `export const RULES_SOURCES = ["claude/global/CLAUDE.orchestration.md", "shared/ROUTING_POLICY.md", "claude/CLAUDE.md"]` (kit-relative, in output order)
  - `export function buildRulesFile({ kitRoot, commit }) -> string` where `commit` is a string or `null`.

Output format: the header below, a blank line, then each source's text (CRLF and CR normalised to `\n`, trailing whitespace of the file trimmed) joined by one blank line, ending with a single `\n`. Throws `Error` naming the file if a source is missing or contains a line starting with `@`.

```
<!-- Generated by orchestration-kit install.mjs from kit commit <commit or "unknown">. Do not edit: it is overwritten on every deploy.
     Your own instructions belong in ~/.claude/CLAUDE.md or another file in this folder. -->
```

- [ ] **Step 1: Write failing tests** in `rules-file.test.mjs` (build a temp kit root with three small source files for 3–6; use the real repo for 1–2):
  1. `real kit: sources in order, no import lines`: output starts with `<!-- Generated by orchestration-kit install.mjs from kit commit abc1234.`; the first heading of each source appears, in `RULES_SOURCES` order; no line matches `/^@/`.
  2. `real kit: no lead model name`: output does not match the guard regex.
  3. `deterministic and LF-only`: sources written with `\r\n` give output with no `\r`, equal across two calls, ending in exactly one `\n`.
  4. `null commit`: header contains `kit commit unknown.`
  5. `missing source throws` with the file name in the message.
  6. `import line in a source throws` with the file name in the message.

- [ ] **Step 2: Run** `node --test claude/global/test/rules-file.test.mjs`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `rules-file.mjs` and delete the `@` lines from `CLAUDE.orchestration.md`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5:** `node claude/global/test/prompt-freeze.mjs --update`, golden diff check (exit 0), `node --test claude/global/test/` — `install.test.mjs` still passes at this point because the installer is unchanged.
- [ ] **Step 6: Commit** `Generate the lead's rules file from kit sources`.

---

### Task 3: Installer writes the rules file and stops editing CLAUDE.md

**Files:**
- Modify: `claude/global/install.mjs`, `claude/global/test/install.test.mjs`

**Interfaces:**
- Consumes: `buildRulesFile`, `RULES_FILE_NAME` (Task 2); `removeBlock`, `ManagedBlockError` (existing).
- Produces: `deployed.json` gains `rules_file_sha256` (hex sha256 of the written rules file).

Behaviour (spec §3), in this order inside `install()`:
1. Build text with `commit` = short `git rev-parse --short HEAD` of the kit, or `null`.
2. Plan the `CLAUDE.md` migration with `removeBlock(current, "claude-md")` inside a try/catch. A `ManagedBlockError` is remembered, not thrown.
3. If the rules-file path exists and is not a regular file: throw `Error("<path> exists and is not a file")` before any change.
4. Existing steps (managed dirs, agents). Stop copying `CLAUDE.orchestration.md` into `~/.claude/orchestration/claude/` (the `*.md` filter on `claude/` does not include `claude/global/`, so only the explicit `copyFileSync` line goes).
5. Rules file: if content equals new text, do nothing. Otherwise, if the file exists and its sha256 differs from the previous `deployed.json` `rules_file_sha256` (missing or unparseable `deployed.json` counts as no record), copy it to `backups/orchestration-kit.md.bak-<stamp>`; then write. Read the previous `deployed.json` before step 4, and tolerate invalid JSON there.
6. Migration: if step 2 found a block, back up `CLAUDE.md` and write the text without it (an empty result is written as an empty file). If step 2 hit a `ManagedBlockError`, print to stderr `<CLAUDE.md path>: <problem> at line(s) <n>` and `the old block is still in CLAUDE.md; remove it by hand`, and set `process.exitCode = 1` after the install finishes.
7. Settings merge and `deployed.json` as today, plus `rules_file_sha256`.

`uninstall()`: unchanged first step (block removal; malformed markers still abort before anything else), then delete the rules file with `force: true`. Final install message: `Done. Start a NEW Claude Code session so the agents and rules file load.`

- [ ] **Step 1: Rewrite `install.test.mjs`.** Add to `fixture`: `rulesFile = path.join(claude, "rules", "orchestration-kit.md")`. Replace the first four tests and add the rest; keep `AGENTS.md files untouched`, `overrides survive…`, `uninstall without block writes nothing`.
  1. `fresh install, no CLAUDE.md`: status 0; `rulesFile` exists and starts with `<!-- Generated by orchestration-kit`; `claudeMd` does not exist; `deployed.json.rules_file_sha256` equals the file's sha256; `orchestration/claude/CLAUDE.orchestration.md` does not exist.
  2. `CLAUDE.md without a block is not touched`: content `"mine\n"`; after install same bytes, same `mtimeMs`, `backups()` empty.
  3. `current block is removed`: `"mine\n\n" + NEW_BLOCK + "\ntail\n"` becomes `"mine\n\ntail\n"`; exactly one `CLAUDE.md.bak-` file.
  4. `legacy block is removed`: same with `LEGACY_BLOCK`.
  5. `CLAUDE.md holding only the block stays as an empty file`: exists, length 0.
  6. `malformed markers: rules file installed, CLAUDE.md untouched, non-zero exit`: stderr matches `/unmatched-begin/` and includes the path; `rulesFile` exists; `--uninstall` on the same file exits non-zero and leaves `CLAUDE.md` byte-identical.
  7. `second install changes nothing`: `rulesFile` and `settings.json` same content and `mtimeMs`; backup count unchanged.
  8. `hand-edited rules file is backed up`: append a line, reinstall; one file matching `orchestration/backups/orchestration-kit.md.bak-` containing the appended line; `rulesFile` no longer contains it.
  9. `corrupt deployed.json`: write `"{"` to it, reinstall; status 0; existing rules file backed up only if it differs from the new text (so first edit it, as in 8).
  10. `rules path is a directory`: `mkdir rules/orchestration-kit.md`; status non-zero; stderr includes the path; a pre-existing `CLAUDE.md` with a block is byte-identical.
  11. `--dry-run writes nothing`: with a block in `CLAUDE.md`; `rulesFile` absent; `CLAUDE.md` byte-identical; `backups()` empty.
  12. `uninstall removes only the kit's rules file`: put `rules/mine.md` beside it; after `--uninstall`, `rulesFile` gone and `mine.md` byte-identical.
  13. `uninstall with no rules file`: fresh home, `--uninstall` exits 0.

- [ ] **Step 2: Run** `node --test claude/global/test/install.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the behaviour above in `install.mjs`. Update its header comment to describe the rules file.
- [ ] **Step 4: Run** the test file, then the whole folder. Expected: PASS.
- [ ] **Step 5: Commit** `Install the lead's instructions as a rules file, not a CLAUDE.md block`.

---

### Task 4: Freeze the generated rules file

**Files:**
- Modify: `claude/global/test/prompt-freeze.mjs`, `claude/global/test/golden/static-prompts.sha256.json`

**Interfaces:**
- Consumes: `buildRulesFile` (Task 2).
- Produces: manifest key `generated/orchestration-kit.rules.md` = sha256 of `buildRulesFile({ kitRoot: REPO, commit: "<commit>" })` (the literal string `<commit>`).

- [ ] **Step 1: Write the failing test** in `rules-file.test.mjs`: `freeze manifest pins the generated rules file` — the manifest's `generated/orchestration-kit.rules.md` equals the sha256 computed as above.
- [ ] **Step 2: Run it.** Expected: FAIL (key missing).
- [ ] **Step 3: Implement.** In `main()`, add the generated entry to `hashes` after the static files, so check and `--update` both cover it. Update the file's header comment (check 2 now also covers the generated rules file).
- [ ] **Step 4:** `node claude/global/test/prompt-freeze.mjs --update`; golden diff check (exit 0); `node claude/global/test/prompt-freeze.mjs` prints `PROMPT FREEZE: OK`; test from Step 1 passes.
- [ ] **Step 5: Commit** `Pin the generated rules file in the prompt freeze`.

---

### Task 5: `lead-usage.mjs` reports which models led each run

**Files:**
- Rename: `claude/global/scripts/opus-usage.mjs` -> `claude/global/scripts/lead-usage.mjs` (`git mv`)
- Create: `claude/global/test/lead-usage.test.mjs`
- Modify: `claude/global/settings.permissions.json` only if it names `opus-usage`

**Interfaces:**
- Produces: `attribute(windows, usage)` rows gain `lead_models: string[]` — distinct `model` values of the matched usage records, sorted. The text table gains a `lead_models` column (comma-joined). Header comments say "the lead" instead of Opus.

- [ ] **Step 1: Write the failing test**

```js
import { attribute } from "../scripts/lead-usage.mjs";
test("rows list the distinct lead models in the window", () => {
  const windows = [{ run_id: "r1", role: "luna-implement", outcome: "accepted", root: "/repo", from: 1000, to: 5000 }];
  const u = (ts, model, cwd = "/repo") => ({ ts, cwd, model, input: 1, cache_creation: 0, cache_read: 0, output: 1 });
  const rows = attribute(windows, [u(2000, "model-b"), u(3000, "model-a"), u(3500, "model-b"), u(9000, "model-c"), u(2500, "model-d", "/other")]);
  assert.deepEqual(rows[0].lead_models, ["model-a", "model-b"]);
  assert.equal(rows[0].messages, 3);
});
test("no matching messages gives an empty list", () => { /* same window, no usage */ assert.deepEqual(rows[0].lead_models, []); });
```

- [ ] **Step 2: Run** `node --test claude/global/test/lead-usage.test.mjs`. Expected: FAIL (module not found).
- [ ] **Step 3: Rename and implement.**
- [ ] **Step 4: Run.** Expected: PASS; whole folder passes.
- [ ] **Step 5: Commit** `Rename the usage script for the lead and report lead models per run`.

---

### Task 6: Docs, deploy scripts and comments

**Files:**
- Modify: `README.md`, `claude/GLOBAL_INSTALL.md`, `claude/BOOTSTRAP.md`, `claude/EXAMPLE_WORKFLOWS.md`, `shared/README.md`, `shared/MANUAL_SETUP.md`, `deploy.ps1`, `deploy.sh`, `ROADMAP.md`, comments in `claude/global/scripts/codex-delegate.mjs`, `claude/global/scripts/managed-block.mjs` (line 1) and `claude/global/test/telemetry.test.mjs`
- Test: extend `claude/global/test/lead-neutral.test.mjs`

- [ ] **Step 1: Write the failing test** `user docs name the lead by role`: for `README.md`, `claude/GLOBAL_INSTALL.md`, `claude/BOOTSTRAP.md`, `claude/EXAMPLE_WORKFLOWS.md`, `shared/README.md`, `shared/MANUAL_SETUP.md`, every line matching the guard regex must also match `/tested with/i`. And `no file references the old names`: none of those files, `deploy.ps1`, `deploy.sh` or `claude/global/**/*.mjs` (except this test file) contains `opus-usage`, `ROLE_OPUS_SYNTHESIS` or `CLAUDE.orchestration.md block`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Edit.**
  - Reword per the vocabulary. One allowed sentence in `README.md` and `shared/README.md`: `Tested with Claude Opus 5.5 and Claude Fable 5.2 as lead.`
  - `README.md` layout table and `GLOBAL_INSTALL.md`: describe the rules file, the one-time block removal, `backups/`, and the manual install (generate with `node -e` calling `buildRulesFile`, or run the installer; no `CLAUDE.md` edit). Replace the manual check with: new session on a non-Opus model, `CLAUDE.md` has no block, ask for rule 6 of the routing policy, trailer says "lead".
  - `deploy.ps1` / `deploy.sh`: header comments and final message say "rules file".
  - `ROADMAP.md` step 5, one new bullet: `**Lead instructions reworded and moved to a rules file (2026-11-17).** Worker prompts unchanged (still prompt version 2). Rules-file sha256 prefix: <first 12 hex of the manifest's generated entry>. Spec: docs/superpowers/specs/2026-11-17-lead-neutral-global-instructions-design.md.` Nothing else in the file changes.
  - Code comments: "Opus" -> "the lead".
- [ ] **Step 4: Run** `node --test claude/global/test/` and `node claude/global/test/prompt-freeze.mjs`. Expected: all pass, `PROMPT FREEZE: OK`.
- [ ] **Step 5: Commit** `Update docs and deploy scripts for the rules file and lead wording`.

---

### After the last task (manual, by the user or with their go-ahead)

Deploy on each machine (`deploy.ps1` / `deploy.sh`), then run the manual check from Task 6. If a Claude Code surface does not load `~/.claude/rules/`, stop and report: the spec's fallback is the managed block for that surface.
