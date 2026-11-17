# Use Codex as the lead

From the kit checkout, run `node codex/install.mjs` with Node.js 18 or later. Open a new Codex CLI or desktop session in a local project and invoke `$orchestration-kit` with your task. The session's selected model leads. The skill lives at `~/.agents/skills/orchestration-kit/`. The installer puts the gateways, contracts and templates under `$CODEX_HOME/orchestration`, where `CODEX_HOME` defaults to `~/.codex`. Codex workers use their existing model config, Codex CLI login, and quota gate.

Use `node codex/install.mjs --dry-run` to print the paths or `node codex/install.mjs --runtime-only` to install the gateways without registering the lead skill. Re-run the installer to update. `node codex/install.mjs --uninstall` removes the skill and leaves the gateway available to collect jobs. Local runs, overrides and telemetry live under each installation's runtime root. If you installed both leads, each has its own run records and in-flight Codex quota reservations. Use your client's normal shell permission flow if it needs access to the runtime directory or delegated CLI.

## Delegate a review to Claude Code

The gateway calls Anthropic's unmodified Claude Code CLI with a Claude Console API key from the operator's environment. Anthropic documents `claude -p` for automation and directs developers integrating Claude to API-key authentication. Anthropic separately documents personal use of `claude -p` with a subscription sign-in. This gateway uses Console billing. [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) · [Claude Code programmatic use](https://code.claude.com/docs/en/headless) · [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms) · [Claude subscription and Agent SDK usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

Install Claude Code 2.1.286 or later and make `claude` available on PATH. On Windows, point `CLAUDE_BIN` at the native binary if `claude.exe` is missing from PATH. Make `ANTHROPIC_API_KEY` available to the shell from which Codex launches the gateway. The worker receives the key in its environment. Prompts and job records contain no copy of the key.

Use the installed `scripts/claude-delegate.mjs` from either lead. The example uses the default Codex install path and a fixture packet from this checkout.

```bash
node "$HOME/.codex/orchestration/scripts/claude-delegate.mjs" which
node "$HOME/.codex/orchestration/scripts/claude-delegate.mjs" run --role astra-review --packet claude/global/test/R001-slug-registry.yaml --cwd . --dry-run
```

For a real run, use the project's packet and omit `--dry-run`. Claude supports `astra-review` and `astra-investigate` using `Read`, `Glob` and `Grep`. Use Codex for implementation, runtime tests and reviews that need shell commands. The gateway defaults to the `sonnet` alias and high effort. Set `ORCH_CLAUDE_MODEL` to select a model and use `--effort` for a run-level override. The existing project model overrides apply to Codex workers.

Use `--background` followed by `collect <run-id> --wait` for a long job. The same gateway handles `status`, `result`, `cancel`, `assess` and `show`. Claude usage is recorded under `claude_usage` in the run record. Use `metrics --by backend` to compare outcomes by backend. Claude runs are billed by Anthropic and do not reserve Codex quota.
