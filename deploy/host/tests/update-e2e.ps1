<#
.SYNOPSIS
  Open Design -- host-runtime UPDATE end-to-end test (Windows).

.DESCRIPTION
  Logic port of deploy/host/tests/update-e2e.sh -- same two-stage design,
  same version numbers, same assertions. See that script's header comment
  for the full rationale; this file only documents where the Windows path
  diverges (install.ps1 flags, HKCU Run instead of a launchd label, an
  in-process HttpListener instead of `python3 -m http.server`).

  Stage 1 (installer path): installs the real N-1 release from the public
  mirror via install.ps1, then runs THAT SAME installer's own -Update
  against a throwaway local mirror serving version 9.9.1; asserts
  /api/update/status currentVersion == 9.9.1.

  Stage 2 (Web-UI path): points OD_RELEASE_URL (via config.env) at a second
  local mirror serving version 9.9.2, restarts (install.ps1 -Stop / -Start),
  then calls POST /api/update/apply exactly like the Web UI's "Cap nhat"
  button and polls GET /api/update/status until currentVersion == 9.9.2.
  install.ps1's own -Update, when invoked by the daemon itself
  (OD_SELF_UPDATE=1, set by the daemon's spawn -- see
  apps/daemon/src/server.ts's POST /api/update/apply), cannot restart the
  daemon in-place on Windows (the running .exe/dll would be locked) and
  instead reports state 'restart-required' and exits; this script handles
  that by running `install.ps1 -Start` and continuing to poll, exactly as
  the spec requires.

  Unlike the macOS script, this one has no scratch-HOME mode: a Windows
  CI runner has no pre-existing Open Design install to protect, so the
  guard below simply refuses to run if %USERPROFILE%\.open-design (or the
  HKCU Run entry) already exists, rather than needing an isolated HOME.

.NOTES
  Verified via `pwsh -NoProfile -Command` syntax parse + review against
  update-e2e.sh -- NOT executed locally (this repo's dev machine is
  macOS). Proven only when CI actually runs the update-e2e-windows job.
#>

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$PSNativeCommandUseErrorActionPreference = $false

if ($env:OS -ne "Windows_NT") {
  throw "update-e2e.ps1 only runs on Windows (env:OS = '$($env:OS)')"
}

# ---------------------------------------------------------------------------
# Config from env (mirrors update-e2e.sh's env contract)
# ---------------------------------------------------------------------------
$OdE2ETarball = $env:OD_E2E_TARBALL
if (-not $OdE2ETarball) { throw "set OD_E2E_TARBALL to the built .tar.gz path (see scripts/host-runtime/build-runtime.sh)" }
$OdE2ETarball = (Resolve-Path -LiteralPath $OdE2ETarball).Path
if (-not (Test-Path $OdE2ETarball -PathType Leaf)) { throw "OD_E2E_TARBALL not found: $OdE2ETarball" }

$OdE2EPlatform = if ($env:OD_E2E_PLATFORM) { $env:OD_E2E_PLATFORM } else { "win32-x64" }
$OdE2EServePort = if ($env:OD_E2E_SERVE_PORT) { [int]$env:OD_E2E_SERVE_PORT } else { 8919 }
$OdE2EPort = if ($env:OD_E2E_PORT) { [int]$env:OD_E2E_PORT } else { 7456 }

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$ServiceRunValueName = "OpenDesignDaemon"
$MirrorBaseUrl = "https://od-runtime.pages.dev/latest"
$GhRepo = "ducanhlaminh/open-design-vnpay"
$V1 = "9.9.1"
$V2 = "9.9.2"
$OdHome = Join-Path $env:USERPROFILE ".open-design"
$CurrentInstall = Join-Path $OdHome "current\install.ps1"

function Write-Log($msg) { Write-Output "[update-e2e] $msg" }
function Write-PhaseLog($msg) { Write-Output "`n[update-e2e] ==== $msg ====" }

# ---------------------------------------------------------------------------
# State tracked for teardown/dump
# ---------------------------------------------------------------------------
$Work = $null
$HttpJob = $null
$Bootstrapped = $false

function Get-Sha256Hex($Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLower() }
    finally { $stream.Dispose() }
  } finally { $sha.Dispose() }
}

