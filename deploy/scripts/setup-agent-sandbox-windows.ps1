# Open Design — Agent Sandbox Setup (Windows)
#
# Prepares a fresh Windows machine to run the open-design-vnpay desktop app
# with the agent-in-sandbox feature ready on first launch: enables WSL2,
# installs Docker Desktop if missing, then builds the two images the app
# needs (uireact-base + od-agent-sandbox) so nothing has to build lazily the
# first time a chat/pipeline run happens.
#
# IMPORTANT — this is NOT a single silent pass on a truly blank machine:
#   - Enabling WSL2 (`wsl --install`) on a machine that has never used it
#     requires a REBOOT before Docker Desktop can run. This script detects
#     that case, prints instructions, and exits — RE-RUN it after rebooting.
#   - Docker Desktop's first-run service agreement needs a human click.
#   - `od sandbox login` (Claude CLI OAuth) is intentionally interactive and
#     cannot be scripted. Run it once yourself after this script finishes.
#
# Usage (run from an elevated PowerShell — installing Docker/WSL2 needs it):
#   .\setup-agent-sandbox-windows.ps1 [-NonInteractive]

param(
  [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$BuilderDir = Join-Path $RepoRoot "skills\ui-react\builder"
$SandboxDir = Join-Path $BuilderDir "sandbox"

function Write-Step($msg)  { Write-Host "  > $msg" -ForegroundColor DarkGray }
function Write-Ok($msg)    { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-ErrorMsg($msg) { Write-Host "  [x] $msg" -ForegroundColor Red }
function Write-Info($msg)  { Write-Host "  > $msg" -ForegroundColor Cyan }

function Confirm-Step($question) {
  if ($NonInteractive) { return $true }
  $answer = Read-Host "$question [y/N]"
  return $answer -match '^[Yy]'
}

Write-Host ""
Write-Host "Open Design - agent sandbox setup (Windows)" -ForegroundColor White
Write-Host ""

# ---------------------------------------------------------------------------
# 0. Must run elevated — installing WSL2/Docker needs it.
# ---------------------------------------------------------------------------
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-ErrorMsg "Run this script from an elevated (Administrator) PowerShell."
  exit 1
}

# ---------------------------------------------------------------------------
# 1. WSL2 — required before Docker Desktop can run at all. A machine that
#    has never enabled it needs a reboot before continuing; this step is
#    re-run-safe: it just no-ops on a second pass once WSL2 is ready.
# ---------------------------------------------------------------------------
Write-Step "Checking WSL2..."
$wslReady = $false
try {
  $wslStatus = wsl --status 2>&1
  if ($LASTEXITCODE -eq 0) { $wslReady = $true }
} catch {
  $wslReady = $false
}

if (-not $wslReady) {
  Write-Warn "WSL2 is not set up yet."
  if ($NonInteractive -or (Confirm-Step "Enable WSL2 now (wsl --install)? This requires a REBOOT afterward")) {
    Write-Step "Running: wsl --install"
    wsl --install
    Write-Host ""
    Write-Warn "WSL2 was just enabled. RESTART your computer now, then re-run this script to continue."
    exit 0
  } else {
    Write-ErrorMsg "WSL2 is required for Docker Desktop on Windows. Enable it and re-run."
    exit 1
  }
}
Write-Ok "WSL2 is ready."

# ---------------------------------------------------------------------------
# 2. Docker Desktop: detect, install if missing, wait for the daemon
# ---------------------------------------------------------------------------
Write-Step "Checking for Docker..."
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCmd) {
  Write-Warn "Docker is not installed."
  if ($NonInteractive -or (Confirm-Step "Install Docker Desktop now (winget)?")) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
      Write-ErrorMsg "winget is not available. Install Docker Desktop manually: https://www.docker.com/products/docker-desktop/"
      exit 1
    }
    Write-Step "Running: winget install -e --id Docker.DockerDesktop"
    winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
    Write-Ok "Docker Desktop installed."
    Write-Warn "A sign-out/restart may be required for group membership (docker-users) to take effect."
    # winget updates the registry PATH, but this already-running PowerShell
    # process won't see it until we re-read it — otherwise `docker` stays
    # "not found" for the rest of THIS run even though it just installed.
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
      [System.Environment]::GetEnvironmentVariable("Path", "User")
  } else {
    Write-ErrorMsg "Docker is required. Install it from https://www.docker.com/products/docker-desktop/ and re-run."
    exit 1
  }
} else {
  Write-Ok "Docker is already installed."
}

