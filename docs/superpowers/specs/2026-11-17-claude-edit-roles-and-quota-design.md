# Claude edit roles, subscription auth and a Claude quota gate

Date: 2026-11-17. Status: implemented 2026-11-17 at the user's request before the blind review (Codex quota blocked Astra); the review is still pending. The runtime smoke test needs Claude Code 2.1.286+ and has not run.

## Context

The shared runtime has two worker gateways: `codex-delegate.mjs` (Codex CLI) and `claude-delegate.mjs` (Claude Code CLI in print mode). Codex workers run on the user's own Codex login (ChatGPT subscription) and pass a quota gate that reads the Codex 5-hour window. Today the Claude gateway:

- accepts only `astra-review` and `astra-investigate`, with the tools `Read`, `Glob` and `Grep`;
- runs with `--bare` and requires a Claude Console API key (`ANTHROPIC_API_KEY`); bare mode never reads the subscription login;
- skips the quota gate.

The lead (Claude Code or Codex) always validates a worker's result itself: it reads the diff and runs the checks.

## Requirements

R1. Claude workers authenticate with the user's own Claude Code subscription login by default, like Codex workers. Console API-key authentication stays available as an opt-in mode.
R2. The Claude gateway accepts the implementation roles `luna-implement` and `sol-implement`.
R3. Claude implementation workers can read and edit files but cannot run shell commands or code, reach the web, use MCP tools or spawn subagents.
R4. Claude implementation workers can only edit paths the packet lists in `editable_paths`; the CLI enforces it.
R5. A Claude worker sees only the kit prompt and the packet: no user or project CLAUDE.md, rules files, auto memory, hooks, plugins, skills or MCP servers from the user's setup. In particular it must not receive the kit's lead rules (`~/.claude/rules/orchestration-kit.md`).
R6. A Claude worker is told it has no shell, so it does not claim checks it could not run.
R7. Every guard that applies to Codex write runs applies to Claude write runs: git guard, `--worktree`, budget keys, attribution snapshots, `assess`.
R8. Claude runs pass a quota gate with the Codex gate's contract: deterministic, fails closed, exit 5, `quota_gate_blocked` event, reservations for runs in flight. The gate measures the pool the run actually draws on: subscription windows in subscription mode, dollars in API-key mode.
R9. Model, effort and auth mode for Claude live in config, with environment overrides.
R10. No change to the frozen prompt files (`runtime/prompts/**`) during the evaluation period. Codex prompts and behaviour stay byte-identical; run records stay compatible.
R11. The kit never stores, logs or copies the user's Claude credentials.

## Out of scope

- `luna-test` on Claude (its job is to run checks, which needs a shell).
- Bash or any command execution for Claude workers.
- Third-party providers (Bedrock, Vertex, Foundry, gateways).

## Design

### 1. Auth modes

| | `subscription` (default) | `api` |
|---|---|---|
| CLI mode | no `--bare` | `--bare` |
| credentials | the user's Claude Code login, read by Claude Code itself | `ANTHROPIC_API_KEY` from the gateway's environment |
| environment passed to the worker | `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` removed so the login is used | key kept |
| quota gate | subscription windows | dollar budget |

Both modes remove `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, the Bedrock/Vertex/Foundry switches, `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`, as today.

The mode comes from `ORCH_CLAUDE_AUTH`, else `claude.auth` in `config/models.json` (+ `models.local.json`), else `subscription`. It is recorded on the run as `claude_auth`. In `api` mode a missing key fails before submission (exit 2), as today. In `subscription` mode the gateway does not check the login itself; a logged-out CLI fails the run and the result is recorded with `failure_hint: "auth"`.

Terms note for the docs: personal use of one's own subscription with `claude -p` is not prohibited by Anthropic's published terms; offering or routing other people's subscription logins is. The kit runs each user's own CLI with their own login. Anyone redistributing the kit as a service must use API keys.

### 2. Isolation without `--bare`

Arguments for every Claude run:

`--restricted --strict-mcp-config --disable-slash-commands --print --output-format json --no-session-persistence --permission-mode dontAsk --permission-prompts none --settings {"disableAllHooks":true,"autoMemoryEnabled":false} --tools <role tools> --allowedTools <rules> --disallowedTools mcp__*,Agent --model <m> --effort <e>`

plus `--bare` in `api` mode. Environment set for the worker: `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`.

What each piece covers (from the Claude Code CLI reference and env-var docs):

- `--restricted`: ignores user, project and local settings files (so their hooks, permissions and `enabledPlugins`), removes code-running tools and WebFetch unless `--tools` names them, confines file tools to the working directories, protects settings, git and tool-config files.
- `--strict-mcp-config` with no `--mcp-config`: no MCP servers.
- `--disable-slash-commands`: no skills or commands.
- `disableAllHooks`: no hooks, including any that survive `--restricted`.
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS`: no user, project or auto-memory CLAUDE.md files.
- `--tools` without `Agent`, plus `--disallowedTools Agent`: no subagents.

