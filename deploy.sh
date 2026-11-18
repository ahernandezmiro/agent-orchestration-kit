#!/usr/bin/env bash
# Deploy (fresh install or update) the orchestration kit for every supported lead client found
# for this Linux/WSL/macOS user: Claude Code and Codex.
# Author: maintained with Claude Code for the frontier-model orchestration setup.
#
# Steps: find Node >= 18 (non-interactive WSL shells often skip ~/.bashrc and still see the
# distro's old /usr/bin/node, so user-level installs are probed: $NODE_BIN_DIR, pnpm, Volta, nvm)
# -> detect clients -> prompt-freeze check (prompts must stay byte-identical during the evaluation
# period) -> each client's installer -> effective models.
#
# Clients and what their installer deploys:
#   claude-code  claude/install.mjs: the shared runtime under ~/.claude/orchestration, the two
#                subagents, the lead's rules file (~/.claude/rules/orchestration-kit.md) and the
#                permission rules (settings.json is backed up first; CLAUDE.md is only touched to
#                remove an old kit block). Found when ~/.claude exists or `claude` is on PATH.
#   codex        codex/install.mjs: the shared runtime under $CODEX_HOME/orchestration (default
#                ~/.codex/orchestration) and the lead skill under ~/.agents/skills/orchestration-kit.
#                Found when $CODEX_HOME or ~/.codex exists or `codex` is on PATH.
# runs/, telemetry/ and overrides/ are never touched. Fresh installs and updates use the same path.
#
#   ./deploy.sh                        install / update every client found
#   ./deploy.sh --client codex         only the named client(s); repeat or comma-separate
#   ./deploy.sh --check                preflight only, changes nothing
#   ./deploy.sh --dry-run              show what would change
#   ./deploy.sh --allow-prompt-change  skip the prompt-freeze check (only after the evaluation closes)
#   ./deploy.sh --uninstall [--purge]  remove each client's lead registration; Claude Code also removes
#                                      its runtime (--purge also deletes its runs/, telemetry/ and
#                                      overrides/); Codex keeps its gateway so jobs can be collected

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT_FREEZE="$REPO_ROOT/claude/global/test/prompt-freeze.mjs"
MINIMUM_NODE_MAJOR=18
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
SUPPORTED=(claude-code codex)

check_only=false; dry_run=false; allow_prompt_change=false; uninstall=false; purge=false
requested=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --client)
      [[ $# -ge 2 ]] || { echo "deploy.sh: --client needs a value (claude-code, codex)" >&2; exit 2; }
      IFS=',' read -r -a names <<< "$2"
      for name in "${names[@]}"; do
        case "$name" in claude-code|codex) requested+=("$name") ;; *) echo "deploy.sh: unknown client '$name' (claude-code, codex)" >&2; exit 2 ;; esac
      done
      shift ;;
    --check) check_only=true ;;
    --dry-run) dry_run=true ;;
    --allow-prompt-change) allow_prompt_change=true ;;
    --uninstall) uninstall=true ;;
    --purge) purge=true ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "deploy.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

# Input: client name. Output: path of its installer.
installer_for() {
  case "$1" in claude-code) echo "$REPO_ROOT/claude/install.mjs" ;; codex) echo "$REPO_ROOT/codex/install.mjs" ;; esac
}

# Input: client name. Output: path of its installed runtime.
runtime_for() {
  case "$1" in claude-code) echo "$HOME/.claude/orchestration" ;; codex) echo "$CODEX_HOME_DIR/orchestration" ;; esac
}

# Input: client name. Output: what to do after deploying.
next_for() {
  case "$1" in
    claude-code) echo 'Start a NEW Claude Code session so the agents and rules file reload.' ;;
    codex) echo 'Start a NEW Codex session and invoke $orchestration-kit.' ;;
  esac
}

# Input: client name. Output: exit status 0 when the client is installed for this user.
client_found() {
  case "$1" in
    claude-code) [[ -d "$HOME/.claude" ]] || command -v claude >/dev/null 2>&1 ;;
    codex) [[ -d "$CODEX_HOME_DIR" ]] || command -v codex >/dev/null 2>&1 ;;
  esac
}