$dockerRunning = $false
try {
  docker info *> $null
  if ($LASTEXITCODE -eq 0) { $dockerRunning = $true }
} catch {
  $dockerRunning = $false
}

if (-not $dockerRunning) {
  Write-Warn "Docker is installed but not running — starting Docker Desktop."
  $dockerExe = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
  if (Test-Path $dockerExe) {
    Start-Process $dockerExe
  }
  Write-Step "Waiting for Docker Desktop to start (first launch may ask you to accept its service agreement - do that now)..."
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 3
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  }
  if (-not $ready) {
    Write-ErrorMsg "Docker still isn't running after 3 minutes. Open Docker Desktop manually, wait for it to be ready, and re-run this script."
    exit 1
  }
}
Write-Ok "Docker is running."

# ---------------------------------------------------------------------------
# 3. Build both images ahead of time (uireact-base -> od-agent-sandbox)
#    Mirrors skills/ui-react/builder/build-base.sh + sandbox/build-sandbox.sh
#    in native PowerShell (no bash dependency on a fresh Windows machine).
# ---------------------------------------------------------------------------
Write-Host ""
$toolkitVersion = (Get-Content (Join-Path $BuilderDir "base\toolkit.version") -Raw).Trim()
$sandboxVersion = (Get-Content (Join-Path $SandboxDir "sandbox.version") -Raw).Trim()
$claudeVersion = (Get-Content (Join-Path $SandboxDir "claude.version") -Raw).Trim()
$platform = if ($env:OD_DOCKER_PLATFORM) { $env:OD_DOCKER_PLATFORM } else { "linux/amd64" }

$baseImage = "uireact-base:$toolkitVersion"
docker image inspect $baseImage *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Step "Building $baseImage ($platform, installs the full toolkit - a few minutes)..."
  docker build --platform $platform -t $baseImage -t "uireact-base:latest" -f (Join-Path $BuilderDir "Dockerfile") $BuilderDir
  Write-Ok "Built $baseImage."
} else {
  Write-Ok "$baseImage already present."
}

$sandboxImage = "od-agent-sandbox:$sandboxVersion"
docker image inspect $sandboxImage *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Step "Building $sandboxImage ($platform, base uireact-base:$toolkitVersion, claude $claudeVersion)..."
  docker build --platform $platform `
    --build-arg TOOLKIT_VERSION=$toolkitVersion `
    --build-arg CLAUDE_CODE_VERSION=$claudeVersion `
    -t $sandboxImage -t "od-agent-sandbox:latest" `
    -f (Join-Path $SandboxDir "Dockerfile") $SandboxDir
  Write-Ok "Built $sandboxImage."
} else {
  Write-Ok "$sandboxImage already present."
}

# ---------------------------------------------------------------------------
# 4. What's still manual
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "Done. Docker + both sandbox images are ready." -ForegroundColor White
Write-Host ""
Write-Info "One manual step remains - log the sandboxed Claude CLI in (interactive OAuth, cannot be scripted):"
Write-Host ""
Write-Host "    docker run -it --rm -v od-claude-auth:/home/node/.claude $sandboxImage claude /login"
Write-Host ""
Write-Info "After that, open-design-vnpay is ready to run chat/pipelines with zero host Claude CLI install."
