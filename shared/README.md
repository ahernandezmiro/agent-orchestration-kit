# Frontier Model Orchestration Kit

The kit runs a multi-model workflow from Claude Code or Codex. The model selected in the user's session leads. Worker roles specify the task and report contract, and the selected gateway determines which provider runs them.

Install the client and authenticate the worker CLI you intend to use. Both clients install the same runtime. The OpenAI companion plugin is optional and serves the legacy Codex `companion` backend.

- `shared/` contains the contracts, routing policy, and manual setup notes.
- `runtime/` contains the worker gateways, prompts, templates, and default configuration.
- `claude/` and `codex/` contain client-specific installers, integration files, and setup guides.

1. The lead owns requirements, architecture, decomposition, synthesis, and final sign-off.
2. Use either gateway for implementation, review and investigation; use the Codex gateway for tests. Claude workers can read and edit files but have no shell, so the lead runs their checks.
3. Give blind reviewers the requirements, constraints, and artifact. Keep the producing model's private reasoning out of the packet.
4. Verify the worker report and record the outcome before final sign-off.

- [Claude Code setup](../claude/GLOBAL_INSTALL.md)
- [Codex setup](../codex/LEAD_INSTALL.md)
- [Manual setup notes](MANUAL_SETUP.md)
