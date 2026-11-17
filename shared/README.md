# Frontier Model Orchestration Kit

Purpose: configure a subscription-backed multi-model workflow where the model you select in Claude Code (the lead) is the primary orchestrator, GPT-6 Luna is the default implementation/test worker, and GPT-6 Astra is an independent reviewer / alternative-design specialist.

Assumptions:
- Claude Desktop / Claude Code is already installed and authenticated.
- Codex Desktop / Codex CLI is already installed and authenticated with the desired ChatGPT subscription.
- Claude Code already has the relevant Codex integration plugins installed (including OpenAI `codex-plugin-cc`, plus any Anthropic Codex dispatch/review plugins you want to keep).
- This kit does NOT replace global app configuration automatically. Each model should read the folder intended for it and apply only additive/local changes unless you explicitly approve a global edit.

Top-level folders:
- `shared/` — common contracts, routing policy, schemas, and manual setup notes.
- `claude/` — Claude-specific orchestration rules and role definitions.
- `codex/` — Codex-specific worker/reviewer role definitions and suggested config fragments.

Recommended operating model:

1. You interact primarily with Claude Code. The model you select there is the lead. Tested with Claude Opus 5.5 and Claude Fable 5.2 as lead.
2. The lead owns requirements, architecture, decomposition, synthesis, and final sign-off.
3. The lead delegates bounded implementation and test work to Luna through the installed Codex integration.
4. The lead asks Astra for independent review / alternative proposals on important design, architecture, 2D, 3D, and video-pipeline work.
5. Reviewers should be kept blind to the producing model's hidden reasoning; give them requirements + artifact/output only.
6. A model that produced an artifact should not be the only model that reviews it when the change is important.

Start here:
- Claude: point Claude Code at `claude/BOOTSTRAP.md`.
- Codex: point Codex at `codex/BOOTSTRAP.md`.
- Human/manual items: read `shared/MANUAL_SETUP.md`.