function Wait-OdHealthLocal {
  param([int]$Port, [int]$TimeoutSec = 60)
  $elapsed = 0
  while ($elapsed -lt $TimeoutSec) {
    try {
      $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5
      return
    } catch {
      Start-Sleep -Seconds 2
      $elapsed += 2
    }
  }
  throw "daemon did not become healthy on port $Port within $TimeoutSec s"
}

function Test-OdPortInUse {
  param([int]$Port)
  $listener = $null
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    return $false
  } catch {
    return $true
  } finally {
    if ($listener) { $listener.Stop() }
  }
}

# ---------------------------------------------------------------------------
# Dump + teardown
# ---------------------------------------------------------------------------
function Write-OdDumpLogs {
  Write-Log "---- dumping logs for debugging ----"
  $dataDir = Join-Path $env:USERPROFILE "od-data\open-design"
  $cfg = Join-Path $OdHome "config.env"
  if (Test-Path $cfg) {
    $m = Select-String -Path $cfg -Pattern '^OD_DATA_DIR=(.*)$' -ErrorAction SilentlyContinue | Select-Object -Last 1
    if ($m) { $dataDir = $m.Matches[0].Groups[1].Value }
  }
  foreach ($f in @(
      (Join-Path $dataDir "update.log"),
      (Join-Path $dataDir "update-state.json"),
      (Join-Path $OdHome "logs\open-design.out.log"),
      (Join-Path $OdHome "logs\open-design.err.log")
    )) {
    Write-Output "===== $f (last 200 lines)"
    if (Test-Path $f) { Get-Content -Path $f -Tail 200 } else { Write-Output "(missing)" }
  }
}

function Invoke-OdTeardown {
  param([bool]$Failed)

  if ($Failed) {
    try { Write-OdDumpLogs } catch { Write-Log "dump-logs failed: $($_.Exception.Message)" }
  }
  Write-Log "---- teardown ----"

  if ($HttpJob) {
    try { Stop-Job $HttpJob -ErrorAction SilentlyContinue | Out-Null } catch {}
    try { Remove-Job $HttpJob -Force -ErrorAction SilentlyContinue } catch {}
  }

  if ($Bootstrapped -and (Test-Path $CurrentInstall)) {
    try { & $CurrentInstall -Uninstall -Force -DeleteData *>$null } catch {}
  }

  # Best-effort direct cleanup in case -Uninstall itself failed/was skipped
  # -- mirrors smoke-test-windows job's own unconditional Cleanup step.
  $pidFile = Join-Path $OdHome "open-design.pid"
  if (Test-Path $pidFile) {
    $daemonPid = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue)
    if ($daemonPid) {
      $daemonPid = $daemonPid.Trim()
      try { Stop-Process -Id $daemonPid -Force -ErrorAction Stop } catch { try { taskkill.exe /PID $daemonPid /T /F 2>$null } catch {} }
    }
  }
  try { schtasks /Delete /TN "OpenDesignDaemon" /F 2>$null } catch {}
  Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name $ServiceRunValueName -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $OdHome -ErrorAction SilentlyContinue

  if ($Work -and (Test-Path $Work)) { Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue }

  $global:LASTEXITCODE = 0
}