# Input: none. Output: prints the node major version, or nothing when node is absent.
node_major() {
  command -v node >/dev/null 2>&1 || return 0
  node --version | sed 's/^v//; s/\..*//'
}

# Input: none. Output: exit status 0 when the node on PATH is >= MINIMUM_NODE_MAJOR.
node_is_recent() {
  local major
  major="$(node_major)"
  [[ -n "$major" && "$major" -ge "$MINIMUM_NODE_MAJOR" ]]
}

# Input: none. Output: none; puts a recent node first on PATH, or exits 1 when none is found.
ensure_node() {
  local dir
  if ! node_is_recent; then
    for dir in "${NODE_BIN_DIR:-}" "${PNPM_HOME:-$HOME/.local/share/pnpm}/bin" "${PNPM_HOME:-$HOME/.local/share/pnpm}" \
               "${VOLTA_HOME:-$HOME/.volta}/bin"; do
      if [[ -n "$dir" && -x "$dir/node" ]]; then
        PATH="$dir:$PATH"
        node_is_recent && break
      fi
    done
  fi
  if ! node_is_recent && [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    # nvm.sh references unset variables; relax nounset only while it loads.
    set +u
    # shellcheck disable=SC1091
    source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    set -u
  fi
  if ! node_is_recent; then
    echo "deploy.sh: Node.js $MINIMUM_NODE_MAJOR+ is required (found: $(node --version 2>/dev/null || echo none))." >&2
    exit 1
  fi
  echo "node $(node --version) ($(command -v node))"
}

# Input: step label, then node arguments. Output: none; exits on failure (set -e).
node_step() {
  local label="$1"; shift
  echo "== $label"
  node "$@"
}

ensure_node
commit="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
[[ -n "$commit" ]] && echo "kit commit $commit"

targets=()
for name in "${SUPPORTED[@]}"; do
  if [[ ${#requested[@]} -gt 0 ]]; then
    [[ " ${requested[*]} " == *" $name "* ]] && targets+=("$name")
  elif client_found "$name"; then
    targets+=("$name")
  fi
done
if [[ ${#targets[@]} -eq 0 ]]; then
  echo "deploy.sh: no supported client found (looked for Claude Code and Codex). Install one, or name it with --client." >&2
  exit 1
fi
echo "clients: ${targets[*]} ($([[ ${#requested[@]} -gt 0 ]] && echo requested || echo detected))"

if $uninstall; then
  for name in "${targets[@]}"; do
    uninstall_args=("$(installer_for "$name")" --uninstall)
    $dry_run && uninstall_args+=(--dry-run)
    if $purge; then
      if [[ "$name" == claude-code ]]; then uninstall_args+=(--purge)
      else echo "WARNING: --purge does not apply to $name; its runtime data stays at $(runtime_for "$name")." >&2; fi
    fi
    node_step "uninstall $name" "${uninstall_args[@]}"
  done
  exit 0
fi

if $check_only; then
  # Run every preflight, then fail if any did, so one report shows all problems.
  failed=()
  for name in "${targets[@]}"; do
    echo "== preflight $name"
    node "$(installer_for "$name")" --check || failed+=("$name")
  done
  if [[ ${#failed[@]} -gt 0 ]]; then echo "deploy.sh: preflight failed for: ${failed[*]}" >&2; exit 1; fi
  exit 0
fi

if $allow_prompt_change; then
  echo "WARNING: prompt-freeze check skipped (--allow-prompt-change)." >&2
else
  node_step "prompt freeze" "$PROMPT_FREEZE"
fi

for name in "${targets[@]}"; do
  install_args=("$(installer_for "$name")")
  $dry_run && install_args+=(--dry-run)
  node_step "install $name" "${install_args[@]}"
done

if ! $dry_run; then
  for name in "${targets[@]}"; do
    scripts="$(runtime_for "$name")/scripts"
    node_step "effective models ($name runtime, Codex workers)" "$scripts/codex-delegate.mjs" models
    node_step "effective models ($name runtime, Claude workers)" "$scripts/claude-delegate.mjs" models
  done
  echo "Deployed."
  for name in "${targets[@]}"; do echo "  $name: $(next_for "$name")"; done
fi
