# Real-runner check for the command guard hook (issue #6). Windows PowerShell 5.1 or later.
#
#   powershell -ExecutionPolicy Bypass -File tools\guard-real-runner-check.ps1
#
# Builds a throwaway git repo under $env:TEMP with one uncommitted change, loads the
# guard hook for a headless Claude Code run in that repo, asks it to run
# `git reset --hard HEAD` and then `git status --short`, and then checks the repo
# itself: if the uncommitted change survived, the hook really blocked the reset.
# It does not touch .claude/settings.json and never runs anything outside the scratch repo.
#
#   -SkipClaude   build the scratch repo and settings file and test the hook directly,
#                 without starting Claude Code (needs no login)

param([switch]$SkipClaude)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$hook = (Join-Path $repoRoot "scripts\guard\pre-command-hook.mjs").Replace("\", "/")
if (-not (Test-Path $hook)) { throw "hook script not found: $hook" }

$temp = [System.IO.Path]::GetFullPath($env:TEMP)
$scratch = Join-Path $temp "guard-scratch"
$settingsPath = Join-Path $temp "guard-settings.json"
if ((Test-Path $scratch) -and $scratch.StartsWith($temp)) { Remove-Item -Recurse -Force $scratch }
New-Item -ItemType Directory -Path $scratch | Out-Null

Push-Location $scratch
try {
  git init -q
  git config user.email "guard@example.test"
  git config user.name "guard check"
  Set-Content -Path a.txt -Value "committed"
  git add a.txt
  git commit -q -m init
  Add-Content -Path a.txt -Value "UNCOMMITTED WORK"

  $settings = @{ hooks = @{ PreToolUse = @(@{ matcher = "Bash|PowerShell"; hooks = @(@{ type = "command"; command = "node `"$hook`"" }) }) } }
  $json = $settings | ConvertTo-Json -Depth 10 -Compress
  Set-Content -Path $settingsPath -Value $json -Encoding ASCII

  Write-Host "Scratch repo: $scratch"
  Write-Host "Settings:     $settingsPath"

  # 1. The hook itself, fed the same JSON shape Claude Code sends (no login needed).
  $deny = '{"tool_name":"Bash","tool_input":{"command":"git reset --hard HEAD"},"cwd":"scratch"}' | node $hook
  $allow = '{"tool_name":"Bash","tool_input":{"command":"git status --short"},"cwd":"scratch"}' | node $hook
  Write-Host ""
  Write-Host "Direct hook test:"
  Write-Host "  reset --hard -> $deny"
  Write-Host "  status       -> [$allow]  (empty means allowed)"
  if ($deny -notmatch "deny" -or $allow) { Write-Host "FAIL: the hook script itself misbehaved"; exit 1 }

  if ($SkipClaude) { Write-Host "SkipClaude: stopping before Claude Code."; exit 0 }

  # 2. The real runner.
  # Find Claude Code: on PATH, or the copy bundled with the Claude desktop app.
  $claude = $null
  $onPath = Get-Command claude -ErrorAction SilentlyContinue
  if ($onPath) { $claude = $onPath.Source }
  else {
    $bundled = Get-ChildItem -Path (Join-Path $env:APPDATA "Claude\claude-code") -Filter claude.exe -Recurse -ErrorAction SilentlyContinue |
      Sort-Object { [version](($_.Directory.Name -replace '[^0-9.]', '') + ".0") } -Descending | Select-Object -First 1
    if ($bundled) { $claude = $bundled.FullName }
  }
  if (-not $claude) { throw "could not find Claude Code (not on PATH, and no copy under $env:APPDATA\Claude\claude-code)" }
  Write-Host "Using Claude Code at: $claude"
  $prompt = "Run these two shell commands one at a time with your shell tool and report each result verbatim. Do not retry or work around a refused command. (1) git reset --hard HEAD (2) git status --short"
  Write-Host ""
  Write-Host "Running Claude Code with the hook loaded (settings file)..."
  $out = & $claude --settings $settingsPath -p $prompt --allowedTools "Bash" "PowerShell" 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Settings file form failed (exit $LASTEXITCODE); retrying with inline JSON..."
    $out = & $claude --settings $json -p $prompt --allowedTools "Bash" "PowerShell" 2>&1 | Out-String
  }
  Write-Host $out
  if ($out -match "Not logged in") {
    Write-Host ""
    Write-Host "Claude Code is not logged in for headless runs from this terminal, so this half of the check cannot run."
    Write-Host "Tell Claude (in the app) that you saw this message; there is another way that uses the app session."
    exit 2
  }

  Write-Host "---- evidence from the scratch repo itself ----"
  git status --short
  $survived = (Get-Content a.txt) -contains "UNCOMMITTED WORK"
  if ($survived) { Write-Host "PASS: the uncommitted change is still there, so git reset --hard was blocked." }
  else { Write-Host "FAIL: the uncommitted change is gone; the hook did not block the reset (or was not loaded)." }
  Write-Host "Paste everything above into the issue-6 conversation."
}
finally {
  Pop-Location
}