# ---------------------------------------------------------------------------
# Safety guard -- a Windows CI runner is always fresh, but never assume it:
# refuse to run over an existing install rather than silently colliding
# with it.
# ---------------------------------------------------------------------------
function Invoke-OdGuardPreflight {
  if (Test-Path $OdHome) {
    throw "guard: $OdHome already exists -- refusing to run (this script assumes a machine with no existing Open Design install)"
  }
  $existingRun = (Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name $ServiceRunValueName -ErrorAction SilentlyContinue).$ServiceRunValueName
  if ($existingRun) {
    throw "guard: HKCU Run entry '$ServiceRunValueName' already exists -- refusing to run"
  }
  if (Test-OdPortInUse -Port $OdE2EPort) { throw "guard: port $OdE2EPort (OD_E2E_PORT) is already in use" }
  if (Test-OdPortInUse -Port $OdE2EServePort) { throw "guard: port $OdE2EServePort (OD_E2E_SERVE_PORT) is already in use" }
  Write-Log "guard OK -- no existing install, ports $OdE2EPort/$OdE2EServePort free"
}

# ---------------------------------------------------------------------------
# Build the two local-mirror release trees from ONE already-built tarball.
# ---------------------------------------------------------------------------
function New-OdRepackedRelease {
  param([string]$Version, [string]$DestDir, [string]$UrlPath)

  $stage = Join-Path $Work "extract-$Version"
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null

  & tar.exe -xzf $OdE2ETarball -C $stage
  if ($LASTEXITCODE -ne 0) { throw "tar extract failed for $Version (exit $LASTEXITCODE)" }

  $topDirs = @(Get-ChildItem -Path $stage -Directory)
  if ($topDirs.Count -ne 1) { throw "expected exactly one top-level directory in $OdE2ETarball, found $($topDirs.Count)" }
  $topDir = $topDirs[0]
  $versionFile = Join-Path $topDir.FullName "VERSION"
  if (-not (Test-Path $versionFile)) { throw "tarball is missing VERSION at its root: $versionFile" }

  # The ONLY place install.ps1 / the daemon read the version from at
  # runtime -- see readCurrentAppVersionInfo() via config.env's
  # OD_APP_VERSION, written by install.ps1 from this exact file.
  Set-Content -Path $versionFile -Value $Version -NoNewline

  New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
  $outName = "open-design-runtime-$Version-$OdE2EPlatform.tar.gz"
  $outPath = Join-Path $DestDir $outName

  Push-Location $stage
  try {
    & tar.exe -czf $outPath $topDir.Name
    if ($LASTEXITCODE -ne 0) { throw "tar create failed for $Version (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }

  $sha = Get-Sha256Hex $outPath
  Set-Content -Path "$outPath.sha256" -Value $sha -NoNewline

  Copy-Item (Join-Path $RepoRoot "deploy\host\install.sh") (Join-Path $DestDir "install.sh") -Force
  Copy-Item (Join-Path $RepoRoot "deploy\host\install.ps1") (Join-Path $DestDir "install.ps1") -Force

  Push-Location $DestDir
  try {
    node --experimental-strip-types (Join-Path $RepoRoot "scripts\host-runtime\build-release-manifest.ts") `
      --version $Version --tag "test-$Version" --repo $GhRepo `
      --base-url "http://127.0.0.1:$OdE2EServePort/$UrlPath" --out release.json
    if ($LASTEXITCODE -ne 0) { throw "build-release-manifest.ts failed for $Version (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
  Write-Log "repacked $Version -> $outPath (release.json base-url http://127.0.0.1:$OdE2EServePort/$UrlPath)"
}

function Start-OdLocalMirror {
  param([string]$RootDir, [int]$Port)
  # In-process HttpListener background job -- no external dependency
  # (python presence on the runner image is not guaranteed), least code
  # of the options the spec allows.
  Start-Job -Name "od-e2e-mirror" -ScriptBlock {
    param($RootDir, $Port)
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://127.0.0.1:$Port/")
    $listener.Start()
    while ($listener.IsListening) {
      try {
        $context = $listener.GetContext()
      } catch {
        break
      }
      try {
        $rel = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
        $path = Join-Path $RootDir $rel
        if ((Test-Path $path -PathType Leaf)) {
          $bytes = [System.IO.File]::ReadAllBytes($path)
          $context.Response.ContentLength64 = $bytes.Length
          $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
          $context.Response.StatusCode = 404
        }
      } catch {
      } finally {
        $context.Response.OutputStream.Close()
      }
    }
  } -ArgumentList $RootDir, $Port
}

function Invoke-OdBuildLocalMirror {
  Write-PhaseLog "Build local mirror (9.9.1 + 9.9.2 from $OdE2ETarball)"
  $script:Work = Join-Path ([System.IO.Path]::GetTempPath()) ("od-e2e-work-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $Work | Out-Null
  $serveRoot = Join-Path $Work "serve"

  New-OdRepackedRelease -Version $V1 -DestDir (Join-Path $serveRoot "latest") -UrlPath "latest"
  New-OdRepackedRelease -Version $V2 -DestDir (Join-Path $serveRoot "latest2") -UrlPath "latest2"

  Write-Log "starting local mirror HttpListener on :$OdE2EServePort (serving $serveRoot)"
  $script:HttpJob = Start-OdLocalMirror -RootDir $serveRoot -Port $OdE2EServePort
  Start-Sleep -Seconds 1
  if ($HttpJob.State -eq "Failed") { throw "local mirror HttpListener job failed to start: $(Receive-Job $HttpJob -Keep)" }

  $ok = $false
  for ($i = 0; $i -lt 20; $i++) {
    try {
      $null = Invoke-WebRequest -Uri "http://127.0.0.1:$OdE2EServePort/latest/release.json" -UseBasicParsing -TimeoutSec 3
      $ok = $true
      break
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $ok) { throw "local mirror HttpListener not responding on :$OdE2EServePort" }
  Write-Log "[ok] local mirror serving on http://127.0.0.1:$OdE2EServePort"
}

# ---------------------------------------------------------------------------
# Stage 1 -- N-1 real installer -> its own -Update against local mirror v1
# ---------------------------------------------------------------------------
function Invoke-OdStage1 {
  Write-PhaseLog "Stage 1a: install N-1 (real) from $MirrorBaseUrl"
  $t0 = Get-Date
  $n1Installer = Join-Path $Work "n1-install.ps1"
  Invoke-WebRequest -Uri "$MirrorBaseUrl/install.ps1" -OutFile $n1Installer -UseBasicParsing -TimeoutSec 60

  & $n1Installer -Port $OdE2EPort
  if ($LASTEXITCODE -ne 0) { throw "N-1 install.ps1 -Port $OdE2EPort exited $LASTEXITCODE" }
  $script:Bootstrapped = $true
  Wait-OdHealthLocal -Port $OdE2EPort -TimeoutSec 60
  Write-Log "[ok] N-1 installed and healthy on port $OdE2EPort"

  Write-PhaseLog "Stage 1b: update via bundled installer -Update -> target $V1"
  if (-not (Test-Path $CurrentInstall)) { throw "bundled install.ps1 not found at $CurrentInstall after N-1 install" }
  $env:OD_RELEASE_URL = "http://127.0.0.1:$OdE2EServePort/latest"
  try {
    & $CurrentInstall -Update
    if ($LASTEXITCODE -ne 0) { throw "install.ps1 -Update exited $LASTEXITCODE" }
  } finally {
    Remove-Item Env:\OD_RELEASE_URL -ErrorAction SilentlyContinue
  }

  Wait-OdHealthLocal -Port $OdE2EPort -TimeoutSec 60
  $status1 = Invoke-RestMethod -Uri "http://127.0.0.1:$OdE2EPort/api/update/status" -TimeoutSec 10
  if ($status1.currentVersion -ne $V1) {
    throw "stage 1: expected /api/update/status currentVersion=$V1, got '$($status1.currentVersion)'"
  }
  $t1 = Get-Date
  Write-Log "[ok] stage 1 PASS: N-1 -> $V1 in $([int]($t1 - $t0).TotalSeconds)s"
}

# ---------------------------------------------------------------------------
# Stage 2 -- Web-UI path (POST /api/update/apply) on the daemon HEAD build
# just installed by stage 1, target v2.
# ---------------------------------------------------------------------------
function Invoke-OdStage2 {
  $t0 = Get-Date
  Write-PhaseLog "Stage 2a: point OD_RELEASE_URL at local mirror v2 + restart"
  $configPath = Join-Path $OdHome "config.env"
  if (-not (Test-Path $configPath)) { throw "missing $configPath" }
  $newUrlLine = "OD_RELEASE_URL=http://127.0.0.1:$OdE2EServePort/latest2"
  $lines = Get-Content -Path $configPath
  if ($lines -match '^OD_RELEASE_URL=') {
    $lines = $lines -replace '^OD_RELEASE_URL=.*$', $newUrlLine
  } else {
    $lines = $lines + $newUrlLine
  }
  Set-Content -Path $configPath -Value $lines

  & $CurrentInstall -Stop
  if ($LASTEXITCODE -ne 0) { throw "install.ps1 -Stop exited $LASTEXITCODE" }
  & $CurrentInstall -Start
  if ($LASTEXITCODE -ne 0) { throw "install.ps1 -Start exited $LASTEXITCODE" }
  Wait-OdHealthLocal -Port $OdE2EPort -TimeoutSec 60
  Write-Log "[ok] daemon restarted with OD_RELEASE_URL -> $newUrlLine"

  Write-PhaseLog "Stage 2b: POST /api/update/apply -> poll /api/update/status -> target $V2"
  $applyResp = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$OdE2EPort/api/update/apply" -TimeoutSec 15
  Write-Log "apply response: $($applyResp | ConvertTo-Json -Compress)"

  $restartHandled = $false
  $finalStatus = $null
  $deadline = (Get-Date).AddSeconds(300)
  while ((Get-Date) -lt $deadline) {
    $status = $null
    try { $status = Invoke-RestMethod -Uri "http://127.0.0.1:$OdE2EPort/api/update/status" -TimeoutSec 5 } catch {}
    if ($status) {
      $stateIsNullOrHealthy = (-not $status.state) -or ($status.state -eq "healthy")
      if ($status.currentVersion -eq $V2 -and $stateIsNullOrHealthy) {
        $finalStatus = $status
        break
      }
      if ($status.state -eq "restart-required" -and -not $restartHandled) {
        $restartHandled = $true
        Write-Log "[info] state=restart-required -- running install.ps1 -Start to complete the update (Windows cannot self-replace a running exe)"
        & $CurrentInstall -Start
        if ($LASTEXITCODE -ne 0) { throw "install.ps1 -Start (after restart-required) exited $LASTEXITCODE" }
        Wait-OdHealthLocal -Port $OdE2EPort -TimeoutSec 60
        continue
      }
    }
    Start-Sleep -Seconds 2
  }
  if (-not $finalStatus) {
    throw "stage 2: /api/update/status never reported currentVersion=$V2 with state healthy/null within 300s"
  }
  Write-Log "[ok] currentVersion=$V2 state='$($finalStatus.state)'"

  Write-PhaseLog "Stage 2c: assert /api/skills > 0 (config.env -> process env regression)"
  $skills = Invoke-RestMethod -Uri "http://127.0.0.1:$OdE2EPort/api/skills" -TimeoutSec 10
  if (-not $skills.skills -or $skills.skills.Count -eq 0) {
    throw "/api/skills returned 0 skills after update to $V2"
  }
  Write-Log "[ok] /api/skills returned $($skills.skills.Count) skills"

  $t1 = Get-Date
  Write-Log "[ok] stage 2 PASS: $V1 -> $V2 via Web-UI apply in $([int]($t1 - $t0).TotalSeconds)s"
}

$failed = $false
try {
  Invoke-OdGuardPreflight
  Invoke-OdBuildLocalMirror
  Invoke-OdStage1
  Invoke-OdStage2
  Write-Log "ALL STAGES PASSED"
} catch {
  $failed = $true
  Write-Log "FAILED: $($_.Exception.Message)"
  throw
} finally {
  Invoke-OdTeardown -Failed:$failed
}
