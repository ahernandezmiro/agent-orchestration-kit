# Lead-neutral global instructions, delivered as a kit-owned rules file

Date: 2026-11-17. Status: draft, awaiting approval.

## Why

Two problems with how the kit gives the lead model its global instructions:

1. **The text names a model where it means a role.** The lead-side files call the orchestrator "Opus" / "Opus 5.5". The lead is whichever model the user selects in their client. In a Fable 5.2 session this made the lead end its answer with `Orchestration: Opus only`, and the user reasonably read that as "the work ran on Opus".
2. **The kit edits a file it does not own.** Every install parses `~/.claude/CLAUDE.md` and rewrites a marked block in it. The block is small and backed up, but the kit still opens the user's file on every deploy and refuses to install when the markers are malformed. A Codex-side install would do the same to `AGENTS.md`.

## Goals

1. No lead-side instruction text names a specific model as the lead. The lead is "the lead" (or "you").
2. On Claude Code, the kit's global instructions live in one file the kit owns, `~/.claude/rules/orchestration-kit.md`. After a one-time migration, install, update and uninstall never read or write `~/.claude/CLAUDE.md`.
3. The lead-side text is structured so a second client (Codex as lead) can reuse it later with a thin adapter.

## Non-goals

- Building the Codex-lead install. This design only keeps the door open (see "Other clients").
- Renaming worker roles (`luna-implement`, `astra-review`, …) or changing `config/models.json`. Luna, Sol and Astra stay as the names of the worker tiers.
- Changing worker prompts. Their goldens must stay byte-identical.
- Changing what the routing policy says, beyond replacing the lead's name.
- A `SessionStart` hook, plugin packaging, or a new telemetry field or flag for the lead model.
- Editing historical documents: `ROADMAP.md` entries, earlier specs and plans, `astra_*.md`, existing run records and task packets.

## Anti-goals

- The kit deleting or rewriting user text in `CLAUDE.md` beyond removing its own marked block once.
- Instructions that tell the lead to report a model identity it cannot know. The lead never states which model did the lead work unless it takes that from its own system prompt.

## Approaches considered

| | How | Outcome |
|---|---|---|
| A. Rules file | Kit writes `~/.claude/rules/orchestration-kit.md`; Claude Code loads user-level rules in every project | **Chosen by the user (2026-11-17).** Never touches the user's file; easy to inspect and remove. |
| B. `SessionStart` hook | Hook in `settings.json` injects the text, optionally with the session's model name | Rejected. The injected model name goes stale when the model is switched mid-session, it still edits `settings.json`, and the text is harder to inspect. Role-neutral wording removes the need for a dynamic name. |
| C. Keep the marked block, reword only | Text change only | Rejected. Leaves the kit editing `CLAUDE.md`. |

## Design

### 1. Role-neutral wording

Vocabulary, used consistently in every lead-side file:

- **lead**: the model running the user's session. Replaces "Opus", "Opus 5.5", "Claude Opus", "You (Opus)".
- **Luna / Sol / Astra**: unchanged, as worker tier names.

Files to reword (text meaning unchanged otherwise):

- `claude/global/CLAUDE.orchestration.md`: title becomes `# Multi-Model Orchestration (lead + Codex workers)`; first line becomes `You are the lead: the primary orchestrator. …`; `major_rework: substantial lead repair…`.
- `shared/ROUTING_POLICY.md`: heading `### Lead — primary orchestrator` with one added sentence: `The lead is the model the user selected for this session; these rules apply whichever model that is.` All other "Opus" become "the lead" / "Lead" (table cells: `Lead`).
- `claude/ROLE_OPUS_SYNTHESIS.md` is renamed `claude/ROLE_LEAD_SYNTHESIS.md` and reworded; the reference in `CLAUDE.orchestration.md` follows.
- `claude/ROLE_ASTRA_REVIEW.md`, `claude/ROLE_LUNA_DISPATCH.md`, `shared/README.md`, `shared/MANUAL_SETUP.md`, `claude/BOOTSTRAP.md`, `claude/EXAMPLE_WORKFLOWS.md`, `claude/GLOBAL_INSTALL.md`, `README.md`: reworded. Where a doc describes the tested setup, it may say "tested with Claude Opus 5.5 and Fable 5.2 as lead" once, as a fact about testing, not as an identity.
- `claude/global/agents/*.md`: reworded only if they name the lead as Opus in the body. Descriptions keep the worker names.
- Code comments in `codex-delegate.mjs` and tests: "Opus" becomes "the lead". No behaviour change.

