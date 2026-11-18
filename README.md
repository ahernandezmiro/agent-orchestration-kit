# orchestration-kit

Start in Claude Code or Codex. The model selected in that session is the **lead**, which plans work, routes bounded tasks, verifies results, and owns the final answer. Each lead can call either worker gateway from the same installation. Routing policy, YAML contracts, job collection, and telemetry are shared. [Routing policy](shared/ROUTING_POLICY.md)

| Client | Lead entry point | Worker gateway | Worker capabilities |
|---|---|---|---|
| Claude Code | Start a new session after installing the kit rules | `scripts/claude-delegate.mjs` | Implementation (file edits, no shell), independent review, and investigation. Requires Claude Code 2.1.286+. Uses your Claude Code login and quota gate; a Console API key is optional |
| Codex | Invoke `$orchestration-kit` in a new session | `scripts/codex-delegate.mjs` | Implementation, tests, independent review, and investigation. Uses the Codex CLI login and quota gate |

## Install

Run the installer for the client whose runtime directory you want to use. Both require Node.js 18 or later.

| Client | Install or update | Runtime directory | Native lead registration |
|---|---|---|---|
| Claude Code | `node claude/install.mjs` | `~/.claude/orchestration/` | Rules and agents under `~/.claude/` |
| Codex | `node codex/install.mjs` | `$CODEX_HOME/orchestration/` (default `~/.codex/orchestration/`) | `~/.agents/skills/orchestration-kit/` |

Add `--runtime-only` to either command to install both gateways without registering lead instructions. Add `--dry-run` to preview the install. Each runtime keeps its own runs, overrides, and Codex quota reservations. For client-specific requirements, upgrades, and uninstall commands, see the [Claude Code guide](claude/GLOBAL_INSTALL.md) and [Codex guide](codex/LEAD_INSTALL.md).

## Shared layout

Both installations use this layout under their runtime directory.

| Installed path | Purpose |
|---|---|
| `scripts/` | Worker gateways, shared job lifecycle, and telemetry tools |
| `config/` | Worker model defaults and Codex quota thresholds |
| `prompts/`, `templates/` | Shared prompt fragments, report schemas, and YAML packet templates |
| `shared/` | Routing policy and task and review contracts |
| `claude/`, `codex/` | Client-specific reference material |
| `runs/`, `telemetry/`, `overrides/` | Local job records, events, and custom prompts, preserved on update |
| `deployed.json` | Client, kit revision, and effective Codex model configuration |

In the checkout, `runtime/` contains the gateways and common deployment code. `shared/` contains provider-independent policy. Client integrations live under `claude/` and `codex/`. To add a lead client, reuse `runtime/install-runtime.mjs` and supply that client's native entry point. To add a worker provider, add a gateway and backend under `runtime/scripts/` and connect them to the shared packet and job commands in `delegate.mjs`. The client's lead entry point and the worker backend can be added independently.

## Run and collect a delegation

Use `codex` or `claude` for `<provider>` and the path to either installation for `<runtime>`. Start with the matching packet template under `<runtime>/templates/`.

```text
node "<runtime>/scripts/<provider>-delegate.mjs" run --role astra-review --packet "<review.yaml>" --cwd "<project>" --background
node "<runtime>/scripts/<provider>-delegate.mjs" collect <run-id> --wait
```

Both gateways also accept `status`, `result`, `cancel`, `show`, and `assess` with the run ID. The lead verifies the report before recording its assessment.

## Model configuration

`runtime/config/models.json` maps each Codex worker role to a model ID and a default reasoning effort.

```json
{ "roles": { "luna-implement": { "model": "gpt-6-luna", "effort": "high" }, "...": {} } }
```

- **Change models for every machine:** edit `models.json`, commit, push, pull on each machine, deploy.
- **One-machine override**. Create `runtime/config/models.local.json` in the checkout and rerun the installer. The installer also reads the older checkout path, `claude/global/config/models.local.json`, if the new one is absent. Both paths are gitignored.
- **Effective settings**. Run `node "<runtime>/scripts/codex-delegate.mjs" models` using your installed runtime path.
- **Valid efforts:** `none, minimal, low, medium, high, xhigh`. `--effort` on a single run still overrides the default.
- **Bad config fails loudly.** An unknown role, a missing model, an invalid effort or invalid JSON stops `run` with a message naming the file. The wrapper never falls back to a built-in model.
- **Check the model works first.** The Codex cache can list models your account or CLI still rejects. Before switching, run `codex exec --skip-git-repo-check --sandbox read-only --model <id> "Reply OK"`.