Not documented, so verified by the smoke test: that `~/.claude/rules/*.md` is excluded by `CLAUDE_CODE_DISABLE_CLAUDE_MDS`, and that installed plugins do not load under `--restricted`. If either fails, the fallback is `--settings` with `claudeMdExcludes` covering `~/.claude/rules/**` and `enabledPlugins` set to false for each installed plugin, generated at run time from the user's plugin list.

### 3. Roles and tools

Claude roles: `astra-review`, `astra-investigate`, `luna-implement`, `sol-implement`. Asking for `luna-test` fails with exit 2 naming the supported roles.

| | read roles | write roles |
|---|---|---|
| `--tools` | `Read,Glob,Grep` | `Read,Glob,Grep,Edit,Write` |
| `--allowedTools` | `Read,Glob,Grep` | `Read,Glob,Grep` plus one `Edit(...)` rule per editable path |

### 4. Path enforcement

Permission rules for `Edit` also govern `Write`. A rule path `./x` is relative to the current directory, which is the run's `--cwd` (the worktree when `--worktree` is used). Plain `Edit` is never allowed and nobody answers permission prompts, so an edit matching no rule is denied.

- A directory entry (`src/foo/`, or `src/foo` that is a directory) becomes `Edit(./src/foo/**)`.
- A file entry becomes `Edit(./src/foo.ts)`. A glob entry is passed through prefixed with `./`.
- An absolute entry, one containing `..`, or one resolving outside the repository root fails the run before submission (exit 2). An empty `editable_paths` fails a Claude write run before submission.
- Protected paths (`.git`, `.claude`, `.vscode`, ...) stay denied even if listed.

Backstop for both backends: after a write run finalizes, files in `touched_files` that match no `editable_paths` entry are recorded as `out_of_scope_files` and printed as `SCOPE: n file(s) outside editable_paths`. The status does not change.

### 5. Prompt note

`buildPrompt` appends one generated section for Claude runs only, after the contract and before the packet:

> ## Worker environment
> You can read and edit files. You have no shell and cannot run commands, tests or builds. The lead runs the checks. In your report, list each required check with result `not-run`.

The frozen prompt files do not change; Codex prompts stay byte-identical.

### 6. Model selection

`config/models.json` gains a `claude` block:

```json
"claude": {
  "auth": "subscription",
  "roles": {
    "astra-review": { "model": "sonnet", "effort": "high" },
    "astra-investigate": { "model": "sonnet", "effort": "high" },
    "luna-implement": { "model": "sonnet", "effort": "high" },
    "sol-implement": { "model": "opus", "effort": "high" }
  }
}
```

`models.local.json` overrides fields as for `roles`. Efforts are validated against the Claude list (`low, medium, high, xhigh, max`). `ORCH_CLAUDE_MODEL` overrides the model for every Claude role; `--effort` overrides per run. Project `roles` overrides keep applying to Codex only. `models`, `config --explain` and the deployment record show the Claude selection and auth mode.

### 7. Quota gate

`config/quota.json` gains a `claude` block. Missing or invalid: Claude runs fail with exit 2. The gate runs before every non-dry-run Claude delegation, after the budget check. Reservations are counted per pool: Codex runs, Claude subscription runs and Claude API-key runs never reserve against each other. Run records are read from every local runtime (`~/.claude/orchestration`, `$CODEX_HOME/orchestration`) so a Claude Code lead and a Codex lead on one machine share reservations. `quota` on the Claude gateway prints the Claude verdicts.

#### 7a. Subscription mode

```json
"subscription": {
  "read_timeout_ms": 10000,
  "seven_day_min_remaining": 10,
  "roles": { "astra-review": 15, "astra-investigate": 15, "luna-implement": 10, "sol-implement": 20 }
}
```

A run is allowed only if both hold:

- 5-hour window: `(100 - used) - reserved - roles[role] > 0`, same formula as Codex;
- 7-day window: `(100 - used) > seven_day_min_remaining`.

Sources, in order; the first that answers wins:

1. `CLAUDE_QUOTA_SNAPSHOT=<file.json>`: test and override hook, `{ fiveHour: { usedPercent, resetsAt }, sevenDay: { usedPercent, resetsAt } }`.
2. Live read: `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <token>` and `anthropic-beta: oauth-2025-04-20`, reading `five_hour.utilization`, `five_hour.resets_at`, `seven_day.utilization`, `seven_day.resets_at`. The token is the `claudeAiOauth.accessToken` in Claude Code's own credentials file (`$CLAUDE_CONFIG_DIR/.credentials.json`, default `~/.claude/.credentials.json`). The gateway reads it into memory for this one request only and never writes, logs or refreshes it (R11). An expired token, a missing file (for example macOS keychain storage), a non-2xx answer or a timeout make this source fail. This endpoint is undocumented: it is what Anthropic's own clients and third-party usage monitors call, and it may change.
3. None answered: blocked, "quota unknown".

Override, checked first: if any Claude Code transcript under `~/.claude/projects` modified within the last window holds an `apiError: "usage_limit_reached"` entry whose `rate_limit_info.resetsAt` is still in the future, the run is blocked until that time, whatever the sources say. Claude Code writes these entries when the subscription rejects a request; they carry no utilization, only the reset time.

A run that fails because the subscription rejected it is recorded with `failure_hint: "quota"`.

Alternative considered: a status-line wrapper that saves the documented `rate_limits` object (from the status-line JSON) to a file the gate reads. It is the only documented source, but it updates only while an interactive Claude Code session is open and requires the kit to wrap the user's `statusLine` setting. Kept as a possible later fallback source.

#### 7b. API-key mode

```json
"api": {
  "window_minutes": 1440,
  "budget_usd": 10,
  "roles": { "astra-review": 1, "astra-investigate": 1.5, "luna-implement": 2, "sol-implement": 3 }
}
```

Every API-key run gets `--max-budget-usd <roles[role]>`; a run stopped by the cap (result subtype `error_max_budget_usd`) is `failed` with `failure_hint: "budget"`. A run is allowed only if `budget_usd - spent - reserved - roles[role] >= 0`. `spent` sums `claude_cost_usd` (from `total_cost_usd`, a client-side estimate) of API-key runs started within the window; a finalized run without a recorded cost counts its reservation.

### 8. Records and telemetry

No new statuses. New run fields: `claude_auth`, `claude_cost_usd` (Claude runs), `out_of_scope_files` (write runs, both backends). `metrics` adds `claude_cost_usd` to the Claude totals and `--by backend` splits Claude by auth mode (`claude-subscription`, `claude-api`).

## Validation

- Tests with the stub Claude binary and a stub usage server (one test per requirement): auth-mode resolution and environment per mode; argument vectors per role and mode; isolation environment variables; path-rule generation and rejection cases; prompt note only for Claude; model config merge and validation; subscription gate allow, block on 5-hour, block on 7-day, block on transcript rejection, block when unknown, token never written to any file the kit creates; API-key gate allow, block, unknown cost; reservations by pool and across runtimes; `out_of_scope_files`.
- Runtime smoke test on a real Claude Code ≥ 2.1.286 logged in with a subscription, on a scratch repository:
  - a `luna-implement` packet edits an allowed file and tries a disallowed one: the allowed edit lands, the other file is unchanged, git guard OK, run `completed`;
  - an `astra-review` packet asks the worker to quote any instruction it was given about orchestration trailers or "Orchestration:" lines: it reports none (proves the lead rules file and CLAUDE.md did not load);
  - `quota` on the Claude gateway prints a live 5-hour and 7-day reading;
  - the scratch repository holds a hostile `.claude/settings.json` (an `env` entry pointing `ANTHROPIC_BASE_URL` at a local listener, an `apiKeyHelper`, a hook and a broad `permissions.allow`): none of them takes effect. This confirms that `--restricted` ignores project and local settings files, as documented. If it fails, add `--setting-sources` with no sources, or refuse to run when the cwd has `.claude/settings*.json`.
- Prompt freeze and the full suite pass.

## Risks

- The usage endpoint is undocumented. Mitigation: the gate fails closed, the override hook and transcript check still work, and the status-line source is a documented fallback to add if the endpoint breaks.
- Isolation of rules files and plugins without `--bare` is partly undocumented. Mitigation: smoke test; generated `claudeMdExcludes` / `enabledPlugins` fallback.
- Automated worker use draws on the same subscription limits as the user's interactive sessions. The gate's reservations are the protection; percentages are defaults to tune.
- Claude implementation without a shell cannot self-check. Accepted: the lead validates every run.