**Trailer line.** The instruction becomes:

> End substantive engineering responses with one compact line that names roles, for example:
> `Orchestration: lead → Luna implementation → lead review` or `Orchestration: lead only — delegation not warranted.`
> Write "lead" for your own part. Do not put a model name there.

**Usage script.** `claude/global/scripts/opus-usage.mjs` is renamed `lead-usage.mjs`. It already records `model` per transcript message, so it gains a per-run `lead_models` list in its output (the distinct models seen in the run's review window). This is how lead identity reaches the analysis: offline, from transcripts, with no new flag and nothing for the lead to pass. [builder's call: exact output shape]

**Guard test.** A new test fails if any file that feeds the generated rules file, or any `claude/ROLE_*.md`, matches `/\bOpus\b|\bFable\b|\bSonnet\b|\bHaiku\b/`. The existing worker-prompt assertion (`prompt-structure.test.mjs`) stays.

### 2. The rules file

**Path:** `~/.claude/rules/orchestration-kit.md`. No `paths` frontmatter, so it loads in every session.

**Content: one flat generated file, no `@` imports.** The Claude Code docs state that `~/.claude/rules/` applies to every project, but do not state that `@` imports work inside rules files. Generating a flat file removes that dependency and also the existing risk noted in the 2026-10-22 spec (nested imports silently stopping). Layout:

```
<!-- Generated by orchestration-kit install.mjs from kit commit <short sha>. Do not edit: it is overwritten on every deploy.
     Your own instructions belong in ~/.claude/CLAUDE.md or another file in this folder. -->

<claude/global/CLAUDE.orchestration.md, with its two @ import lines removed>

<shared/ROUTING_POLICY.md>

<claude/CLAUDE.md>
```

- Sections are joined with one blank line. Line endings are `\n`.
- The sentence in `CLAUDE.orchestration.md` explaining `../shared/...` paths stays, since `claude/CLAUDE.md` still uses them. Files referenced by path (`TASK_CONTRACT.md`, `REVIEW_CONTRACT.md`, `ROLE_LEAD_SYNTHESIS.md`, templates) stay under `~/.claude/orchestration/` and are read on demand, as today.
- The `@` lines are removed from `CLAUDE.orchestration.md` in the repo itself and replaced by the generator's concatenation, so the source file contains no imports. The generator is one exported function, `buildRulesFile({ kitRoot, commit })`, in a new `claude/global/scripts/rules-file.mjs`, so tests and the prompt freeze use the same code as the installer.
- The installed copy of `CLAUDE.orchestration.md` under `~/.claude/orchestration/claude/` is no longer needed and is not copied.

### 3. Installer behaviour

**Install / update**

1. Build the rules-file text.
2. If `~/.claude/rules/orchestration-kit.md` exists and its content differs from the new text **and** its sha256 differs from `rules_file_sha256` in the existing `deployed.json` (meaning someone edited it, or there is no record), back it up as `~/.claude/orchestration/backups/orchestration-kit.md.bak-<stamp>`. Backups go there, not inside `rules/`, so nothing extra sits in a folder Claude Code loads from. Then write. If the content is identical, do not write.
3. Record `rules_file_sha256` in `deployed.json`.
4. **One-time migration:** if `~/.claude/CLAUDE.md` exists and contains the `claude-md` managed block (new or legacy markers), back the file up and remove the block with `removeBlock`. If the file is then empty or whitespace-only, leave it as an empty file; never delete it. If the markers are malformed, do not touch the file: print the same line-numbered error as today, plus `the old block is still in CLAUDE.md and will load alongside the rules file; remove it by hand`, continue the install, and exit non-zero at the end.
5. If `CLAUDE.md` has no block, the installer does not write it. (It reads it once to check for the block; a later release can drop the check.)

Order matters: write the rules file before removing the block, so there is no window with no instructions.

**Uninstall:** delete the rules file; remove the `claude-md` block from `CLAUDE.md` if one is still there (same rules as today). `backups/` is removed with the rest of `~/.claude/orchestration` except `runs/`, `telemetry/`, `overrides/`.

**`managed-block.mjs`** stays, used only for migration, uninstall, and future clients without a drop-in directory.