The shared gateway defines the role's required packet keys, permissions, and report format. The configured model can vary by worker provider. See the [Claude worker setup](codex/LEAD_INSTALL.md#delegate-a-review-to-claude-code) for model and effort selection.

## Project defaults

A project can add rules to every packet it receives without touching the kit. Create `<repo>/.orchestration/project.json`; `templates/project.json` is an example. The wrapper looks for it from `--cwd` up to the git root, using the main checkout even for `--worktree` runs.

- `constraints`, `required_checks`: appended to every Luna/Sol packet. Packets must use block lists (`key:` followed by `- item` lines); flow lists like `[]` are rejected so nothing gets silently dropped.
- `context`: added to task packets as a `project_context:` block. Astra packets get it only with `"review_safe": true`, and never get the constraints or checks.
- `roles.<role>.model` / `.effort` override the Codex worker defaults for that project. `--effort` on the command line still wins.
- Strictly append-only: sandbox, git rules, the blind-review allowlist and the frozen prompt text can't be changed. Invalid files stop the run (exit 2) and name the file.
- Each run records `project_config` (file, sha256, what was applied), `model_source`/`effort_source`, and `prompt_sha256`, so runs with and without project defaults stay comparable.
- To see effective Codex settings and project defaults, run `node "<runtime>/scripts/codex-delegate.mjs" config --explain <role> --cwd <repo> [--json]`.

## Role prompt overrides

Both gateways compose the prompt from shared base rules, a role prompt, a report contract, the packet, and a closing line. The worker uses the first available role prompt from this list.

1. `<repo>/.orchestration/roles/<role>.md`: the nearest one from `--cwd` up to the git root, looked up separately for each role. It doesn't need a `project.json`. For `astra-review` / `astra-investigate`, it is used only if the same `.orchestration/` folder has a `project.json` with `"review_safe": true`.
2. `<runtime>/overrides/roles/<role>.md` for this runtime. Updates preserve it.
3. The kit default in `<runtime>/prompts/roles/`.

An override replaces the whole role prompt, with no merging. It must be non-empty and at most 64 KiB, otherwise the run stops with exit 2. Overrides are trusted text: base rules and the report format take precedence over them, but only the sandbox and the git guard actually enforce anything. Each run prints `ROLE PROMPT: <default|global|project> <path>` and records `role_prompt` (source, path, sha256), so runs with overrides can be analysed separately. `config --explain` shows which file applies and any overrides it ignored.

## Codex quota gate

