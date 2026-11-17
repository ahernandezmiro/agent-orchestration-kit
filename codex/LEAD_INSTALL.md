# Use Codex as the lead

From the kit checkout, run `node codex/install.mjs` with Node.js 18 or later. Open a new Codex CLI or desktop session in a local project and invoke `$orchestration-kit` with your task. The session's selected model leads. The skill lives at `~/.agents/skills/orchestration-kit/`. The installer puts the gateways, contracts and templates under `$CODEX_HOME/orchestration`, where `CODEX_HOME` defaults to `~/.codex`. Codex workers use their existing model config, Codex CLI login, and quota gate.

Use `node codex/install.mjs --dry-run` to print the paths or `node codex/install.mjs --runtime-only` to install the gateways without registering the lead skill. Re-run the installer to update. `node codex/install.mjs --uninstall` removes the skill and leaves the gateway available to collect jobs. Local runs, overrides and telemetry live under each installation's runtime root. If you installed both leads, each has its own run records and in-flight Codex quota reservations; Claude reservations are shared across both. Use your client's normal shell permission flow if it needs access to the runtime directory or delegated CLI.

## Delegate to Claude Code

The gateway calls Anthropic's unmodified Claude Code CLI. By default it uses the operator's own Claude Code login, the same way Codex workers use the Codex CLI login. Anthropic's terms allow personal use of `claude -p` with your own subscription and prohibit offering or routing other people's subscription logins, so anyone who hosts or redistributes this setup must use API keys. API-key mode is opt-in: set `ORCH_CLAUDE_AUTH=api` (or `claude.auth` in `config/models.json`) and make `ANTHROPIC_API_KEY` available to the shell that launches the gateway. Prompts and job records contain no copy of a key or login token. [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) · [Claude Code programmatic use](https://code.claude.com/docs/en/headless) · [Claude subscription and Agent SDK usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

Install Claude Code 2.1.286 or later, sign in, and make `claude` available on PATH. On Windows, point `CLAUDE_BIN` at the native binary if `claude.exe` is missing from PATH.

Use the installed `scripts/claude-delegate.mjs` from either lead. The example uses the default Codex install path and a fixture packet from this checkout.

```bash
node "$HOME/.codex/orchestration/scripts/claude-delegate.mjs" which
node "$HOME/.codex/orchestration/scripts/claude-delegate.mjs" run --role astra-review --packet claude/global/test/R001-slug-registry.yaml --cwd . --dry-run
```

For a real run, use the project's packet and omit `--dry-run`. Claude supports `luna-implement`, `sol-implement`, `astra-review` and `astra-investigate`. Every role gets `Read`, `Glob` and `Grep`; implementation roles also get `Edit` and `Write`, limited to the packet's `editable_paths`. Claude workers have no shell, so the lead runs every check. Use Codex for `luna-test` and for reviews that need shell commands. The worker runs isolated from the operator's CLAUDE.md files, rules, memory, hooks, plugins, skills and MCP servers.

Models and effort per role come from `claude.roles` in `config/models.json` (defaults: `sonnet`, `opus` for `sol-implement`, high effort). `ORCH_CLAUDE_MODEL` overrides the model for every role and `--effort` overrides one run. Project model overrides apply to Codex workers only. `models`, `config --explain` and `quota` on the Claude gateway report the Claude settings.

Every live Claude run passes a quota gate and exits 5 when blocked. With the subscription it reads the 5-hour and 7-day usage with the operator's login and reserves a percentage per role, like the Codex gate. With an API key it keeps a dollar budget from each run's cost estimate and caps each run with `--max-budget-usd`. Limits live under `claude` in `config/quota.json`. Claude runs do not reserve Codex quota.

Use `--background` followed by `collect <run-id> --wait` for a long job. The same gateway handles `status`, `result`, `cancel`, `assess` and `show`. Claude usage and cost are recorded under `claude_usage` and `claude_cost_usd` in the run record. Use `metrics --by backend` to compare outcomes by backend and auth mode.