**Messages and docs:** the "Start a NEW Claude Code session" line says "rules file" instead of "CLAUDE.md block". `deploy.ps1`, `deploy.sh`, `README.md` and `claude/GLOBAL_INSTALL.md` are updated, including the manual-install steps (copy one file; no `CLAUDE.md` edit).

### 4. Prompt freeze

- `staticPromptFiles()` keeps hashing the source files and follows the rename (`ROLE_LEAD_SYNTHESIS.md`).
- The manifest gains one generated entry, `generated/orchestration-kit.rules.md`: the sha256 of `buildRulesFile` output with the commit placeholder fixed to `<commit>`, so the hash is stable across commits.
- Worker goldens must not change. If any does, the work is wrong.
- This changes the lead's instructions but not the worker prompts, which stay at prompt version 2. `ROADMAP.md` step 5 gets a dated note, "lead instructions reworded and moved to a rules file", with the new rules-file hash. Runs before and after are comparable on worker prompts but not on lead instructions.

### 5. Other clients (not built now)

The lead-side text is client-neutral after §1 except for the delegation mechanics (subagent names, `~/.claude/...` paths), which are all in `CLAUDE.orchestration.md`. A future client adds its own adapter file in place of that one and reuses `ROUTING_POLICY.md` and the identity rules. Delivery per client: a drop-in directory where the client has one; otherwise `managed-block.mjs` with a new block id in that client's instruction file. The 2026-10-22 rule "the kit writes no `AGENTS.md`" stays in force until that work is designed.

## Testing

One test per item, `node --test`, temp `HOME`/`USERPROFILE` for installer tests.

**`rules-file.test.mjs`**
1. Output starts with the generated-file comment, contains the three sources in order, and contains no line starting with `@`.
2. Output contains no lead model name (the guard regex in §1), and the same guard passes on `claude/ROLE_*.md`.
3. Output is byte-identical for the same inputs (deterministic), with `\n` line endings even when sources are checked out with CRLF.

**`install.test.mjs`**
4. Fresh install with no `CLAUDE.md`: rules file written; `CLAUDE.md` not created.
5. Fresh install with a `CLAUDE.md` that has no block: file byte-identical and same mtime; no backup created.
6. Install over a `CLAUDE.md` with the current 3-line block: block removed, all other bytes unchanged (separator rules of `removeBlock`), one backup of `CLAUDE.md`.
7. Same as 6 with the legacy 82-line block.
8. `CLAUDE.md` containing only the block: file remains, empty.
9. Malformed markers: `CLAUDE.md` byte-identical, rules file still written, exit code non-zero, message names the line.
10. Second install: rules file same content and mtime; no backups.
11. Rules file edited by hand between installs: backed up under `backups/`, then overwritten.
12. Uninstall removes the rules file and leaves other files in `~/.claude/rules/` byte-identical.
13. Existing `~/.codex/AGENTS.md` and a project `AGENTS.md` are byte-identical after install and uninstall (existing test, kept).

**Prompt freeze**
14. The five worker goldens are unchanged by this work.
15. The manifest's generated entry matches `buildRulesFile` output.

**`lead-usage`**
16. A fixture transcript with two models in a run window yields both in `lead_models`.

**Manual check after deploy (each machine):** start a new session on a non-Opus model, confirm `~/.claude/CLAUDE.md` no longer has the block, ask the session to quote rule 6 of the routing policy, and confirm the trailer line says "lead".

## Risks

- **Rule load position.** The docs do not say where `~/.claude/rules/` sits relative to `~/.claude/CLAUDE.md` in context. The kit's text does not depend on ordering, so this only matters if the user's own `CLAUDE.md` contradicts the kit; that conflict exists today too.
- **Clients or modes that skip user rules.** If a Claude Code surface does not load `~/.claude/rules/`, the instructions vanish silently. The manual check above covers the desktop app and CLI. If one fails, the fallback is approach C for that surface.
- **Double loading during a failed migration** (malformed markers): both the old block's import target and the rules file would load. Because the installed `CLAUDE.orchestration.md` is no longer copied, the stale `@` import points at a missing file and loads nothing. The non-zero exit and message tell the user to clean up.
- **Mixed telemetry.** Evidence-based routing rules were measured with Opus as lead. `lead_models` in `lead-usage` lets a later analysis split by lead; no rule is changed now.