Every live Codex delegation checks quota before starting. The gateway exits with code **5** when quota is insufficient or unknown. Claude workers have their own gate (see [Claude workers](#claude-workers)) and do not reserve Codex quota.

How it works:
1. It reads the 5h window (`window_minutes: 300`) from a short-lived `codex app-server` (`account/rateLimits/read`, the numbers `/status` shows; about 2–3 s). If that fails, it uses the newest `rate_limits` snapshot in `~/.codex/sessions` rollouts, as long as that window hasn't reset. If neither gives a value, the run is blocked.
2. It reserves quota for runs still in flight: runs recorded as `running` or `submitted_background` that started within the last window. Each one reserves its role's number from `config/quota.json`.
3. It allows the run only if `(100 − used%) − reservations − this role's number > 0`.

| Role | Threshold = reservation |
|---|---|
| `astra-review`, `astra-investigate` | 25 |
| `sol-implement` | 15 |
| `luna-implement`, `luna-test` | 10 |

Example: 60% remaining with one Astra and one Luna in flight leaves 60 − 25 − 10 = 25%. Astra (needs more than 25) is blocked; Sol and Luna are allowed.

- A blocked call prints `QUOTA GATE: BLOCKED …`, writes a `quota_gate_blocked` event to `telemetry/events.jsonl` and creates no run record. An allowed call stores the verdict in the run record as `quota_gate`.
- `codex-delegate.mjs quota [--role <role>] [--json]` shows the current verdict for each role.
- Uncollected background runs keep their reservation until they are collected or a window has passed. Run `collect` promptly.
- Environment variables: `CODEX_BIN` sets the codex binary. `CODEX_QUOTA_SNAPSHOT=<file.json>` (`{usedPercent, windowMinutes, resetsAt}`) replaces the live read; the tests use it.
- Tests: `node --test claude/global/test/quota-gate.test.mjs`.

## Claude workers

`claude-delegate.mjs` runs Claude Code in print mode for `luna-implement`, `sol-implement`, `astra-review` and `astra-investigate`. `luna-test` stays on Codex because it needs a shell. Install Claude Code 2.1.286 or later; on Windows set `CLAUDE_BIN` to the native binary if `claude.exe` is not on PATH.

**Auth.** By default a worker uses your own Claude Code login (`claude.auth: "subscription"` in `config/models.json`), the same way Codex workers use your Codex login. Set `ORCH_CLAUDE_AUTH=api` (or `claude.auth: "api"`) to use a Claude Console key from `ANTHROPIC_API_KEY` instead; the run then uses `--bare`. Anthropic's terms allow your own subscription for your own work; offering or routing other people's subscription logins is not allowed, so a redistributed or hosted setup must use API keys. [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)

**Isolation.** Every run uses `--safe-mode --restricted --strict-mcp-config --disable-slash-commands`, turns off hooks and auto memory through `--settings`, removes the `Agent` tool and MCP tools, and sets `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, so your CLAUDE.md files, plugins, skills and MCP servers stay out of the worker. Provider and proxy variables (`ANTHROPIC_BASE_URL`, Bedrock/Vertex/Foundry) and model or effort overrides (`ANTHROPIC_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL` and similar) are never passed on, so the run uses the model and effort it records. This isolation still needs confirming on a real Claude Code 2.1.286+ (see the design spec's smoke test).

**Edits.** Implementation roles get `Read, Glob, Grep, Edit, Write` and no shell. Each `editable_paths` entry becomes a permission rule (`src/` becomes `Edit(./src/**)`), so the CLI denies any other edit. Entries must be relative to `--cwd`, without `..`, whitespace, commas or parentheses; an empty list stops the run. The prompt gets a generated note that the worker has no shell and must report checks as `not-run`: the lead runs them. After every write run (either gateway), files outside `editable_paths` are listed as `out_of_scope_files` and printed as `SCOPE: …`. `.git` and `.claude` are never editable: entries that could reach them are refused, write runs deny them in every spelling the CLI can express, and the git guard fails the run (exit 3) if a worker changed them anyway. The guard fingerprints the repository's `.claude` folders (including ones `.gitignore` hides), git config, hooks (including a `core.hooksPath` folder), `info/`, submodule git dirs and linked worktrees' metadata (a worktree added or removed during a run is not a violation; changing an existing one is).

**Models.** `config/models.json` → `claude.roles` sets model and effort per role (defaults: `sonnet`, `opus` for `sol-implement`). `ORCH_CLAUDE_MODEL` overrides the model for every role; `--effort` overrides one run. `models`, `config --explain` and `quota` on the Claude gateway report the Claude settings.

**Quota gate.** Configured in `config/quota.json` → `claude`; blocked runs exit **5** like Codex runs.
- Subscription: the run is allowed only if `(100 − 5-hour used%) − reservations of Claude subscription runs in flight − the role's percent > 0` and the 7-day window has more than `seven_day_min_remaining`% left (set it to `null` for a plan without a weekly limit; otherwise a missing weekly reading blocks). Usage comes from `api.anthropic.com/api/oauth/usage`, read with the same login the worker uses: `CLAUDE_CODE_OAUTH_TOKEN` if set, else the token in Claude Code's credentials file (`$CLAUDE_CONFIG_DIR/.credentials.json`, default `~/.claude/.credentials.json`). The token is used for that one request and never written, logged or refreshed, and error messages never quote the file. This endpoint is undocumented; if it fails (expired token, keychain storage, network) or returns an out-of-range or already-reset reading, the run is blocked. A recent Claude Code transcript that recorded a `usage_limit_reached` rejection blocks until its reset time.
- API key: each run is capped with `--max-budget-usd` at its role's amount, and the run is allowed only if `budget_usd − recorded spend of API-key runs in the window − reservations in flight − the role's amount ≥ 0`. Spend is Claude Code's own `total_cost_usd` estimate, not your bill.
- Reservations are read from both local runtimes (`~/.claude/orchestration` and `$CODEX_HOME/orchestration`), so a Claude Code lead and a Codex lead share them. Each run reserves the amount it was admitted with (its `--max-budget-usd` cap in API-key mode), whatever the other runtime's config says, and an abandoned API-key run with unknown cost still counts its cap. Admission is serialized across both runtimes with a lock file in a private `~/.orchestration-kit/` folder, so two overlapping launches cannot both take the last of the quota.
- `CLAUDE_QUOTA_SNAPSHOT=<file.json>` (`{fiveHour: {usedPercent, resetsAt}, sevenDay: {…}}`) replaces the live read; the tests use it.
- Run records gain `claude_auth`, `claude_cost_usd`, `claude_usage` and, for write runs, `claude_edit_rules`. `metrics --by backend` splits Claude runs into `claude-subscription` and `claude-api`.
- Tests: `node --test claude/global/test/claude-quota.test.mjs claude/global/test/claude-worker.test.mjs`.

## Exporting telemetry for analysis

`pack-telemetry.mjs` exports data from every local runtime that has some, whichever lead installed it: `~/.claude/orchestration` and `$CODEX_HOME/orchestration` (default `~/.codex`). Both gateways support `metrics --by backend` and record worker usage under the corresponding provider field.

```bash
node "<runtime>/scripts/pack-telemetry.mjs"
```

- Repeat `--source <dir>` to choose multiple runtimes for one archive.
- On Windows or WSL, `--all-hosts` adds default Claude Code and Codex runtimes on the other side. On Windows this may start stopped WSL distros. Use `--source` for custom paths.
- **What goes in:** `manifest.json` (sources, file/run/event counts, options), then one folder per source (`<host>-<platform>-<user>-<claude|codex>/`) with `runs/`, `telemetry/`, `deployed.json` and `config/*.json`. Kit files (scripts, prompts, templates) are not included.
- **Trimming:** `--exclude-raw` drops `*.prompt.md`, `*.stdout.txt` and `*.stderr.txt`, which can hold project code; run records and events keep every metric. `--exclude-validation` drops `runs/_validation/` and `telemetry/_validation/`.
- **Output:** `./orchestration-telemetry-<host>-<timestamp>.zip`, or `--out <file.zip>`. `--dry-run` prints the summary without writing. Zips are gitignored.
- Tests: `node --test claude/global/test/pack-telemetry.test.mjs`.

## Prompt freeze (evaluation period)

Telemetry compares delegations over time, so the prompts must not change while model and effort selection does. `node claude/global/test/prompt-freeze.mjs` checks two things:
- **Worker prompts:** it runs the wrapper in `--dry-run` for all five roles in a temporary copy of the installed layout, with a stub companion and no real telemetry. Each prompt must be byte-identical to `claude/global/test/golden/<role>.golden.md`.
- **Lead and worker instructions**. The generated Claude rules and source prompt hashes, including the Codex lead skill, must match `golden/static-prompts.sha256.json`.

The golden files were generated from the unmodified original kit, and the `luna-implement` golden matches a prompt recorded in production. The deploy scripts run the guard first and refuse to install on drift. `.gitattributes` forces LF endings because Git for Windows' `core.autocrlf` would otherwise rewrite the inlined prompt text.

When the evaluation is closed and prompts may change: edit them, run `node claude/global/test/prompt-freeze.mjs --update`, review the diff of `golden/`, commit, and deploy.

## What is not tracked

`.gitignore` excludes delegation runs and telemetry (`runs/`, `telemetry/`, `*.run.json`, `*.prompt.md`, `*.jsonl`, …), `.orchestration/` work products, playgrounds, Claude/Codex session and conversation state (`.claude/`, `.codex/`, transcripts), installer backups (`*.bak-*`), telemetry exports (`orchestration-telemetry-*.zip`), per-machine `models.local.json`, and editor/OS files. Only setup sources belong in the repo.
