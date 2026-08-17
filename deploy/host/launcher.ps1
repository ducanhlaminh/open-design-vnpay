<#
  Per-user Open Design launcher/supervisor for Windows.

  This script is copied to %USERPROFILE%\.open-design\launcher.ps1 so it
  remains stable while the `current` Junction changes during an update. It
  requires no elevation and is started through HKCU Run.
#>
[CmdletBinding()]
param(
  [string]$OdHome = (Join-Path $env:USERPROFILE ".open-design")
)

$ErrorActionPreference = "Stop"
$launcherPath = Join-Path $OdHome "launcher.ps1"
$launcherPidPath = Join-Path $OdHome "launcher.pid"
$stopRequestPath = Join-Path $OdHome "launcher-stop.request"
$restartRequestPath = Join-Path $OdHome "restart-request.json"
$daemonPidPath = Join-Path $OdHome "open-design.pid"
$maintenancePath = Join-Path $OdHome "maintenance.lock"
$transactionPath = Join-Path $OdHome "update-transaction.json"
$logPath = Join-Path $OdHome "logs\launcher.log"
$lastStartAttempt = [DateTime]::MinValue
$failedOperationId = ""

function Write-LauncherLog {
  param([string]$Message)
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $logPath -Parent) | Out-Null
    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $Message" -ErrorAction SilentlyContinue
  } catch {}
}

function Test-DaemonAlive {
  if (-not (Test-Path $daemonPidPath)) { return $false }
  $savedPid = (Get-Content -LiteralPath $daemonPidPath -Raw -ErrorAction SilentlyContinue)
  if (-not $savedPid) { return $false }
  $savedPid = $savedPid.Trim()
  if ($savedPid -notmatch '^\d+$') { return $false }
  if ($null -eq (Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue)) { return $false }
  try {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction Stop
    return [bool]($processInfo.CommandLine -and
      ($processInfo.CommandLine -match 'apps[\\/]daemon[\\/]dist[\\/]cli\.js'))
  } catch {
    # Process existence is still a better liveness signal than starting a
    # duplicate daemon when WMI is temporarily unavailable.
    return $true
  }
}

function Test-MaintenanceActive {
  if (-not (Test-Path $maintenancePath)) { return $false }
  $ownerPid = (Get-Content -LiteralPath $maintenancePath -Raw -ErrorAction SilentlyContinue)
  if ($ownerPid) { $ownerPid = $ownerPid.Trim() }
  if ($ownerPid -notmatch '^\d+$' -or
      $null -eq (Get-Process -Id ([int]$ownerPid) -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $maintenancePath -Force -ErrorAction SilentlyContinue
    return $false
  }
  try {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction Stop
    $active = [bool]($processInfo.CommandLine -and ($processInfo.CommandLine -match 'install\.ps1'))
    if (-not $active) { Remove-Item -LiteralPath $maintenancePath -Force -ErrorAction SilentlyContinue }
    return $active
  } catch {
    # If ownership cannot be verified while the recorded process still
    # exists, wait rather than race a potentially active installer.
    return $true
  }
}

function Invoke-InstalledStart {
  $installer = Join-Path $OdHome "current\install.ps1"
  if (-not (Test-Path $installer)) {
    Write-LauncherLog "current installer is missing: $installer"
    return 1
  }
  $shellExe = (Get-Process -Id $PID).Path
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$installer`" -Start"
  try {
    $proc = Start-Process -FilePath $shellExe -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
    return $proc.ExitCode
  } catch {
    Write-LauncherLog "could not invoke installed start: $($_.Exception.Message)"
    return 1
  }
}

# One launcher per interactive user/home. The hash keeps the mutex name
# valid and prevents a custom -OdHome instance colliding with the default.
$sha = [System.Security.Cryptography.SHA256]::Create()
$homeBytes = [System.Text.Encoding]::UTF8.GetBytes([System.IO.Path]::GetFullPath($OdHome).ToLowerInvariant())
$homeHash = ([System.BitConverter]::ToString($sha.ComputeHash($homeBytes))).Replace('-', '').Substring(0, 16)
$mutex = New-Object System.Threading.Mutex($false, "Local\OpenDesignLauncher-$homeHash")
$ownsMutex = $false
try {
  $ownsMutex = $mutex.WaitOne(0, $false)
  if (-not $ownsMutex) { exit 0 }

  New-Item -ItemType Directory -Force -Path $OdHome | Out-Null
  Remove-Item -LiteralPath $stopRequestPath -Force -ErrorAction SilentlyContinue
  Set-Content -LiteralPath $launcherPidPath -Value $PID -NoNewline
  Write-LauncherLog "launcher started (pid $PID)"

  while (-not (Test-Path $stopRequestPath)) {
    if (Test-Path $restartRequestPath) {
      try {
        $request = (Get-Content -LiteralPath $restartRequestPath -Raw) | ConvertFrom-Json
        $operationId = [string]$request.operationId
        if (-not $operationId) { throw "restart request has no operationId" }
        if ($operationId -ne $failedOperationId) {
          Write-LauncherLog "handling update restart $operationId"
          # The installed -Start command owns stopping the old daemon,
          # health verification, durable commit and rollback.
          $exitCode = Invoke-InstalledStart
          if ($exitCode -eq 0) {
            Remove-Item -LiteralPath $restartRequestPath -Force -ErrorAction SilentlyContinue
            $failedOperationId = ""
            Write-LauncherLog "update restart $operationId completed"
          } else {
            $failedOperationId = $operationId
            Write-LauncherLog "update restart $operationId failed with exit code $exitCode; request retained"
          }
        }
      } catch {
        Write-LauncherLog "invalid restart request: $($_.Exception.Message)"
      }
    } elseif (-not (Test-DaemonAlive)) {
      # Avoid a tight crash loop while still recovering automatically from a
      # daemon exit or from a reboot with a pending durable transaction.
      # An active installer holds maintenance.lock before changing current;
      # only a durable transaction makes it safe for a new launcher session
      # to resume that interrupted update.
      $maintenanceBlocksStart = (Test-MaintenanceActive) -and -not (Test-Path $transactionPath)
      if ((-not $maintenanceBlocksStart) -and ((Get-Date) - $lastStartAttempt).TotalSeconds -ge 10) {
        $lastStartAttempt = Get-Date
        $exitCode = Invoke-InstalledStart
        Write-LauncherLog "daemon start exited $exitCode"
      }
    }
    Start-Sleep -Seconds 2
  }
  Write-LauncherLog "launcher stop requested"
} finally {
  if ($ownsMutex) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
  if (Test-Path $launcherPidPath) {
    $recordedPid = (Get-Content -LiteralPath $launcherPidPath -Raw -ErrorAction SilentlyContinue)
    if ($recordedPid -and $recordedPid.Trim() -eq "$PID") {
      Remove-Item -LiteralPath $launcherPidPath -Force -ErrorAction SilentlyContinue
    }
  }
  Remove-Item -LiteralPath $stopRequestPath -Force -ErrorAction SilentlyContinue
}
