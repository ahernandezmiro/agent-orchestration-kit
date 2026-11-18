<#
.SYNOPSIS
  Deploy (fresh install or update) the orchestration kit for every supported lead client found
  for this Windows user: Claude Code and Codex.

.DESCRIPTION
  Author: maintained with Claude Code for the frontier-model orchestration setup.

  Steps: verify Node >= 18 -> detect clients -> prompt-freeze check (prompts must stay
  byte-identical during the evaluation period) -> each client's installer -> effective models.

  Clients and what their installer deploys:
    claude-code  claude/install.mjs: the shared runtime under ~/.claude/orchestration, the two
                 subagents, the lead's rules file (~/.claude/rules/orchestration-kit.md) and the
                 permission rules (settings.json is backed up first; CLAUDE.md is only touched to
                 remove an old kit block). Found when ~/.claude exists or `claude` is on PATH.
    codex        codex/install.mjs: the shared runtime under $CODEX_HOME/orchestration (default
                 ~/.codex/orchestration) and the lead skill under ~/.agents/skills/orchestration-kit.
                 Found when $CODEX_HOME or ~/.codex exists or `codex` is on PATH.
  runs/, telemetry/ and overrides/ are never touched. Fresh installs and updates use the same path.

.PARAMETER Client
  Deploy only these clients (claude-code, codex), whether or not they are detected. Default: every
  client found.
.PARAMETER Check
  Preflight only (worker CLIs, logins, configured model ids, lead registration). Changes nothing.
.PARAMETER DryRun
  Show what would change without changing anything.
.PARAMETER AllowPromptChange
  Skip the prompt-freeze check. Only after the evaluation is closed (then re-baseline with
  'node claude/global/test/prompt-freeze.mjs --update' and commit the golden files).
.PARAMETER Uninstall
  Remove the lead registration of each client. Claude Code also removes its installed runtime;
  Codex keeps its gateway so in-flight jobs can still be collected. runs/ and telemetry/ are kept.
.PARAMETER Purge
  With -Uninstall, also delete Claude Code's runs/, telemetry/ and overrides/.

.EXAMPLE
  .\deploy.ps1 -Check
  .\deploy.ps1
  .\deploy.ps1 -Client codex
#>
[CmdletBinding()]
param(
  [ValidateSet('claude-code', 'codex')]
  [string[]]$Client,
  [switch]$Check,
  [switch]$DryRun,
  [switch]$AllowPromptChange,
  [switch]$Uninstall,
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot
$PromptFreeze = Join-Path $RepoRoot 'claude\global\test\prompt-freeze.mjs'
$MinimumNodeMajor = 18
# USERPROFILE, not $HOME: it is what Node's os.homedir() (and so the installers) resolves on Windows.
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$Clients = [ordered]@{
  'claude-code' = @{
    Installer = Join-Path $RepoRoot 'claude\install.mjs'
    Runtime   = Join-Path $env:USERPROFILE '.claude\orchestration'
    Found     = { (Test-Path (Join-Path $env:USERPROFILE '.claude')) -or [bool](Get-Command claude -ErrorAction SilentlyContinue) }
    Next      = 'Start a NEW Claude Code session so the agents and rules file reload.'
  }
  'codex' = @{
    Installer = Join-Path $RepoRoot 'codex\install.mjs'
    Runtime   = Join-Path $CodexHome 'orchestration'
    Found     = { (Test-Path $CodexHome) -or [bool](Get-Command codex -ErrorAction SilentlyContinue) }
    Next      = 'Start a NEW Codex session and invoke $orchestration-kit.'
  }
}

function Assert-NodeVersion {
  # Input: none. Output: none; throws when node is missing or older than $MinimumNodeMajor,
  # because the installers and gateways use syntax Node 10-16 cannot parse.
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $node) { throw "node not found on PATH. Install Node.js $MinimumNodeMajor+ first." }
  $version = (& node --version).Trim()
  $major = [int]($version.TrimStart('v').Split('.')[0])
  if ($major -lt $MinimumNodeMajor) { throw "node $version is too old; Node.js $MinimumNodeMajor+ is required." }
  Write-Host "node $version ($($node.Source))"
}

function Invoke-NodeStep {
  # Input: step label and node arguments. Output: none; throws on a non-zero exit code so the
  # deploy stops before changing anything else when a step fails.
  param([string]$Label, [string[]]$NodeArgs)
  Write-Host "== $Label"
  & node @NodeArgs
  if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)." }
}

function Resolve-Clients {
  # Input: none (reads -Client). Output: the client names to deploy, in a fixed order; throws when
  # none is requested or found.
  if ($Client) { return @($Clients.Keys | Where-Object { $Client -contains $_ }) }
  $found = @($Clients.Keys | Where-Object { & $Clients[$_].Found })
  if (-not $found) { throw "No supported client found (looked for Claude Code and Codex). Install one, or name it with -Client." }
  return $found
}

Assert-NodeVersion
$commit = (& git -C $RepoRoot rev-parse --short HEAD 2>$null)
if ($commit) { Write-Host "kit commit $commit" }
$targets = Resolve-Clients
Write-Host "clients: $($targets -join ', ') ($(if ($Client) { 'requested' } else { 'detected' }))"

if ($Uninstall) {
  foreach ($name in $targets) {
    $uninstallArgs = @($Clients[$name].Installer, '--uninstall')
    if ($DryRun) { $uninstallArgs += '--dry-run' }
    if ($Purge) {
      if ($name -eq 'claude-code') { $uninstallArgs += '--purge' }
      else { Write-Warning "-Purge does not apply to $name; its runtime data stays at $($Clients[$name].Runtime)." }
    }
    Invoke-NodeStep -Label "uninstall $name" -NodeArgs $uninstallArgs
  }
  exit 0
}

if ($Check) {
  # Run every preflight, then fail if any did, so one report shows all problems.
  $failed = @()
  foreach ($name in $targets) {
    Write-Host "== preflight $name"
    & node $Clients[$name].Installer --check
    if ($LASTEXITCODE -ne 0) { $failed += $name }
  }
  if ($failed) { throw "preflight failed for: $($failed -join ', ')" }
  exit 0
}

if ($AllowPromptChange) {
  Write-Warning 'Prompt-freeze check skipped (-AllowPromptChange).'
} else {
  Invoke-NodeStep -Label 'prompt freeze' -NodeArgs @($PromptFreeze)
}

foreach ($name in $targets) {
  $installArgs = @($Clients[$name].Installer)
  if ($DryRun) { $installArgs += '--dry-run' }
  Invoke-NodeStep -Label "install $name" -NodeArgs $installArgs
}

if (-not $DryRun) {
  foreach ($name in $targets) {
    $scripts = Join-Path $Clients[$name].Runtime 'scripts'
    Invoke-NodeStep -Label "effective models ($name runtime, Codex workers)" -NodeArgs @((Join-Path $scripts 'codex-delegate.mjs'), 'models')
    Invoke-NodeStep -Label "effective models ($name runtime, Claude workers)" -NodeArgs @((Join-Path $scripts 'claude-delegate.mjs'), 'models')
  }
  Write-Host 'Deployed.'
  foreach ($name in $targets) { Write-Host "  ${name}: $($Clients[$name].Next)" }
}
