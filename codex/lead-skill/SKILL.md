---
name: orchestration-kit
description: Lead a task in Codex using the orchestration kit's routing, task packets, delegated workers, and independent review.
---
<!-- Installed by the orchestration kit. -->

You are the lead. The user selects the lead model in this Codex session. Work in the user's project and own the final result.

The installed kit root is `{runtime}`. Use absolute paths under that root and quote paths in shell commands. Read `shared/ROUTING_POLICY.md` under the kit root before routing. Use `claude/ROLE_LEAD_SYNTHESIS.md` when combining a proposal with an independent review.

1. Decide whether delegation is warranted under the routing policy. Handle trivial work directly.
2. For a delegation, write a YAML packet in the project's `.orchestration/tasks/` using the installed `templates/task-packet.yaml` for implementation, testing or investigation, or `templates/review-packet.yaml` for a blind review. Follow `shared/TASK_CONTRACT.md` or `shared/REVIEW_CONTRACT.md`. Give a blind reviewer the original requirements and artifact. Keep the lead's reasoning and conversation out of the packet.
3. Use `node "<kit root>/scripts/codex-delegate.mjs" run --role <role> --packet <file> --cwd <repo> --reason <reason> --task-type <type>`. The default worker tier is `luna-implement` or `luna-test`. Use `sol-implement` for an appropriate escalation and `astra-review` or `astra-investigate` for independent analysis. Add `--parent <feature-id>`, `--budget-key <feature:role>`, and `--max-attempts <n>` when delegating part of a larger task.
4. When Claude delegation is configured and requested for the task, use `claude-delegate.mjs` with the same arguments for `astra-review` or `astra-investigate`. Route review artifacts that require shell commands, runtime checks, or Git history inspection to the Codex gateway or verify that evidence yourself. For a different Claude model, the operator can set `ORCH_CLAUDE_MODEL` before launch.
5. For long jobs use `--background`, then `collect <run-id> --wait` on the same gateway. On Windows redirect background submission stdout and stderr to a file and read the run ID from that file. Use `status`, `result`, or `cancel` with the run ID. For concurrent edits consider `--worktree`, then inspect the result before `worktree-apply` and use `worktree-clean` after assessment.
6. Verify the worker's claims against the artifact and required checks. Record your assessment with `assess <run-id> --outcome <accepted|minor_rework|major_rework|failed|not_applicable>`. If you take a substantive task yourself, record the routing decision with `record-skip --task-id <id> --task-type <type> --reason <reason> --cwd <repo>`.

End substantive engineering responses with a compact `Orchestration:` line naming the lead and any worker roles you used.
