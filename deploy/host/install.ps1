<#
.SYNOPSIS
  Open Design -- host runtime one-command installer for Windows.

.DESCRIPTION
  Installs the daemon + static web export directly on a 64-bit Windows 10
  (1803+) / Windows 11 host, no Docker required. This is a step-for-step
  mirror of deploy/host/install.sh (same 6 phases, same phase names/order,
  same config.env shape, same rollback behavior) -- NOT a syntax port, a
  logic port. Native Windows primitives replace the POSIX ones:

    - HKCU Run registration (current-user registry, no admin) instead of a
      launchd LaunchAgent / systemd --user unit.
    - A directory Junction (New-Item -ItemType Junction, no admin/Developer
      Mode required -- unlike a real symlink) instead of `ln -sfn`.
    - tar.exe (bundled since Windows 10 1803 / Windows 11 -- this is the
      minimum supported Windows version) instead of GNU tar, for the same
      "list before extract" `..`-traversal + single-root-dir safety check.
    - .NET SHA256 via Get-OdFileSha256 (the built-in hashing cmdlet lives
      in a script module that fails to auto-load when powershell.exe
      inherits a pwsh 7 PSModulePath) instead
      of sha256sum/shasum.

  No sudo/admin is used anywhere -- everything lives under
  %USERPROFILE%\.open-design by default, exactly like install.sh keeps
  everything under $HOME.

.PARAMETER Archive
  Use a local tarball instead of downloading.

.PARAMETER InsecureTls
  Turn off TLS certificate validation for this installer process only.
  For corporate networks whose proxy/firewall re-signs github.com (the
  browser trusts the enterprise root, .NET here does not -> TrustFailure).
  Preflight switches this on by itself when it detects exactly that
  (TrustFailure on github.com) -- the flag forces it up front. Saved as
  OD_INSECURE_TLS=1 in config.env so -Update keeps working. Prefer
  installing the proxy root CA into Windows Trusted Root instead.

.PARAMETER ReleaseUrl
  A direct .tar.gz URL, or a release "asset base" URL (e.g. a GitHub
  releases/download/<tag> folder, or a mirror folder) containing a
  release.json manifest. Default: the OD_RELEASE_URL environment variable,
  then OD_RELEASE_URL from an existing config.env (so -Update keeps using
  the same mirror), then the latest GitHub release of this repo.
  A base URL given here (or via OD_RELEASE_URL) is persisted as
  OD_RELEASE_URL in config.env; a direct .tar.gz URL is not.
  Why a mirror: corporate networks that TLS-inspect github.com throttle
  release downloads to a few hundred KB/s while non-inspected CDNs run at
  full speed (measured 2026-08-18) -- see deploy/host/README.md.

.PARAMETER Sha256
  Expected sha256 of the tarball -- overrides any discovered .sha256
  sidecar / release.json entry.

.PARAMETER Port
  Daemon port (default: 7456).

.PARAMETER DataDir
  OD_DATA_DIR (default: %USERPROFILE%\od-data\open-design).

.PARAMETER EnvFile
  A URL or local path to KEY=VALUE defaults for MEDIA_*/IDENTITY_URL/
  GOOGLE_CLIENT_*/SESSION_SECRET (an internal mirror env template).
  Individual flags below always take priority over this file.

.PARAMETER MediaUrl
  MEDIA_URL

.PARAMETER MediaAppId
  MEDIA_APP_ID

.PARAMETER MediaUserId
  MEDIA_USER_ID

.PARAMETER MediaUserRole
  MEDIA_USER_ROLE

.PARAMETER IdentityUrl
  IDENTITY_URL

.PARAMETER GoogleClientId
  GOOGLE_CLIENT_ID (Google login -- all three Google flags must be set
  together or login stays off; everything else still works).

.PARAMETER GoogleClientSecret
  GOOGLE_CLIENT_SECRET

.PARAMETER SessionSecret
  SESSION_SECRET

.PARAMETER NoStart
  Install everything but do not start/enable the service.

.PARAMETER Update
  Update an existing %USERPROFILE%\.open-design install in place.

.PARAMETER Start
  Start the daemon from the already-installed release and exit -- does
  NOT extract/verify/reconfigure anything, just start + wait for health.
  Every other install/update flag is ignored when this is given.

.PARAMETER Stop
  Stop the running daemon (by pid file) and exit. Every other
  install/update flag is ignored when this is given.

.PARAMETER Uninstall
  Stop the daemon, remove its per-user auto-start entry, and delete
  %USERPROFILE%\.open-design, then exit. Project data (OD_DATA_DIR) is
  kept unless -DeleteData is also given. Prompts for confirmation unless
  -Force is given. Every other install/update flag is ignored.

.PARAMETER DeleteData
  With -Uninstall, also delete OD_DATA_DIR (project data). Ignored
  without -Uninstall.

.PARAMETER Force
  With -Uninstall, skip the confirmation prompt. Ignored without
  -Uninstall.

.PARAMETER Help
  Show this help and exit.

.EXAMPLE
  irm https://raw.githubusercontent.com/<repo>/<tag>/deploy/host/install.ps1 | iex

.EXAMPLE
  .\install.ps1 -Archive .\open-design-runtime-1.2.3-win32-x64.tar.gz -NoStart

.EXAMPLE
  .\install.ps1 -Stop

.EXAMPLE
  .\install.ps1 -Start

.EXAMPLE
  .\install.ps1 -Uninstall
#>

[CmdletBinding()]
param(
  [string]$Archive = "",
  [string]$ReleaseUrl = "",
  [string]$Sha256 = "",
  [string]$Port = "",
  [string]$DataDir = "",
  [string]$EnvFile = "",
  [string]$MediaUrl = "",
  [string]$MediaAppId = "",
  [string]$MediaUserId = "",
  [string]$MediaUserRole = "",
  [string]$IdentityUrl = "",
  [string]$GoogleClientId = "",
  [string]$GoogleClientSecret = "",
  [string]$SessionSecret = "",
  [switch]$NoStart,
  [switch]$Update,
  [switch]$Start,
  [switch]$Stop,
  [switch]$Uninstall,
  [switch]$DeleteData,
  [switch]$Force,
  [switch]$InsecureTls,
  [switch]$Help
)

# Write-Host throws (HostException: "out of range" / no console) when
# there is no interactive host to write to -- exactly this script's most
# important caller: the daemon's self-update spawn (windowsHide, stdio
# redirected to a raw file descriptor, no console subsystem at all
# -- see POST /api/update/apply in apps/daemon/src/server.ts). Combined
# with `$ErrorActionPreference = "Stop"` below and no local try/catch
# around any individual call site, the very FIRST Write-Host anywhere in
# this script would silently kill the entire run before Write-Phase's own
# Add-Content-based progress logging ever gets a chance to execute.
# Reproduced live: update.log stayed byte-for-byte empty across every
# daemon-triggered update attempt, even after Write-Phase's own logging
# was made crash-proof -- because Write-Phase's two Write-Host calls (and
# Invoke-Main's banner, called before Write-Phase ever runs once) were
# still unprotected. Shadowing the cmdlet here covers every call site in
# the file (there's no reliable way to audit/wrap them all individually,
# and any future one would just reintroduce this bug) by degrading to a
# no-op instead of aborting when there's no host to write to.
function Write-Host {
  param(
    [Parameter(Position = 0)] $Object,
    $ForegroundColor,
    $BackgroundColor,
    [switch]$NoNewline
  )
  try {
    Microsoft.PowerShell.Utility\Write-Host @PSBoundParameters
  } catch {
    # No console/host available -- nothing to write to, not fatal.
  }
}

if ($Help) {
  if ($PSCommandPath) {
    Get-Help $PSCommandPath -Full
  } else {
    Write-Host "Open Design host runtime installer (Windows). See deploy/host/README.md for full docs."
    Write-Host "Env: OD_RELEASE_URL (mirror base URL; same as -ReleaseUrl)"
    Write-Host "Flags: -Archive -ReleaseUrl -Sha256 -Port -DataDir -EnvFile -MediaUrl -MediaAppId -MediaUserId -MediaUserRole -IdentityUrl -GoogleClientId -GoogleClientSecret -SessionSecret -NoStart -Update -Start -Stop -Uninstall -DeleteData -Force -InsecureTls"
  }
  exit 0
}

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# PS 7.3+ promotes any stderr line from a native command (taskkill,
# tar, rmdir, node -v, ...) into a terminating error whenever the process
# exits non-zero -- even when the call already redirects stderr with
# `2>$null`, since that redirect only moves where the text goes, not whether
# PowerShell synthesizes an ErrorRecord from it. This script relies on
# `2>$null` throughout for "best-effort, tolerate already-absent/expected
# failures" native calls, so disable the promotion. Harmless no-op on
# PS 5.1/7.0-7.2, which
# don't read this variable.
$PSNativeCommandUseErrorActionPreference = $false

# ---------------------------------------------------------------------------
# Configuration -- mirrors install.sh's "Configuration" block.
# ---------------------------------------------------------------------------
$DefaultGhRepo = "ducanhlaminh/open-design-vnpay"
# Cloudflare Pages mirror published in parallel with every GitHub Release
# (scripts/host-runtime/mirror-publish.sh: <public>/latest/ carries
# release.json + install.ps1 + install.sh + the runtime tarball). This is
# the DEFAULT release source (not a fallback) when nothing else is
# configured: this installer's user base sits inside the VNPAY network,
# which blocks/TLS-inspects github.com for most users (WP16). GitHub is the
# fallback -- see Resolve-ReleaseUrl/Invoke-PreflightCheck below.
$DefaultMirrorUrl = "https://od-runtime.pages.dev/latest"
$OdHome = Join-Path $env:USERPROFILE ".open-design"
$DefaultPort = 7456
$DefaultDataDir = Join-Path $env:USERPROFILE "od-data\open-design"
# Mirrors apps/daemon/package.json#engines ("~24") -- same cross-reference
# note as install.sh: checked at implementation time rather than parsed at
# install time, so step 1 never depends on a JSON parser being available.
$RequiredNodeMajor = 24
$HealthTimeout = 60
# STALL timeout, not a total one: an attempt fails only when NO bytes arrive
# for this long (headers or body). 0.8.46 report: a 180 s TOTAL cap killed a
# 99 MB runtime tarball at 40% three times in a row on a ~220 KB/s corporate
# link ("A task was canceled."), and every retry started from byte 0.
$DownloadTimeoutSec = 60
$DownloadMaxAttempts = 3
$ProgressBarWidth = 30
$RestartRequiredExitCode = 75
# HKCU Run is writable by the current user and is not gated by the Task
# Scheduler rights/policies that commonly produce Access Denied on managed
# Windows machines. Keep the old task name only for migration cleanup.
$StartupRegistryPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$StartupValueName = "OpenDesignDaemon"
$LegacyTaskName = "OpenDesignDaemon"
$UpdateTransactionPath = Join-Path $OdHome "update-transaction.json"
$RestartRequestPath = Join-Path $OdHome "restart-request.json"
$LauncherPath = Join-Path $OdHome "launcher.ps1"
$LauncherPidPath = Join-Path $OdHome "launcher.pid"
$LauncherStopRequestPath = Join-Path $OdHome "launcher-stop.request"
$MaintenancePath = Join-Path $OdHome "maintenance.lock"
$CommandFileMap = [ordered]@{
  "install.cmd" = "OpenDesign-Install.cmd"
  "update.cmd" = "OpenDesign-Update.cmd"
  "start.cmd" = "OpenDesign-Start.cmd"
  "stop.cmd" = "OpenDesign-Stop.cmd"
}

# ---------------------------------------------------------------------------
# Script-scope mutable state (set by the step functions below).
# ---------------------------------------------------------------------------
$script:ArchivePath = ""
$script:ArchiveShaHint = ""
$script:Platform = ""
$script:StageName = ""
$script:Version = ""
$script:LastHealthVersion = ""
$script:NodeBin = ""
$script:ReleaseDir = ""
$script:PrevCurrent = ""
$script:ResolvedPort = ""
$script:EnvFileVars = @()
$script:ProgressLogPath = $null
$script:TempDirs = @()
$script:StartupRegistered = $false
$script:Activated = $false
$script:HealthSucceeded = $false
$script:RestartHandedOff = $false
$script:RestartRequired = $false
$script:RollbackStarted = $false
$script:ConfigBackupPath = ""
$script:ConfigExisted = $false
$script:ConfigChanged = $false
$script:PreviousReleaseBackup = ""
$script:HandoffTransactionLoaded = $false

if ($Update) {
  $currentLink = Join-Path $OdHome "current"
  $hasCurrent = [bool](Get-Item -LiteralPath $currentLink -Force -ErrorAction SilentlyContinue)
  if (-not $hasCurrent) {
    Write-Error "-Update given but no existing install found at $OdHome (run without -Update first)"
    exit 1
  }
}

# ---------------------------------------------------------------------------
# Small helpers -- style mirrors install.sh's step()/ok()/warn()/error()/info().
# The bracket-tag style ("[ok]", "[!]", "[x]") matches this repo's existing
# Windows script (deploy/scripts/setup-agent-sandbox-windows.ps1) rather than
# install.sh's Unicode glyphs, for console-compatibility.
# ---------------------------------------------------------------------------
function Write-Phase($msg) {
  Write-Host ""
  Write-Host $msg -ForegroundColor White
  # Write-Host is invisible to the daemon's self-update spawn (detached, no
  # console at all -- confirmed on a real machine: update.log stayed
  # completely empty even after a `[Console]::Out`-based attempt at this).
  # Rather than fight PowerShell's console/stdout-redirection abstraction,
  # append straight to update.log's real path -- ordinary file I/O, so it
  # doesn't depend on how (or whether) this process's stdout is wired up.
  # Entirely wrapped in try/catch: this script has global
  # $ErrorActionPreference = "Stop", so an uncaught exception in a helper
  # called from every single step would silently abort the WHOLE
  # install/update before it does anything -- far worse than just not
  # showing a progress bar. Progress reporting must never be able to do that.
  try {
    if (-not $script:ProgressLogPath) {
      $existingDataDir = $null
      $cfgPath = Join-Path $OdHome "config.env"
      if (Test-Path $cfgPath) {
        $line = Get-Content $cfgPath | Where-Object { $_ -match '^OD_DATA_DIR=' } | Select-Object -Last 1
        if ($line) { $existingDataDir = ($line -split '=', 2)[1] }
      }
      # Mirrors Resolve-Cfg's priority, without depending on that function
      # (or $ResolvedDataDir from Write-ConfigEnv, which hasn't run yet for
      # phases 1/6-2/6) -- self-contained since this must work from the very
      # first phase call.
      $dataDir = if ($DataDir) { $DataDir } elseif ($existingDataDir) { $existingDataDir } else { $DefaultDataDir }
      New-Item -ItemType Directory -Force -Path $dataDir -ErrorAction SilentlyContinue | Out-Null
      $script:ProgressLogPath = Join-Path $dataDir "update.log"
    }
    Add-Content -Path $script:ProgressLogPath -Value $msg -ErrorAction SilentlyContinue
  } catch {
    # Best-effort only -- never let a progress-logging failure affect the
    # actual install/update.
  }
}
function Write-Step($msg)  { Write-Host "  > $msg" -ForegroundColor DarkGray }
function Write-Ok($msg)    { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-ErrorMsg($msg) { Write-Host "  [x] $msg" -ForegroundColor Red }
function Write-Info($msg)  { Write-Host "  > $msg" -ForegroundColor Cyan }

function Fail($msg) {
  Write-ErrorMsg $msg
  throw [System.InvalidOperationException]::new($msg)
}

function Assert-Parameters {
  $commandCount = ([int][bool]$Start) + ([int][bool]$Stop) + ([int][bool]$Uninstall)
  if ($commandCount -gt 1) { Fail "-Start, -Stop, and -Uninstall are mutually exclusive" }
  if ($DeleteData -and -not $Uninstall) { Fail "-DeleteData is only valid with -Uninstall" }
  if ($Force -and -not $Uninstall) { Fail "-Force is only valid with -Uninstall" }
  if ($Port) {
    $parsedPort = 0
    if (-not [int]::TryParse($Port, [ref]$parsedPort) -or $parsedPort -lt 1 -or $parsedPort -gt 65535) {
      Fail "-Port must be an integer from 1 to 65535"
    }
  }
}

function New-TempDir {
  $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("od-install-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $script:TempDirs += $dir
  return $dir
}

function Test-InteractiveOutput {
  if ($env:OD_SELF_UPDATE -eq "1") { return $false }
  try { return -not [Console]::IsOutputRedirected } catch { return $false }
}

function Write-DownloadLog([string]$Message) {
  try {
    if ($script:ProgressLogPath) {
      Add-Content -Path $script:ProgressLogPath -Value $Message -ErrorAction SilentlyContinue
    }
  } catch {
    # Download telemetry is best-effort and must never affect installation.
  }
}

# Streams downloads to a .partial file so a timeout/cancellation never leaves
# a destination that could be mistaken for a complete archive. Interactive
# consoles get an in-place byte/percent counter; daemon/log callers only get
# append-only milestones. All rendering is deliberately isolated from the
# network operation: a broken console or unwritable log cannot fail a download.
# ---------------------------------------------------------------------------
# TLS trust bypass (opt-in). Corporate networks that TLS-inspect github.com
# present a proxy-signed certificate; the browser trusts it (enterprise
# root pushed to the browser / user), but .NET in this installer does not
# -> every github.com fetch dies with TrustFailure while
# *.githubusercontent.com (not inspected) still works. -InsecureTls (or the
# preflight itself, on detecting TrustFailure) turns certificate validation
# off FOR THIS INSTALLER PROCESS ONLY. Persisted as OD_INSECURE_TLS=1 in config.env so
# the launcher-driven `-Update` (non-interactive) keeps working.
# ---------------------------------------------------------------------------
$script:InsecureTlsActive = $false
$script:IwrExtra = @{}

function Enable-InsecureTls {
  if ($script:InsecureTlsActive) { return }
  $script:InsecureTlsActive = $true
  if ($PSVersionTable.PSEdition -eq 'Core') {
    # pwsh 7: Invoke-WebRequest has -SkipCertificateCheck; HttpClientHandler
    # gets its callback in Invoke-DownloadFile (see New-OdHttpHandler).
    $script:IwrExtra = @{ SkipCertificateCheck = $true }
    return
  }
  # Windows PowerShell 5.1: one global callback covers Invoke-WebRequest AND
  # System.Net.Http (both sit on HttpWebRequest/ServicePointManager here).
  # Compiled C#, not a scriptblock: the callback fires on thread-pool
  # threads during async downloads where a PowerShell scriptblock cannot
  # run and would be reported as a validation failure.
  if (-not ('OdTrustAllCerts' -as [type])) {
    Add-Type -TypeDefinition @"
using System.Net;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
public static class OdTrustAllCerts {
  public static bool Validate(object sender, X509Certificate cert, X509Chain chain, SslPolicyErrors errors) { return true; }
  public static void Enable() { ServicePointManager.ServerCertificateValidationCallback = Validate; }
}
"@
  }
  [OdTrustAllCerts]::Enable()
}

function New-OdHttpHandler {
  $handler = [System.Net.Http.HttpClientHandler]::new()
  if ($script:InsecureTlsActive -and $PSVersionTable.PSEdition -eq 'Core') {
    $handler.ServerCertificateCustomValidationCallback = [System.Net.Http.HttpClientHandler]::DangerousAcceptAnyServerCertificateValidator
  }
  return $handler
}

# $true when the URL fails specifically because the server certificate is
# not trusted (WebExceptionStatus.TrustFailure on 5.1; the
# AuthenticationException chain on pwsh 7) -- as opposed to DNS/connect/
# timeout, which -InsecureTls cannot help with.
function Test-TlsTrustFailure {
  param([string]$Url)
  try {
    # Deliberately no @IwrExtra: this is the detector, it must validate.
    Invoke-WebRequest -Uri $Url -Method Head -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop | Out-Null
    return $false
  } catch {
    $ex = $_.Exception
    if ($ex -is [System.Net.WebException] -and $ex.Status -eq [System.Net.WebExceptionStatus]::TrustFailure) { return $true }
    while ($ex) {
      if ($ex -is [System.Security.Authentication.AuthenticationException]) { return $true }
      if ($ex.Message -match 'certificate|trust relationship|SSL/TLS secure channel') { return $true }
      $ex = $ex.InnerException
    }
    return $false
  }
}

function Invoke-DownloadFile {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Destination,
    # Seconds WITHOUT any received byte before the attempt is abandoned. There
    # is deliberately no cap on the total transfer time -- big files on slow
    # links just take long; only a stalled connection is an error.
    [int]$TimeoutSec = $DownloadTimeoutSec,
    [int]$MaxAttempts = $DownloadMaxAttempts
  )

  $partial = "$Destination.partial"
  Remove-Item -Force $partial -ErrorAction SilentlyContinue
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    $client = $null
    $response = $null
    $input = $null
    $output = $null
    $cts = $null
    try {
      # Resume: keep whatever the previous attempt fetched and ask for the
      # rest with a Range request. GitHub release assets answer 206; a server
      # that ignores Range answers 200 and we start over from byte 0.
      [long]$resumeFrom = 0
      if (Test-Path -LiteralPath $partial) { $resumeFrom = (Get-Item -LiteralPath $partial).Length }
      Write-DownloadLog "download attempt $attempt/$MaxAttempts`: $Url$(if ($resumeFrom -gt 0) { " (resume from byte $resumeFrom)" })"
      Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
      $handler = New-OdHttpHandler
      $client = [System.Net.Http.HttpClient]::new($handler)
      $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
      $cts = [System.Threading.CancellationTokenSource]::new()
      $cts.CancelAfter([TimeSpan]::FromSeconds($TimeoutSec))
      $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Url)
      if ($resumeFrom -gt 0) {
        $request.Headers.Range = [System.Net.Http.Headers.RangeHeaderValue]::new($resumeFrom, $null)
      }
      $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cts.Token).GetAwaiter().GetResult()
      $response.EnsureSuccessStatusCode() | Out-Null
      $resumed = ($resumeFrom -gt 0 -and [int]$response.StatusCode -eq 206)
      if ($resumeFrom -gt 0 -and -not $resumed) {
        Write-DownloadLog "server ignored Range; restarting from byte 0"
        $resumeFrom = 0
      }
      $total = $null
      if ($resumed -and $response.Content.Headers.ContentRange -and $response.Content.Headers.ContentRange.HasLength) {
        $total = $response.Content.Headers.ContentRange.Length
      } elseif ($response.Content.Headers.ContentLength) {
        $total = $response.Content.Headers.ContentLength
      }
      $input = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
      $fileMode = if ($resumed) { [System.IO.FileMode]::Append } else { [System.IO.FileMode]::Create }
      $output = [System.IO.File]::Open($partial, $fileMode, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
      $buffer = [byte[]]::new(65536)
      [long]$received = $resumeFrom
      $lastPercent = -1
      $lastMilestone = -1
      [long]$lastByteReport = $resumeFrom
      # Average throughput of THIS attempt (bytes fetched now / wall time), shown
      # on the bar and written to the log: on networks that TLS-inspect GitHub
      # the number is the diagnosis (0.8.48 report: ~200-500 KB/s through the
      # proxy vs 11 MB/s to a non-inspected CDN from the same desk).
      $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
      $kbps = 0
      # Re-arm the stall timer after every successful read: CancelAfter on a
      # not-yet-cancelled source restarts the countdown.
      $cts.CancelAfter([TimeSpan]::FromSeconds($TimeoutSec))
      while (($count = $input.ReadAsync($buffer, 0, $buffer.Length, $cts.Token).GetAwaiter().GetResult()) -gt 0) {
        $cts.CancelAfter([TimeSpan]::FromSeconds($TimeoutSec))
        $output.Write($buffer, 0, $count)
        $received += $count
        $elapsedSec = $stopwatch.Elapsed.TotalSeconds
        if ($elapsedSec -gt 0.5) { $kbps = [int](($received - $resumeFrom) / 1024 / $elapsedSec) }
        if ($total -and $total -gt 0) {
          $percent = [Math]::Min(100, [int](($received * 100) / $total))
          if ((Test-InteractiveOutput) -and $percent -ne $lastPercent) {
            # ASCII bar on purpose: Windows PowerShell 5.1 consoles default to
            # a legacy code page where block-drawing characters render as '?'.
            $filled = [int][Math]::Floor($percent * $ProgressBarWidth / 100)
            $bar = ('=' * $filled).PadRight($ProgressBarWidth, '.')
            # Format into a variable FIRST. Inside a method-call argument list
            # PowerShell treats commas as argument separators, so
            # `[Console]::Write("..." -f $a, $b, $c)` becomes Write(("..." -f $a),
            # $b, $c): -f gets one value for a 4-slot format string, throws,
            # and the try/catch swallowed it -- the bar was never drawn
            # (0.8.39 report: "download step shows nothing").
            $line = "`r      [{0}] {1,3}%  {2:N1}/{3:N1} MB  {4,6:N0} KB/s" -f $bar, $percent, ($received / 1MB), ($total / 1MB), $kbps
            try { [Console]::Write($line) } catch {}
            $lastPercent = $percent
          } else {
            # 5% milestones: the daemon folds these into /api/update/status
            # progress.percent for the web header's update button.
            $milestone = [int]([Math]::Floor($percent / 5) * 5)
            if ($milestone -gt $lastMilestone) {
              Write-DownloadLog "download $milestone% ($received/$total bytes, $kbps KB/s)"
              $lastMilestone = $milestone
            }
          }
        } elseif ((Test-InteractiveOutput) -and ($received - $lastByteReport) -ge 1MB) {
          $line = "`r      {0:N1} MB downloaded  {1,6:N0} KB/s" -f ($received / 1MB), $kbps
          try { [Console]::Write($line) } catch {}
          $lastByteReport = $received
        }
      }
      if ($total -and $received -ne $total) {
        throw "download ended early: received $received of $total bytes"
      }
      $output.Flush()
      $output.Dispose(); $output = $null
      if (Test-InteractiveOutput) { try { [Console]::WriteLine() } catch {} }
      Move-Item -LiteralPath $partial -Destination $Destination -Force
      Write-DownloadLog "download complete ($received bytes, avg $kbps KB/s over $([int]$stopwatch.Elapsed.TotalSeconds) s): $Destination"
      if ($kbps -gt 0 -and $kbps -lt 1024 -and ($received - $resumeFrom) -gt 20MB) {
        Write-Warn "Toc do tai chi ~$kbps KB/s. Neu mang cong ty TLS-inspect github.com thi day la nguyen nhan -- xem OD_RELEASE_URL (mirror) trong deploy/host/README.md."
      }
      return
    } catch {
      $failure = $_.Exception.Message
      if ($cts -and $cts.IsCancellationRequested) {
        $failure = "no data received for $TimeoutSec s (stalled connection) -- $failure"
      }
      Write-DownloadLog "download attempt $attempt failed: $failure"
      $statusCode = if ($response) { [int]$response.StatusCode } else { 0 }
      $transient = ($statusCode -eq 0 -or $statusCode -eq 206 -or $statusCode -eq 200 -or $statusCode -eq 408 -or $statusCode -eq 429 -or $statusCode -ge 500)
      if (-not $transient -or $attempt -ge $MaxAttempts) {
        Remove-Item -Force $partial -ErrorAction SilentlyContinue
        if ($cts -and $cts.IsCancellationRequested) { throw $failure }
        throw
      }
      if (Test-InteractiveOutput) { try { [Console]::WriteLine() } catch {} }
      Write-Warn "download attempt $attempt/$MaxAttempts failed; retrying in $attempt second(s)$(if (Test-Path -LiteralPath $partial) { ' (resuming)' })"
      Start-Sleep -Seconds $attempt
    } finally {
      if ($output) { $output.Dispose() }
      if ($input) { $input.Dispose() }
      if ($response) { $response.Dispose() }
      if ($client) { $client.Dispose() }
      if ($cts) { $cts.Dispose() }
    }
  }
}

function Invoke-WebText {
  param([Parameter(Mandatory = $true)][string]$Url, [int]$TimeoutSec = 30)
  for ($attempt = 1; $attempt -le $DownloadMaxAttempts; $attempt++) {
    try {
      $content = (Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop @IwrExtra).Content
      # GitHub release assets (release.json, *.sha256) are served as
      # application/octet-stream. Windows PowerShell 5.1 then hands back
      # .Content as byte[] instead of a string; piping that into
      # ConvertFrom-Json "succeeds" (each byte parses as a JSON number) and
      # the flat-key lookup finds nothing -> "release.json has no entry for
      # platform win32-x64" (0.8.34 .cmd bootstrap). Decode explicitly.
      if ($content -is [byte[]]) {
        $content = [System.Text.Encoding]::UTF8.GetString($content)
      }
      if ($null -ne $content) { $content = ([string]$content).TrimStart([char]0xFEFF) }
      return $content
    } catch {
      if ($attempt -ge $DownloadMaxAttempts) { throw }
      Start-Sleep -Seconds $attempt
    }
  }
}

# Flat-key lookup for the release.json manifest published by
# .github/workflows/release-host-runtime.yml (top-level keys named
# "<platform>.url" / "<platform>.sha256", not nested objects -- see
# scripts/host-runtime/build-release-manifest.ts). Looked up via
# psobject.Properties rather than dot-access so the literal dot in the key
# name is never mistaken for a nested-property path.
function Get-FlatJsonValue {
  param($JsonObject, [string]$Key)
  $prop = $JsonObject.psobject.Properties[$Key]
  if ($prop) { return $prop.Value }
  return $null
}

# ---------------------------------------------------------------------------
# Step 1/6 -- resolve + verify the release archive (mirrors install.sh:206-305)
# ---------------------------------------------------------------------------
function Set-Platform {
  if (-not [Environment]::Is64BitOperatingSystem) {
    Fail "Unsupported Windows architecture: 32-bit (only 64-bit Windows is supported)"
  }
  # ARM64 Windows running an x64 (WOW64-emulated) PowerShell reports
  # PROCESSOR_ARCHITECTURE=AMD64 -- the real arch only shows up in
  # PROCESSOR_ARCHITEW6432, mirroring how a 32-bit process detects a 64-bit
  # host. Check both so this is not fooled by emulation.
  if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or $env:PROCESSOR_ARCHITEW6432 -eq "ARM64") {
    Fail "Unsupported Windows architecture: ARM64 (only win32-x64 is supported in v1 -- see specs/change/20260814-windows-native-install/spec.md 'Ngoai pham vi')"
  }
  $script:Platform = "win32-x64"
}

function Get-Archive {
  # $Parts > 0: the mirror serves <Url>.part01 .. .partNN (hosts with a
  # per-file size cap -- Cloudflare Pages: 25 MiB) instead of the whole file.
  # Download each part with the same stall-timeout/resume logic, concatenate
  # into the tarball, and let Test-Checksum verify the whole-file sha256
  # from release.json exactly as for a single-file download.
  param([string]$Url, [string]$Sha256Url = "", [int]$Parts = 0)
  $dlDir = New-TempDir
  $script:ArchivePath = Join-Path $dlDir (Split-Path $Url -Leaf)
  if ($Parts -gt 0) {
    Write-Step "Downloading $(Split-Path $Url -Leaf) ($Parts parts)"
    $partPaths = New-Object System.Collections.Generic.List[string]
    for ($i = 1; $i -le $Parts; $i++) {
      $suffix = ".part{0:00}" -f $i
      Write-Step "  part $i/$Parts"
      try {
        Invoke-DownloadFile -Url "$Url$suffix" -Destination "$ArchivePath$suffix"
      } catch {
        Fail "download failed after $DownloadMaxAttempts attempts: $Url$suffix -- $($_.Exception.Message)"
      }
      $partPaths.Add("$ArchivePath$suffix")
    }
    Write-Step "Assembling $(Split-Path $Url -Leaf) from $Parts parts"
    $out = [System.IO.File]::Create($ArchivePath)
    try {
      foreach ($p in $partPaths) {
        $in = [System.IO.File]::OpenRead($p)
        try { $in.CopyTo($out) } finally { $in.Dispose() }
        Remove-Item -Force $p -ErrorAction SilentlyContinue
      }
    } finally {
      $out.Dispose()
    }
    return
  }
  Write-Step "Downloading $(Split-Path $Url -Leaf)"
  try {
    Invoke-DownloadFile -Url $Url -Destination $ArchivePath
  } catch {
    Fail "download failed after $DownloadMaxAttempts attempts: $Url -- $($_.Exception.Message)"
  }
  if ($Sha256Url) {
    try {
      $shaTmp = "$ArchivePath.sha256"
      Invoke-DownloadFile -Url $Sha256Url -Destination $shaTmp -TimeoutSec 30
      $script:ArchiveShaHint = ((Get-Content $shaTmp -Raw).Trim() -split '\s+')[0]
    } catch {
      # No sidecar published -- not fatal, mirrors install.sh's `|| true`.
    }
  }
}

function Resolve-Archive {
  if ($Archive) {
    if (-not (Test-Path $Archive)) { Fail "-Archive not found: $Archive" }
    $script:ArchivePath = (Resolve-Path $Archive).Path
    if (Test-Path "$Archive.sha256") {
      $script:ArchiveShaHint = ((Get-Content "$Archive.sha256" -Raw).Trim() -split '\s+')[0]
    }
    Set-Platform
    return
  }

  Set-Platform

  if ($ReleaseUrl -and ($ReleaseUrl -match '\.tar\.gz$')) {
    Get-Archive -Url $ReleaseUrl -Sha256Url "$ReleaseUrl.sha256"
    return
  }

  $releaseJsonUrl = ""
  if ($ReleaseUrl) {
    $releaseJsonUrl = "$($ReleaseUrl.TrimEnd('/'))/release.json"
  } else {
    Write-Step "Looking up the latest release of $DefaultGhRepo"
    # github.com/<repo>/releases/latest/download/<asset> is a redirect
    # GitHub serves for exactly this "give me the latest release's asset,
    # no API call" case -- it resolves through github.com and the
    # release-assets.githubusercontent.com CDN it redirects to, never
    # touching api.github.com. Some corporate proxies allowlist
    # github.com/*.githubusercontent.com for normal git/browsing traffic
    # but block the api. subdomain specifically (observed in the wild --
    # this install failed with "could not reach the GitHub API" on such a
    # network until this was added), so this sidesteps that without
    # needing -ReleaseUrl.
    $releaseJsonUrl = "https://github.com/$DefaultGhRepo/releases/latest/download/release.json"
  }

  # release.json shape (see .github/workflows/release-host-runtime.yml):
  #   { "version": "...", "tag": "...",
  #     "<platform>.url": "https://.../open-design-runtime-<v>-<platform>.tar.gz",
  #     "<platform>.sha256": "<hex>", ... one pair per supported platform ... }
  try {
    $relJson = (Invoke-WebText -Url $releaseJsonUrl -TimeoutSec 30) | ConvertFrom-Json
  } catch {
    Fail "could not fetch release.json from $releaseJsonUrl -- $($_.Exception.Message)"
  }
  if (-not ($relJson -is [System.Management.Automation.PSCustomObject])) {
    Fail "release.json from $releaseJsonUrl did not parse as a JSON object (got $(if ($null -eq $relJson) { "null" } else { $relJson.GetType().Name }))"
  }
  $tarballUrl = Get-FlatJsonValue $relJson "$Platform.url"
  $tarballSha = Get-FlatJsonValue $relJson "$Platform.sha256"
  if (-not $tarballUrl) { Fail "release.json ($($relJson.tag)) has no entry for platform $Platform" }
  # "<platform>.parts" (string count) = the archive is served as .partNN files
  # (see build-release-manifest.ts --split-mib). Absent on GitHub Releases.
  [int]$tarballParts = 0
  $partsRaw = Get-FlatJsonValue $relJson "$Platform.parts"
  if ($partsRaw -and -not [int]::TryParse([string]$partsRaw, [ref]$tarballParts)) {
    Fail "release.json ($($relJson.tag)) has a non-numeric $Platform.parts: $partsRaw"
  }

  Get-Archive -Url $tarballUrl -Parts $tarballParts
  if (-not $ArchiveShaHint) { $script:ArchiveShaHint = $tarballSha }
}

function Test-TarSafety {
  # Reject path traversal and anything other than exactly one top-level
  # directory before extraction ever runs -- same invariant as install.sh's
  # verify_tar_safety() (install.sh:269-283), using the tar.exe that has
  # shipped in Windows since 10 1803 / 11 (this is the documented minimum
  # supported Windows version for this installer).
  $tarCmd = Get-Command tar.exe -ErrorAction SilentlyContinue
  if (-not $tarCmd) {
    Fail "tar.exe not found -- this installer requires Windows 10 1803+ or Windows 11 (tar.exe ships built-in since then)"
  }
  try {
    $listing = & tar.exe -tzf $ArchivePath 2>$null
  } catch {
    $listing = $null
  }
  if ($LASTEXITCODE -ne 0 -or -not $listing) { Fail "archive is not a valid tar.gz: $ArchivePath" }

  foreach ($line in $listing) {
    if ($line -match '(^|/)\.\.(/|$)') {
      Fail "archive contains a '..' path traversal entry -- refusing to extract"
    }
  }

  $topLevels = $listing | ForEach-Object { ($_ -split '/')[0] } | Sort-Object -Unique
  if (@($topLevels).Count -ne 1) {
    Fail "archive must contain exactly one top-level directory (found $(@($topLevels).Count))"
  }
  # $topLevels collapses to a bare [string] scalar (not a 1-element array)
  # when there's exactly one unique value -- the normal case for every valid
  # archive, since that's what the check above enforces. Indexing a bare
  # string with [0] returns its first CHARACTER, not itself -- @() forces
  # array context so [0] always means "first element" here.
  $script:StageName = @($topLevels)[0]
}

# Get-FileHash and Expand-Archive are SCRIPT modules on Windows PowerShell
# 5.1 (Microsoft.PowerShell.Utility.psm1 / Microsoft.PowerShell.Archive).
# When powershell.exe is spawned from a pwsh 7 host (CI, VS Code terminal,
# any tool that already set PSModulePath for pwsh) module auto-loading finds
# pwsh 7's Core-only manifests first and the commands come back as "not
# recognized" (0.8.35 .cmd bootstrap smoke). Use plain .NET for both so the
# installer does not depend on PSModulePath at all.
function Get-OdFileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
      return ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLower()
    } finally { $stream.Dispose() }
  } finally { $sha.Dispose() }
}

function Expand-OdZip {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$DestinationPath)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try {
    foreach ($entry in $zip.Entries) {
      $target = Join-Path $DestinationPath $entry.FullName
      $fullTarget = [System.IO.Path]::GetFullPath($target)
      $fullDest = [System.IO.Path]::GetFullPath($DestinationPath).TrimEnd('\') + '\'
      if (-not $fullTarget.StartsWith($fullDest, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "zip entry escapes destination: $($entry.FullName)"
      }
      if ($entry.FullName.EndsWith('/')) {
        New-Item -ItemType Directory -Force -Path $fullTarget | Out-Null
        continue
      }
      $parent = Split-Path -Parent $fullTarget
      if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $fullTarget, $true)
    }
  } finally { $zip.Dispose() }
}

function Test-Checksum {
  $expected = if ($Sha256) { $Sha256 } else { $ArchiveShaHint }
  if (-not $expected) {
    Fail "no checksum to verify against -- pass -Sha256 or ensure a .sha256/release.json entry is available"
  }
  $actual = Get-OdFileSha256 -Path $ArchivePath
  if ($actual -ne $expected.ToLower()) {
    Fail "checksum mismatch for ${ArchivePath}: expected $expected, got $actual"
  }
  Write-Ok "Checksum verified (sha256)"
}

# ---------------------------------------------------------------------------
# Step 0 -- network preflight (mirrors install.sh's preflight_check). Not
# part of the "N/6" phase numbering -- a connectivity probe, not an install
# step. Corporate networks sometimes block one of these domains outright;
# without this, the resulting failure is a bare exception buried mid-
# download with nothing telling the user (or their IT) which domain is the
# problem. Only probes domains this particular run will actually touch.
# ---------------------------------------------------------------------------
function Test-PreflightProbe {
  param([string]$Url)
  # Deliberately does not treat a non-2xx response as unreachable -- e.g.
  # GitHub's asset CDN 404s on a bare root path with no signed asset path
  # (verified live), which still proves DNS/TCP/TLS all worked. Only a
  # connect-level failure (no $_.Exception.Response at all) means
  # unreachable. HEAD, not GET: -TimeoutSec covers the WHOLE response, and
  # a GET of the github.com homepage (hundreds of KB) through a slow or
  # proxied link blew the old 5s budget and reported "github.com -- khong
  # ket noi duoc" right after the .cmd had just downloaded install.ps1 from
  # GitHub fine (0.8.35, VN corporate network). Two attempts, 10s each --
  # a probe, not a real download.
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      Invoke-WebRequest -Uri $Url -Method Head -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop @IwrExtra | Out-Null
      return $true
    } catch {
      if ($_.Exception.Response) { return $true }
      if ($attempt -lt 2) { Start-Sleep -Seconds 1 }
    }
  }
  return $false
}

# -ReleaseUrl flag > OD_RELEASE_URL env (set by the user / IT, or inherited
# from config.env by the daemon that spawns `-Update`) > OD_RELEASE_URL
# persisted in config.env > $DefaultMirrorUrl (with GitHub as preflight's
# runtime fallback if the mirror is unreachable -- see Invoke-PreflightCheck).
# $script:ReleaseUrlIsMirrorBase is what Write-ConfigEnv persists: only a
# user/IT-provided base URL (folder with release.json), never a one-off
# direct .tar.gz URL (would pin every future -Update to one fixed file) and
# never the untouched default (see $script:ReleaseUrlIsDefault below).
function Resolve-ReleaseUrl {
  $script:ReleaseUrlIsMirrorBase = $false
  # Set only when $script:ReleaseUrl was filled in by the $DefaultMirrorUrl
  # fallback below, i.e. nothing in flag/env/config.env named a source.
  # Write-ConfigEnv must not persist OD_RELEASE_URL in that case: the
  # default can change release-to-release, and persisting it would pin every
  # future -Update to whatever mirror happened to be default at install time
  # instead of tracking the shipped default.
  $script:ReleaseUrlIsDefault = $false
  if (-not $ReleaseUrl) {
    $fromEnv = $env:OD_RELEASE_URL
    if ($fromEnv) {
      $script:ReleaseUrl = $fromEnv.Trim()
    } else {
      $fromConfig = Get-ExistingConfigValue "OD_RELEASE_URL"
      if ($fromConfig) { $script:ReleaseUrl = $fromConfig.Trim() }
    }
  }
  if (-not $ReleaseUrl) {
    # Nothing configured anywhere -- default to the mirror (WP16), treated
    # exactly like a user-provided mirror base except it is not persisted
    # ($script:ReleaseUrlIsDefault = $true, see above). Invoke-PreflightCheck
    # below falls back to GitHub at runtime if the mirror itself is
    # unreachable.
    $script:ReleaseUrl = $DefaultMirrorUrl
    $script:ReleaseUrlIsMirrorBase = $true
    $script:ReleaseUrlIsDefault = $true
    Write-Info "Release source: $ReleaseUrl (default mirror)"
    return
  }
  if ($ReleaseUrl -notmatch '\.tar\.gz$') {
    $script:ReleaseUrl = $ReleaseUrl.TrimEnd('/')
    $script:ReleaseUrlIsMirrorBase = $true
    Write-Info "Release source: $ReleaseUrl (OD_RELEASE_URL / -ReleaseUrl)"
  } else {
    Write-Info "Release source: $ReleaseUrl (direct archive URL)"
  }
}

function Invoke-PreflightCheck {
  Write-Phase "Kiem tra ket noi mang"
  $requiredOk = $true

  if (-not $ReleaseUrlIsDefault) {
    if (-not $Archive -and $ReleaseUrl) {
      # User/IT-provided source (flag / OD_RELEASE_URL / config.env): that
      # host is the only one the download needs, and it never fails over --
      # it's the one place they explicitly told us to use.
      $releaseHost = ""
      try { $releaseHost = ([System.Uri]$ReleaseUrl).GetLeftPart([System.UriPartial]::Authority) } catch {}
      if ($releaseHost) {
        $mirrorOk = Test-PreflightProbe $releaseHost
        if (-not $mirrorOk -and -not $InsecureTlsActive -and (Test-TlsTrustFailure $releaseHost)) {
          # Same corporate-proxy handling as the github.com branch below.
          Write-Warn "$releaseHost -- chung chi TLS bi proxy/firewall cong ty thay the; bo qua kiem tra chung chi cho lan cai nay (chi trong installer)."
          Enable-InsecureTls
          $mirrorOk = Test-PreflightProbe $releaseHost
        }
        if ($mirrorOk) {
          Write-Ok $(if ($InsecureTlsActive) { "$releaseHost (bo qua kiem tra chung chi TLS)" } else { $releaseHost })
        } else {
          $requiredOk = $false
          Write-Warn "$releaseHost -- khong ket noi duoc"
        }
      }
    }
  }

  if (-not $Archive -and $ReleaseUrlIsDefault) {
    # Default source is the Cloudflare Pages mirror (see $DefaultMirrorUrl
    # above) -- probe it first. Only if the mirror itself is unreachable do
    # we fall back to the old GitHub path (github.com + its asset CDN, with
    # the same TrustFailure/InsecureTls auto-bypass it always had), exactly
    # as this installer behaved before WP16.
    $mirrorHost = ""
    try { $mirrorHost = ([System.Uri]$ReleaseUrl).GetLeftPart([System.UriPartial]::Authority) } catch {}
    $mirrorOk = if ($mirrorHost) { Test-PreflightProbe $mirrorHost } else { $false }
    if ($mirrorOk) {
      Write-Ok $mirrorHost
    } else {
      Write-Warn "$mirrorHost -- khong ket noi duoc"
      Write-Info "mirror khong toi duoc -- dung GitHub"
      # Clear the mirror default so Resolve-Archive's "no $ReleaseUrl" branch
      # runs (looks up the latest GitHub release), and so Write-ConfigEnv's
      # mirror-persist check ($script:ReleaseUrlIsMirrorBase) stays correctly
      # off for this run.
      $script:ReleaseUrl = ""
      $script:ReleaseUrlIsMirrorBase = $false
      $script:ReleaseUrlIsDefault = $false

      $githubOk = Test-PreflightProbe "https://github.com"
      if (-not $githubOk -and -not $InsecureTlsActive -and (Test-TlsTrustFailure "https://github.com")) {
        # Default behaviour (decided 2026-08-17 after the VNPAY office network
        # hit exactly this): do NOT stop and ask -- the person double-clicking
        # OpenDesign-Install.cmd cannot fix a corporate proxy anyway. Say what
        # happened, switch validation off for this installer process, carry on.
        # Certificate validation stays ON on every network where github.com's
        # real certificate is served (this branch is only reached on TrustFailure).
        Write-Warn "github.com -- chung chi TLS bi proxy/firewall cong ty thay the; bo qua kiem tra chung chi cho lan cai nay (chi trong installer)."
        Write-Host "      Sua tan goc: nho IT cai root CA cua proxy vao Windows (Trusted Root Certification Authorities)." -ForegroundColor DarkGray
        Enable-InsecureTls
        $githubOk = Test-PreflightProbe "https://github.com"
      }
      if ($githubOk) {
        Write-Ok $(if ($InsecureTlsActive) { "github.com (bo qua kiem tra chung chi TLS)" } else { "github.com" })
      } else {
        $requiredOk = $false
        Write-Warn "github.com -- khong ket noi duoc"
      }
      if (Test-PreflightProbe "https://release-assets.githubusercontent.com") {
        Write-Ok "release-assets.githubusercontent.com"
      } else {
        $requiredOk = $false
        Write-Warn "release-assets.githubusercontent.com -- khong ket noi duoc"
      }
    }
  }

  if (-not (Test-NodeSatisfiesEngine)) {
    if (Test-PreflightProbe "https://nodejs.org") {
      Write-Ok "nodejs.org"
    } else {
      Write-Warn "nodejs.org -- khong ket noi duoc (can de tai Node.js rieng -- may chua co Node $RequiredNodeMajor.x)"
    }
  }

  if (-not $Update) {
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
      if (Test-PreflightProbe "https://claude.ai") {
        Write-Ok "claude.ai"
      } else {
        Write-Warn "claude.ai -- khong ket noi duoc (se bo qua cai Claude CLI)"
      }
    }
    if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
      if (Test-PreflightProbe "https://chatgpt.com") {
        Write-Ok "chatgpt.com"
      } else {
        Write-Warn "chatgpt.com -- khong ket noi duoc (se bo qua cai Codex CLI)"
      }
    }
  }

  if (-not $requiredOk) {
    if ($ReleaseUrl) {
      Fail "Khong ket noi duoc toi nguon tai $ReleaseUrl -- kiem tra OD_RELEASE_URL / -ReleaseUrl, hoac dung -Archive <file da tai san>."
    }
    Fail "Khong ket noi duoc toi od-runtime.pages.dev (mirror) / github.com / release-assets.githubusercontent.com -- can it nhat 1 trong cac nguon nay de tai goi cai dat. Nho IT mo domain roi thu lai, hoac dung -Archive <file da tai san>."
  }
}

function Step1-VerifyPackage {
  Write-Phase "1/6 Kiem tra goi cai dat"
  Resolve-Archive
  Write-Step "Platform: $Platform"
  # Checksum BEFORE any extraction -- mandatory, same order as install.sh.
  Test-Checksum
  Test-TarSafety
  # Extract just VERSION to a scratch dir instead of piping it out via `-O`
  # (extract-to-stdout) -- that mode proved unreliable on the windows-latest
  # CI runner's tar.exe (silent empty output, no diagnosable cause). `-C`
  # extraction is the same primitive Step 3 already uses for the real
  # install (below), so this reuses the well-trodden path instead of a
  # second, less-tested extraction mode.
  $versionDir = New-TempDir
  $tarErr = & tar.exe -xzf $ArchivePath -C $versionDir "$StageName/VERSION" 2>&1
  $versionFile = Join-Path $versionDir "$StageName/VERSION"
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $versionFile)) {
    Fail "could not read VERSION from the archive (tar exit ${LASTEXITCODE}): $tarErr"
  }
  $script:Version = ((Get-Content -Path $versionFile -Raw) -replace '\s', '')
  if (-not $Version) { Fail "VERSION file in the archive is empty" }
  Write-Ok "Package verified: $StageName (version $Version)"
}

# ---------------------------------------------------------------------------
# Step 2/6 -- Node.js runtime (mirrors install.sh:307-356)
# ---------------------------------------------------------------------------
function Test-NodeSatisfiesEngine {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { return $false }
  try {
    $v = (& node -v 2>$null).TrimStart('v')
  } catch {
    return $false
  }
  $major = $v.Split('.')[0]
  return $major -eq "$RequiredNodeMajor"
}

function Install-PrivateNode {
  Write-Step "Fetching Node.js $RequiredNodeMajor.x checksums"
  try {
    $shasums = Invoke-WebText -Url "https://nodejs.org/dist/latest-v$RequiredNodeMajor.x/SHASUMS256.txt" -TimeoutSec 30
  } catch {
    Fail "could not fetch Node.js $RequiredNodeMajor.x SHASUMS256.txt -- $($_.Exception.Message)"
  }
  # Node's Windows distribution uses "-win-x64.zip" naming (NOT "-win32-x64",
  # unlike the darwin/linux tar.gz naming install.sh matches against).
  $m = [regex]::Match($shasums, "node-v$RequiredNodeMajor\.\d+\.\d+-win-x64\.zip")
  if (-not $m.Success) { Fail "no Node $RequiredNodeMajor.x build found for win-x64" }
  $filename = $m.Value
  $shaLine = ($shasums -split '\r?\n') | Where-Object { $_ -match [regex]::Escape($filename) + '$' } | Select-Object -First 1
  if (-not $shaLine) { Fail "could not find a checksum line for $filename in SHASUMS256.txt" }
  $expectedSha = ($shaLine -split '\s+')[0]

  $dlDir = New-TempDir
  $nodeZip = Join-Path $dlDir $filename
  Write-Step "Downloading $filename"
  try {
    Invoke-DownloadFile -Url "https://nodejs.org/dist/latest-v$RequiredNodeMajor.x/$filename" -Destination $nodeZip
  } catch {
    Fail "download failed: $filename"
  }
  $actualSha = Get-OdFileSha256 -Path $nodeZip
  if ($actualSha -ne $expectedSha) { Fail "Node.js checksum mismatch (SHASUMS256.txt) for $filename" }

  $toolsDir = Join-Path $OdHome "tools"
  New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
  Expand-OdZip -Path $nodeZip -DestinationPath $toolsDir
  $nodeDirName = [System.IO.Path]::GetFileNameWithoutExtension($filename)
  $script:NodeBin = Join-Path $toolsDir "$nodeDirName\node.exe"
  if (-not (Test-Path $NodeBin)) { Fail "Node install did not produce an executable at $NodeBin" }
  Write-Ok "Private Node.js installed: $NodeBin"
}

function Step2-EnsureNode {
  Write-Phase "2/6 Kiem tra Node.js"
  if (Test-NodeSatisfiesEngine) {
    $script:NodeBin = (Get-Command node).Source
    Write-Ok "System Node.js satisfies engines (~$RequiredNodeMajor): $NodeBin"
  } else {
    Write-Warn "System Node.js missing or not ~$RequiredNodeMajor -- installing a private copy under $OdHome\tools"
    Install-PrivateNode
  }
}

# ---------------------------------------------------------------------------
# Step 3/6 -- extract + config.env + `current` junction + per-user launcher
# (mirrors install.sh:358-505)
# ---------------------------------------------------------------------------
function Expand-Release {
  $releasesDir = Join-Path $OdHome "releases"
  New-Item -ItemType Directory -Force -Path $releasesDir | Out-Null
  $script:ReleaseDir = Join-Path $releasesDir $Version
  if ($PrevCurrent -and ([System.IO.Path]::GetFullPath($PrevCurrent).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($ReleaseDir).TrimEnd('\'))) {
    # Never replace the directory backing the live junction. Besides being
    # safer, this avoids Windows file-lock failures and lets a detached
    # self-update reach its launcher restart handoff without killing
    # the daemon (and therefore its own updater) during extraction.
    $archiveId = (Get-OdFileSha256 -Path $ArchivePath).Substring(0, 8)
    $script:ReleaseDir = Join-Path $releasesDir "$Version-$archiveId"
  }
  $stagingDir = Join-Path $releasesDir (".staging-$Version-" + [System.Guid]::NewGuid().ToString("N"))
  $script:TempDirs += $stagingDir
  New-Item -ItemType Directory -Path $stagingDir | Out-Null
  & tar.exe -xzf $ArchivePath -C $stagingDir --strip-components=1
  if ($LASTEXITCODE -ne 0) { Fail "failed to extract $ArchivePath into staging" }

  # Promotion happens only after validating the extracted tree. In
  # particular this keeps a running same-version release untouched while a
  # replacement (preview builds can reuse a version) is incomplete.
  $stagedVersionFile = Join-Path $stagingDir "VERSION"
  $stagedCli = Join-Path $stagingDir "apps\daemon\dist\cli.js"
  $stagedInstaller = Join-Path $stagingDir "install.ps1"
  $stagedLauncher = Join-Path $stagingDir "launcher.ps1"
  if (-not (Test-Path $stagedVersionFile) -or -not (Test-Path $stagedCli) -or
      -not (Test-Path $stagedInstaller) -or -not (Test-Path $stagedLauncher)) {
    Fail "staged release is incomplete (required VERSION, daemon cli.js, install.ps1, and launcher.ps1)"
  }
  foreach ($commandFileName in $CommandFileMap.Keys) {
    if (-not (Test-Path (Join-Path $stagingDir $commandFileName))) {
      Fail "staged release is incomplete (missing Windows command file: $commandFileName)"
    }
  }
  $stagedVersion = ((Get-Content -Path $stagedVersionFile -Raw) -replace '\s', '')
  if ($stagedVersion -ne $Version) {
    Fail "staged VERSION mismatch: expected $Version, got $stagedVersion"
  }

  if (Test-Path $ReleaseDir) {
    $script:PreviousReleaseBackup = Join-Path $releasesDir (".backup-$Version-" + [System.Guid]::NewGuid().ToString("N"))
    Move-Item -LiteralPath $ReleaseDir -Destination $PreviousReleaseBackup -ErrorAction Stop
  }
  try {
    Move-Item -LiteralPath $stagingDir -Destination $ReleaseDir -ErrorAction Stop
  } catch {
    if ($PreviousReleaseBackup -and (Test-Path $PreviousReleaseBackup) -and -not (Test-Path $ReleaseDir)) {
      Move-Item -LiteralPath $PreviousReleaseBackup -Destination $ReleaseDir -ErrorAction SilentlyContinue
      $script:PreviousReleaseBackup = ""
    }
    throw
  }
  Write-Ok "Extracted to $ReleaseDir"
}

# -EnvFile (url|path) -> whitelisted KEY=VALUE lines only, never invoked as
# arbitrary script -- same whitelist as install.sh's load_env_file().
$OdEnvFileAllowedKeys = @(
  'CONFLUENCE_URL',
  'MEDIA_URL', 'MEDIA_APP_ID', 'MEDIA_USER_ID', 'MEDIA_USER_ROLE',
  'IDENTITY_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET',
  'OD_PORT', 'OD_DATA_DIR'
)

function Import-EnvFile {
  $efPath = $EnvFile
  if (-not $efPath) {
    # No -EnvFile given. Priority: a locally saved copy (your own override,
    # never shipped/committed) beats a copy bundled INTO this release's own
    # tarball by the release-host-runtime.yml CI pipeline (from GitHub
    # Actions secrets) -- see build-runtime.sh. Bundling means a fresh
    # install needs zero config flags to get KG sync + Google login
    # working. This is a deliberate choice for this repo despite being
    # PUBLIC (anyone can download the tarball and read these values) --
    # made explicitly, not a default other forks/deployments should copy
    # without the same tradeoff being intentional there too.
    $defaultEnvFile = Join-Path $OdHome "host-env.template"
    $bundledEnvFile = Join-Path $ReleaseDir "host-env.template"
    if (Test-Path $defaultEnvFile) {
      $efPath = $defaultEnvFile
      Write-Step "Using saved env defaults: $efPath"
    } elseif (Test-Path $bundledEnvFile) {
      $efPath = $bundledEnvFile
      Write-Step "Using env defaults bundled with this release"
    } else {
      return
    }
  } elseif ($EnvFile -match '^https?://') {
    $efPath = Join-Path (New-TempDir) "env-file"
    try {
      Invoke-DownloadFile -Url $EnvFile -Destination $efPath -TimeoutSec 30
    } catch {
      Fail "could not fetch -EnvFile $EnvFile -- $($_.Exception.Message)"
    }
  }
  if (-not (Test-Path $efPath)) { Fail "-EnvFile not found: $efPath" }
  $script:EnvFileVars = Get-Content $efPath | Where-Object {
    $line = $_
    ($OdEnvFileAllowedKeys | Where-Object { $line -match "^$_=" }).Count -gt 0
  }
}

function Get-EnvFileValue {
  param([string]$Key)
  $line = $EnvFileVars | Where-Object { $_ -match "^$Key=" } | Select-Object -Last 1
  if ($line) { return ($line -split '=', 2)[1] }
  return ""
}

function Get-ExistingConfigValue {
  param([string]$Key)
  $configPath = Join-Path $OdHome "config.env"
  if (-not (Test-Path $configPath)) { return "" }
  $line = Get-Content $configPath | Where-Object { $_ -match "^$Key=" } | Select-Object -Last 1
  if ($line) { return ($line -split '=', 2)[1] }
  return ""
}

# Priority: explicit flag > -EnvFile > existing config.env (on -Update) > "".
function Resolve-Cfg {
  param([string]$FlagVal, [string]$Key)
  if ($FlagVal) { return $FlagVal }
  $efv = Get-EnvFileValue $Key
  if ($efv) { return $efv }
  return Get-ExistingConfigValue $Key
}

function Write-ConfigEnv {
  Import-EnvFile

  $resolvedPort = Resolve-Cfg $Port "OD_PORT"
  if (-not $resolvedPort) { $resolvedPort = "$DefaultPort" }
  $script:ResolvedPort = $resolvedPort

  $resolvedDataDir = Resolve-Cfg $DataDir "OD_DATA_DIR"
  if (-not $resolvedDataDir) { $resolvedDataDir = $DefaultDataDir }

  $confluenceUrl = Resolve-Cfg "" "CONFLUENCE_URL"
  $mediaUrl = Resolve-Cfg $MediaUrl "MEDIA_URL"
  $mediaAppId = Resolve-Cfg $MediaAppId "MEDIA_APP_ID"
  $mediaUserId = Resolve-Cfg $MediaUserId "MEDIA_USER_ID"
  $mediaUserRole = Resolve-Cfg $MediaUserRole "MEDIA_USER_ROLE"
  $identityUrl = Resolve-Cfg $IdentityUrl "IDENTITY_URL"
  $googleClientId = Resolve-Cfg $GoogleClientId "GOOGLE_CLIENT_ID"
  $googleClientSecret = Resolve-Cfg $GoogleClientSecret "GOOGLE_CLIENT_SECRET"
  $sessionSecret = Resolve-Cfg $SessionSecret "SESSION_SECRET"

  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("# Generated by deploy/host/install.ps1 on $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))")
  $lines.Add("OD_SANDBOX=0")
  # TEMPORARY default for Windows, deliberately different from install.sh's
  # OD_WRITE_ISOLATION=required on darwin/linux: write-isolation.ts only has
  # an enforcement backend on Darwin today (sandbox-exec); Windows has none
  # yet (docs/run-write-isolation-spec.md's "Phase 1 unisolated" note covers
  # the same gap for Linux). `required` here would refuse every single run.
  # Flip to `required`/`on` once specs/change/20260814-windows-write-
  # isolation/spec.md lands its enforcement backend -- a one-line change,
  # not a re-spec (see that plan's "Sau khi spec write-isolation-windows
  # xong" note).
  $lines.Add("OD_WRITE_ISOLATION=off")
  $lines.Add("OD_DATA_DIR=$resolvedDataDir")
  $lines.Add("OD_PORT=$resolvedPort")
  # Bundled skills/design-systems/design-templates/craft/plugins/prompt-
  # templates live under <current>/resources/open-design (build-runtime.sh
  # step 6) -- see install.sh's identical comment for why this must be set
  # explicitly (resolveDaemonResourceRoot() would otherwise fall back to a
  # path that does not exist in this layout).
  $lines.Add("OD_RESOURCE_ROOT=$OdHome\current\resources\open-design")
  # Without this, apps/daemon/src/app-version.ts falls back to the nearest
  # package.json on disk (apps/daemon/package.json), a different,
  # not-kept-in-sync file from the one this release's VERSION was cut from
  # -- GET /api/update/status's `currentVersion` would then never match the
  # version an update just installed, so it never sees the update as
  # applied and the UI banner never clears.
  $lines.Add("OD_APP_VERSION=$Version")
  if ($InsecureTlsActive) { $lines.Add("OD_INSECURE_TLS=1") }
  # Mirror base URL survives into -Update (the daemon loads config.env into
  # its env before spawning install.ps1 -Update; Resolve-ReleaseUrl reads it
  # from either place). See .PARAMETER ReleaseUrl. The ReleaseUrlIsDefault
  # guard keeps the untouched $DefaultMirrorUrl (WP16) out of config.env --
  # only a user/IT-provided source is durable; the shipped default is free
  # to change release-to-release.
  if (-not $ReleaseUrlIsDefault) {
    if ($ReleaseUrlIsMirrorBase) { $lines.Add("OD_RELEASE_URL=$ReleaseUrl") }
  }
  if ($confluenceUrl) { $lines.Add("CONFLUENCE_URL=$confluenceUrl") }
  if ($mediaUrl) { $lines.Add("MEDIA_URL=$mediaUrl") }
  if ($mediaAppId) { $lines.Add("MEDIA_APP_ID=$mediaAppId") }
  if ($mediaUserId) { $lines.Add("MEDIA_USER_ID=$mediaUserId") }
  if ($mediaUserRole) { $lines.Add("MEDIA_USER_ROLE=$mediaUserRole") }
  if ($identityUrl) { $lines.Add("IDENTITY_URL=$identityUrl") }
  if ($googleClientId) { $lines.Add("GOOGLE_CLIENT_ID=$googleClientId") }
  if ($googleClientSecret) { $lines.Add("GOOGLE_CLIENT_SECRET=$googleClientSecret") }
  if ($sessionSecret) { $lines.Add("SESSION_SECRET=$sessionSecret") }

  $configPath = Join-Path $OdHome "config.env"
  # Explicit no-BOM UTF8 -- matches install.sh's plain byte output (Set-
  # Content -Encoding UTF8 on Windows PowerShell 5.1 would prepend a BOM).
  $configTemp = Join-Path $OdHome (".config.env-" + [System.Guid]::NewGuid().ToString("N") + ".tmp")
  [System.IO.File]::WriteAllLines($configTemp, [string[]]$lines, [System.Text.UTF8Encoding]::new($false))
  # ACL-lock to the current user only -- the Windows equivalent of chmod 600.
  icacls $configTemp /inheritance:r /grant:r "$env:USERDOMAIN\$($env:USERNAME):F" | Out-Null
  $script:ConfigExisted = Test-Path $configPath
  if ($ConfigExisted) {
    $script:ConfigBackupPath = Join-Path $OdHome (".config.env-backup-" + [System.Guid]::NewGuid().ToString("N"))
    # File.Replace is one filesystem transaction: readers observe either the
    # complete old config or the complete new one, never a half-written file.
    [System.IO.File]::Replace($configTemp, $configPath, $ConfigBackupPath, $true)
  } else {
    Move-Item -LiteralPath $configTemp -Destination $configPath
  }
  $script:ConfigChanged = $true

  if ((-not $mediaUrl) -and (-not $identityUrl)) {
    Write-Warn "No Media/Identity endpoints configured -- KG sync se tat (dung -EnvFile hoac -MediaUrl/.../-IdentityUrl de bat)."
  }
  if ((-not $googleClientId) -and (-not $googleClientSecret) -and (-not $sessionSecret)) {
    Write-Warn "No Google login configured -- /login se tat (dung -EnvFile hoac -GoogleClientId/-GoogleClientSecret/-SessionSecret de bat). KG sync push/pull van chay duoc nhung attribution roi ve anonymous/installation-id."
  } elseif ((-not $googleClientId) -or (-not $googleClientSecret) -or (-not $sessionSecret)) {
    Write-Warn "Google login config khong du 3 bien (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/SESSION_SECRET) -- /login se tat cho toi khi ca 3 deu co."
  }
  Write-Ok "Wrote $configPath (ACL-locked to $env:USERNAME)"
}

function Set-CurrentPointer {
  $currentLink = Join-Path $OdHome "current"
  if (Test-Path $currentLink) {
    # Remove just the reparse point, never its target's contents --
    # Remove-Item -Recurse on a directory Junction/symlink is a well-known
    # PowerShell footgun that can delete the TARGET directory's contents on
    # some versions instead of just unlinking. `cmd /c rmdir` only ever
    # removes the reparse point itself.
    try { cmd /c rmdir "$currentLink" 2>$null | Out-Null } catch {}
  }
  New-Item -ItemType Junction -Path $currentLink -Target $ReleaseDir -Force | Out-Null
  $script:Activated = $true
  Write-Ok "current -> releases\$Version"
}

function Register-OdStartup {
  $shellExe = (Get-Process -Id $PID).Path
  # The command is stored as one REG_SZ exactly as Windows Explorer expects
  # for per-user logon startup. Both paths are quoted independently.
  $startupCommand = "`"$shellExe`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$LauncherPath`""
  try {
    New-Item -Path $StartupRegistryPath -Force -ErrorAction Stop | Out-Null
    New-ItemProperty -Path $StartupRegistryPath -Name $StartupValueName `
      -Value $startupCommand -PropertyType String -Force -ErrorAction Stop | Out-Null
    $script:StartupRegistered = $true
    # Remove the pre-HKCU implementation when upgrading. This is optional
    # cleanup only; the install no longer depends on Task Scheduler.
    try { Unregister-ScheduledTask -TaskName $LegacyTaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
  } catch {
    $script:StartupRegistered = $false
    Write-Warn "could not register per-user auto-start ($($_.Exception.Message)). Open Design will still start now; start it manually after login with: powershell -File `"$LauncherPath`""
  }
}

function Install-OdLauncher {
  $source = Join-Path $ReleaseDir "launcher.ps1"
  if (-not (Test-Path $source)) { Fail "release launcher is missing: $source" }
  $temporary = "$LauncherPath.tmp-$([System.Guid]::NewGuid().ToString('N'))"
  try {
    Copy-Item -LiteralPath $source -Destination $temporary -Force -ErrorAction Stop
    if (Test-Path $LauncherPath) {
      [System.IO.File]::Replace($temporary, $LauncherPath, $null, $true)
    } else {
      Move-Item -LiteralPath $temporary -Destination $LauncherPath
    }
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Install-OdCommandFiles {
  foreach ($commandFileName in $CommandFileMap.Keys) {
    $source = Join-Path $ReleaseDir $commandFileName
    $destination = Join-Path $OdHome $CommandFileMap[$commandFileName]
    if (-not (Test-Path $source)) { Fail "release command file is missing: $source" }
    # Keep these tiny wrappers stable while one of them is waiting for the
    # PowerShell installer. A deleted wrapper is restored by the next update;
    # existing wrappers are not replaced underneath a running cmd.exe.
    if (-not (Test-Path $destination)) {
      Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
    }
  }
}

function Step3-ExtractAndConfigure {
  Write-Phase "3/6 Giai nen & cai dat"
  $currentLink = Join-Path $OdHome "current"
  $currentItem = Get-Item -LiteralPath $currentLink -Force -ErrorAction SilentlyContinue
  if ($currentItem -and $currentItem.LinkType) {
    $targetVal = $currentItem.Target
    if ($targetVal -is [array]) { $targetVal = $targetVal[0] }
    $script:PrevCurrent = $targetVal
  }
  Expand-Release
  New-Item -ItemType Directory -Force -Path (Join-Path $OdHome "logs") | Out-Null
  # Prevent the supervisor from racing a pointer/config transaction if the
  # old daemon happens to exit before Step 5 owns the restart.
  Set-Content -LiteralPath $MaintenancePath -Value $PID -NoNewline
  Write-ConfigEnv
  # Once promotion/config are complete, persist recovery data before the
  # visible current pointer changes. This closes the power-loss/SIGKILL gap
  # between activation and the later restart handoff.
  if ($Update) { Save-UpdateTransaction }
  Set-CurrentPointer
  Install-OdLauncher
  Install-OdCommandFiles
  Register-OdStartup
}

# ---------------------------------------------------------------------------
# Step 4/6 -- service registration status (mirrors install.sh:507-521)
# ---------------------------------------------------------------------------
function Step4-ConfigureService {
  Write-Phase "4/6 Cau hinh dich vu"
  if ($NoStart) {
    Write-Step "-NoStart: service files written but not enabled"
    return
  }
  if ($StartupRegistered) {
    Write-Ok "Per-user auto-start registered: HKCU Run\$StartupValueName"
  } else {
    Write-Warn "auto-start not registered (see warning above) -- Open Design will run this session but not after your next login"
  }
}

# ---------------------------------------------------------------------------
# Step 5/6 -- start + health check + rollback (mirrors install.sh:523-621)
# ---------------------------------------------------------------------------
function Stop-OdService {
  $pidFile = Join-Path $OdHome "open-design.pid"
  if (-not (Test-Path $pidFile)) { return }
  $savedPid = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue)
  if ($savedPid) { $savedPid = $savedPid.Trim() }
  if ($savedPid) {
    $proc = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
    if ($proc) {
      try {
        Stop-Process -Id $savedPid -Force -ErrorAction Stop
      } catch {
        # Same primitive apps/daemon/src/runs.ts (~line 71) uses to
        # tree-kill its own spawned children -- consistent shutdown path
        # between the daemon and its own installer.
        try { & taskkill.exe /PID $savedPid /T /F 2>$null | Out-Null } catch {}
      }
    }
  }
  Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
}

# A daemon we did not start (an older install whose pid file is gone, a
# dev daemon, a survivor of a manual folder delete) can still be LISTENING
# on the port. Seen 2026-08-17 on a re-used PC: install.ps1 0.8.39 started
# its daemon, the health check hit the OLD 0.8.25 daemon (which answered
# /api/health fine but 404'd "/" because its release folder was gone),
# and the install reported success against a stale process. Only a
# reboot cleared it. So: before starting, find whoever listens on the
# port; if it is another Open Design daemon (node.exe answering our
# /api/health shape) stop it, if it is something else fail loudly.
# netstat, not Get-NetTCPConnection: the latter is a script/cdxml module
# that fails to auto-load when powershell.exe inherits a pwsh PSModulePath.
function Get-PortListenerPids {
  param([int]$PortNum)
  $pids = @()
  try {
    $lines = & netstat.exe -ano -p tcp 2>$null | Where-Object { $_ -match "^\s*TCP\s+\S+:$PortNum\s+\S+\s+LISTENING\s+(\d+)\s*$" }
    foreach ($line in $lines) {
      if ($line -match "LISTENING\s+(\d+)\s*$") { $pids += [int]$Matches[1] }
    }
  } catch {}
  return ($pids | Sort-Object -Unique)
}

function Stop-StalePortOwner {
  param([int]$PortNum)
  foreach ($ownerPid in (Get-PortListenerPids -PortNum $PortNum)) {
    if ($ownerPid -le 0 -or $ownerPid -eq $PID) { continue }
    $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    $health = $null
    try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$PortNum/api/health" -TimeoutSec 3 -ErrorAction Stop } catch {}
    $isOpenDesign = ($null -ne $health) -and ($health.ok -eq $true) -and ($null -ne $health.PSObject.Properties['version'])
    if ($isOpenDesign -and $proc.ProcessName -match '^node') {
      Write-Warn "Port $PortNum is held by another Open Design daemon (pid $ownerPid, version $($health.version)) -- stopping it"
      try { Stop-Process -Id $ownerPid -Force -ErrorAction Stop } catch {
        try { & taskkill.exe /PID $ownerPid /T /F 2>$null | Out-Null } catch {}
      }
      $waited = 0
      while ($waited -lt 10 -and (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 500; $waited++ }
    } else {
      Fail "Port $PortNum is already in use by $($proc.ProcessName) (pid $ownerPid) -- stop it, or install with -Port <other>"
    }
  }
}

function Start-OdService {
  Stop-OdService
  Start-Sleep -Seconds 1
  Stop-StalePortOwner -PortNum $ResolvedPort
  $logsDir = Join-Path $OdHome "logs"
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
  $outLog = Join-Path $logsDir "open-design.out.log"
  $errLog = Join-Path $logsDir "open-design.err.log"
  $cliPath = Join-Path $OdHome "current\apps\daemon\dist\cli.js"
  $pidFile = Join-Path $OdHome "open-design.pid"
  $proc = Start-Process -FilePath $NodeBin -ArgumentList @("`"$cliPath`"", "--no-open") `
    -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
  Set-Content -Path $pidFile -Value $proc.Id -NoNewline
}

function Save-UpdateTransaction {
  $state = [ordered]@{
    schemaVersion = 1
    targetVersion = $Version
    previousCurrent = $PrevCurrent
    releaseDir = $ReleaseDir
    configBackupPath = $ConfigBackupPath
    configExisted = [bool]$ConfigExisted
    configChanged = [bool]$ConfigChanged
    previousReleaseBackup = $PreviousReleaseBackup
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  $stateTemp = "$UpdateTransactionPath.tmp-$([System.Guid]::NewGuid().ToString('N'))"
  try {
    [System.IO.File]::WriteAllText(
      $stateTemp,
      ($state | ConvertTo-Json -Compress),
      [System.Text.UTF8Encoding]::new($false)
    )
    icacls $stateTemp /inheritance:r /grant:r "$env:USERDOMAIN\$($env:USERNAME):F" | Out-Null
    if (Test-Path $UpdateTransactionPath) {
      [System.IO.File]::Replace($stateTemp, $UpdateTransactionPath, $null, $true)
    } else {
      Move-Item -LiteralPath $stateTemp -Destination $UpdateTransactionPath
    }
  } finally {
    Remove-Item -Force $stateTemp -ErrorAction SilentlyContinue
  }
}

function Test-TransactionPathUnder {
  param([string]$Candidate, [string]$Parent)
  if (-not $Candidate) { return $false }
  try {
    $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $candidateFull = [System.IO.Path]::GetFullPath($Candidate)
    return $candidateFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Import-UpdateTransaction {
  if (-not (Test-Path $UpdateTransactionPath)) { return $false }
  try {
    $state = (Get-Content -LiteralPath $UpdateTransactionPath -Raw -ErrorAction Stop) | ConvertFrom-Json -ErrorAction Stop
    if ($state.schemaVersion -ne 1 -or -not $state.previousCurrent -or -not $state.releaseDir) {
      throw "unsupported or incomplete update transaction"
    }
    $releasesRoot = Join-Path $OdHome "releases"
    if (-not (Test-TransactionPathUnder ([string]$state.previousCurrent) $releasesRoot) -or
        -not (Test-TransactionPathUnder ([string]$state.releaseDir) $releasesRoot)) {
      throw "update transaction contains a release path outside $releasesRoot"
    }
    if ($state.previousReleaseBackup -and
        -not (Test-TransactionPathUnder ([string]$state.previousReleaseBackup) $releasesRoot)) {
      throw "update transaction contains an invalid release backup path"
    }
    if ($state.configBackupPath) {
      $configBackupParent = Split-Path ([string]$state.configBackupPath) -Parent
      $configBackupLeaf = Split-Path ([string]$state.configBackupPath) -Leaf
      if ([System.IO.Path]::GetFullPath($configBackupParent).TrimEnd('\') -ine [System.IO.Path]::GetFullPath($OdHome).TrimEnd('\') -or
          $configBackupLeaf -notlike '.config.env-backup-*') {
        throw "update transaction contains an invalid config backup path"
      }
    }
    $script:Version = [string]$state.targetVersion
    $script:PrevCurrent = [string]$state.previousCurrent
    $script:ReleaseDir = [string]$state.releaseDir
    $script:ConfigBackupPath = [string]$state.configBackupPath
    $script:ConfigExisted = [bool]$state.configExisted
    $script:ConfigChanged = [bool]$state.configChanged
    $script:PreviousReleaseBackup = [string]$state.previousReleaseBackup
    $script:Activated = $true
    $script:HandoffTransactionLoaded = $true
    return $true
  } catch {
    Write-Warn "could not read durable update transaction: $($_.Exception.Message)"
    return $false
  }
}

function Remove-UpdateTransaction {
  try {
    if (Test-Path $UpdateTransactionPath) {
      Remove-Item -Force $UpdateTransactionPath -ErrorAction Stop
    }
    $script:HandoffTransactionLoaded = $false
    return $true
  } catch {
    Write-Warn "could not remove durable update transaction: $($_.Exception.Message)"
    return $false
  }
}

function Request-LauncherUpdateRestart {
  $requestTemp = ""
  try {
    # A launcher bootstrapped from this daemon-owned updater would share the
    # process tree being stopped. Legacy installs therefore use the safe
    # restart-required fallback once; fresh installs already have a launcher
    # owned by the interactive user session.
    if (-not (Test-OdLauncherAlive)) { throw "the per-user launcher is not running" }
    $operationId = if ($env:OD_UPDATE_OPERATION_ID) { $env:OD_UPDATE_OPERATION_ID } else { [System.Guid]::NewGuid().ToString('N') }
    $request = [ordered]@{
      schemaVersion = 1
      operationId = $operationId
      targetVersion = $Version
      createdAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    $requestTemp = "$RestartRequestPath.tmp-$([System.Guid]::NewGuid().ToString('N'))"
    [System.IO.File]::WriteAllText($requestTemp, ($request | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
    icacls $requestTemp /inheritance:r /grant:r "$env:USERDOMAIN\$($env:USERNAME):F" | Out-Null
    # The launcher can react as soon as the atomic rename publishes this
    # file, so mark the handoff before making it visible.
    $script:RestartHandedOff = $true
    if (Test-Path $RestartRequestPath) {
      [System.IO.File]::Replace($requestTemp, $RestartRequestPath, $null, $true)
    } else {
      Move-Item -LiteralPath $requestTemp -Destination $RestartRequestPath
    }
    Write-Step "Restart delegated to the per-user launcher (operation $operationId)"
    return $true
  } catch {
    $script:RestartHandedOff = $false
    Write-Warn "could not delegate restart to the per-user launcher ($($_.Exception.Message)); a user restart is required"
    return $false
  } finally {
    if ($requestTemp) { Remove-Item -LiteralPath $requestTemp -Force -ErrorAction SilentlyContinue }
  }
}

function Wait-OdHealth {
  param([int]$PortNum, [int]$Timeout = $HealthTimeout, [string]$ExpectedVersion = "")
  $elapsed = 0
  $script:LastHealthVersion = ""
  while ($elapsed -lt $Timeout) {
    try {
      $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$PortNum/api/health" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
      if ($resp.StatusCode -eq 200) {
        if (-not $ExpectedVersion) { return $true }
        # "Healthy" must mean OUR daemon: a stale one on the same port
        # answers 200 too (see Stop-StalePortOwner). Compare the version.
        $body = $null
        try { $body = ([string]$resp.Content) | ConvertFrom-Json } catch {}
        $seen = if ($body -and $body.PSObject.Properties['version']) { [string]$body.version } else { "" }
        $script:LastHealthVersion = $seen
        if ($seen -eq $ExpectedVersion) { return $true }
      }
    } catch {
      # Not up yet -- mirrors install.sh's `|| echo 000`.
    }
    Start-Sleep -Seconds 2
    $elapsed += 2
  }
  return $false
}

# ---------------------------------------------------------------------------
# -Start / -Stop / -Uninstall -- lightweight commands against an already
# installed release. These never extract/verify/reconfigure anything (use
# -Update for that); they just need $OdHome and, for -Start, whichever
# Node.exe the original install resolved (private copy under
# $OdHome\tools, or system PATH -- re-detected here the same way
# Step2-EnsureNode did, minus the "download a private copy" fallback,
# since a bare -Start shouldn't trigger a multi-MB download).
# ---------------------------------------------------------------------------
function Resolve-ExistingNodeBin {
  $toolsDir = Join-Path $OdHome "tools"
  $private = Get-ChildItem -Path $toolsDir -Filter "node.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($private) { return $private.FullName }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Resolve-ExistingPort {
  $configEnv = Join-Path $OdHome "config.env"
  if (Test-Path $configEnv) {
    $line = Get-Content $configEnv | Where-Object { $_ -match '^OD_PORT=' } | Select-Object -First 1
    if ($line) { return [int](($line -split '=', 2)[1]) }
  }
  return $DefaultPort
}

function Test-OdLauncherAlive {
  if (-not (Test-Path $LauncherPidPath)) { return $false }
  $savedPid = (Get-Content -LiteralPath $LauncherPidPath -Raw -ErrorAction SilentlyContinue)
  if (-not $savedPid) { return $false }
  $savedPid = $savedPid.Trim()
  if ($savedPid -notmatch '^\d+$') { return $false }
  if ($null -eq (Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue)) { return $false }
  try {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction Stop
    return [bool]($processInfo.CommandLine -and
      ($processInfo.CommandLine.IndexOf($LauncherPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0))
  } catch {
    # Fail closed: a stale/recycled PID must never receive an update request.
    return $false
  }
}

function Start-OdLauncher {
  if (-not (Test-Path $LauncherPath)) { return $false }
  if (Test-OdLauncherAlive) { return $true }
  Remove-Item -LiteralPath $LauncherPidPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $LauncherStopRequestPath -Force -ErrorAction SilentlyContinue
  $shellExe = (Get-Process -Id $PID).Path
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$LauncherPath`""
  Start-Process -FilePath $shellExe -ArgumentList $arguments -WindowStyle Hidden | Out-Null
  return $true
}

function Stop-OdLauncher {
  if (-not (Test-OdLauncherAlive)) {
    Remove-Item -LiteralPath $LauncherPidPath -Force -ErrorAction SilentlyContinue
    return
  }
  $savedPid = [int]((Get-Content -LiteralPath $LauncherPidPath -Raw).Trim())
  Set-Content -LiteralPath $LauncherStopRequestPath -Value "stop" -NoNewline
  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-Process -Id $savedPid -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 250
  }
  # Only force-stop when WMI confirms the PID still belongs to our exact
  # launcher command. Never kill a recycled/unrelated PID from a stale file.
  try {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction Stop
    if ($processInfo.CommandLine -and $processInfo.CommandLine.IndexOf($LauncherPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      Stop-Process -Id $savedPid -Force -ErrorAction Stop
    }
  } catch {
    Write-Warn "launcher did not stop cleanly; refusing to kill an unverified PID $savedPid"
  }
  Remove-Item -LiteralPath $LauncherPidPath -Force -ErrorAction SilentlyContinue
}

function Invoke-StopCommand {
  New-Item -ItemType Directory -Force -Path $OdHome | Out-Null
  Stop-OdLauncher
  Stop-OdService
  Write-Ok "Stopped."
}

function Invoke-StartCommand {
  $transactionPending = Import-UpdateTransaction
  if ($transactionPending) {
    # Recovery may begin after promotion/config but before the original
    # installer atomically switched `current`. Finish that activation before
    # starting and only commit after target health succeeds.
    $currentItem = Get-Item -LiteralPath (Join-Path $OdHome "current") -Force -ErrorAction SilentlyContinue
    $currentTarget = if ($currentItem) { $currentItem.Target } else { "" }
    if ($currentTarget -is [array]) { $currentTarget = $currentTarget[0] }
    if (-not $currentTarget -or
        [System.IO.Path]::GetFullPath([string]$currentTarget).TrimEnd('\') -ine [System.IO.Path]::GetFullPath($ReleaseDir).TrimEnd('\')) {
      Set-CurrentPointer
    }
  }
  $cliPath = Join-Path $OdHome "current\apps\daemon\dist\cli.js"
  if (-not (Test-Path $cliPath)) { Fail "no install found at $OdHome -- run install.ps1 (without -Start) first" }
  $script:NodeBin = Resolve-ExistingNodeBin
  if (-not $NodeBin) { Fail "no Node.js found -- run install.ps1 (without -Start) first" }
  $resolvedPort = Resolve-ExistingPort
  Start-OdService
  Write-Step "Waiting for health check (up to $HealthTimeout s)..."
  if (Wait-OdHealth -PortNum $resolvedPort -Timeout $HealthTimeout) {
    Write-Ok "Daemon is healthy on port $resolvedPort"
    if ($transactionPending) {
      Complete-InstallationTransaction
      Write-Ok "Pending update transaction committed."
      Remove-OldReleases
    }
    [void](Start-OdLauncher)
    Write-Host "  URL: http://127.0.0.1:$resolvedPort"
  } else {
    if ($transactionPending) {
      Invoke-Rollback -Reason "Update restart failed its health check"
    }
    Fail "daemon did not become healthy -- check $OdHome\logs\"
  }
}

# Fresh install over an existing one = uninstall first, then install (asked
# 2026-08-18: "khi chay install thi truoc do se can go ban cu di truoc").
# OpenDesign-Install.cmd therefore no longer routes to -Update; only
# OpenDesign-Update.cmd / the web button / `od self-update` update in place.
# Runs AFTER Step 1 verified the new package so a download failure leaves
# the old install untouched. Project data (OD_DATA_DIR) is always kept;
# everything under $OdHome (runtime, private Node, config.env, logs, HKCU
# Run entry) goes.
function Remove-ExistingInstallation {
  $currentLink = Join-Path $OdHome "current"
  $hasInstall = (Test-Path $currentLink) -or
    (Test-Path (Join-Path $OdHome "releases")) -or
    (Test-Path (Join-Path $OdHome "config.env"))
  if (-not $hasInstall) { return }

  $oldVersion = ""
  try {
    $versionFile = Join-Path $currentLink "VERSION"
    if (Test-Path $versionFile) { $oldVersion = ((Get-Content $versionFile -Raw) -replace '\s', '') }
  } catch {}
  Write-Phase "Go ban cu"
  Write-Step "Found an existing Open Design$(if ($oldVersion) { " $oldVersion" }) at $OdHome -- removing it before the fresh install (project data is kept)"

  Stop-OdLauncher
  Stop-OdService
  try { Stop-StalePortOwner -PortNum (Resolve-ExistingPort) } catch {}
  try {
    Remove-ItemProperty -Path $StartupRegistryPath -Name $StartupValueName -Force -ErrorAction SilentlyContinue
  } catch {}
  try {
    Unregister-ScheduledTask -TaskName $LegacyTaskName -Confirm:$false -ErrorAction SilentlyContinue
  } catch {}

  # The junction must go first: Remove-Item -Recurse on a directory that
  # contains a junction is unreliable on Windows PowerShell 5.1.
  if (Test-Path $currentLink) { try { cmd /c rmdir "$currentLink" 2>$null | Out-Null } catch {} }
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    Remove-Item -Recurse -Force $OdHome -ErrorAction SilentlyContinue
    if (-not (Test-Path $OdHome)) { break }
    Start-Sleep -Seconds 2
  }
  if (Test-Path $OdHome) {
    Fail "could not remove the previous installation at $OdHome -- close programs using it (Explorer, terminals, editors) and run the installer again"
  }
  New-Item -ItemType Directory -Force -Path $OdHome | Out-Null
  Write-Ok "Previous installation removed$(if ($oldVersion) { " ($oldVersion)" })"
}

function Invoke-UninstallCommand {
  if (-not (Test-Path $OdHome)) { Fail "nothing installed at $OdHome" }

  # Must read OD_DATA_DIR before config.env gets deleted below.
  $configuredDataDir = Get-ExistingConfigValue "OD_DATA_DIR"
  $dataDir = if ($DataDir) { $DataDir } elseif ($configuredDataDir) { $configuredDataDir } else { $DefaultDataDir }

  Stop-OdLauncher
  Stop-OdService
  try {
    Remove-ItemProperty -Path $StartupRegistryPath -Name $StartupValueName `
      -Force -ErrorAction SilentlyContinue
  } catch {}
  # Remove tasks created by older releases. They are migration debris only;
  # current installs use HKCU Run and never require Task Scheduler access.
  try {
    Unregister-ScheduledTask -TaskName $LegacyTaskName -Confirm:$false `
      -ErrorAction SilentlyContinue
  } catch {}
  if (-not $Force) {
    $confirm = Read-Host "Remove $OdHome ? Project data is kept unless -DeleteData was given. Type 'yes' to confirm"
    if ($confirm -ne "yes") { Write-Warn "Uninstall cancelled."; exit 1 }
  }

  Remove-Item -Recurse -Force $OdHome -ErrorAction SilentlyContinue
  Write-Ok "Uninstalled."

  if ($DeleteData) {
    Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
    Write-Ok "Data removed: $dataDir"
  } else {
    Write-Host "  Data kept at: $dataDir (rerun with -DeleteData to also remove it)"
  }
}

function Invoke-Rollback {
  param([string]$Reason = "Install/update interrupted")
  if ($script:RollbackStarted) { return }
  $script:RollbackStarted = $true
  Write-Warn "$Reason -- rolling back"

  Stop-OdService
  $currentLink = Join-Path $OdHome "current"
  if ($Activated -and (Test-Path $currentLink)) {
    try { cmd /c rmdir "$currentLink" 2>$null | Out-Null } catch {}
  }

  $configPath = Join-Path $OdHome "config.env"
  $pointerRestored = $false
  $configRestored = $true
  $releaseRestored = $true
  if ($PrevCurrent) {
    try {
      $currentLink = Join-Path $OdHome "current"
      if (Test-Path $currentLink) { try { cmd /c rmdir "$currentLink" 2>$null | Out-Null } catch {} }
      New-Item -ItemType Junction -Path $currentLink -Target $PrevCurrent -Force | Out-Null
      $pointerRestored = $true
    } catch {
      Write-ErrorMsg "Could not restore current junction: $($_.Exception.Message)"
    }
  }

  try {
    if ($ConfigChanged -and $ConfigExisted) {
      if (-not $ConfigBackupPath -or -not (Test-Path $ConfigBackupPath)) {
        throw "config backup is missing: $ConfigBackupPath"
      }
      # Restore from a copy so the durable backup remains available until
      # pointer + config + release + old-daemon health have all succeeded.
      $configRestoreTemp = Join-Path $OdHome (".config.env-restore-" + [System.Guid]::NewGuid().ToString("N") + ".tmp")
      try {
        Copy-Item -LiteralPath $ConfigBackupPath -Destination $configRestoreTemp -ErrorAction Stop
        if (Test-Path $configPath) {
          [System.IO.File]::Replace($configRestoreTemp, $configPath, $null, $true)
        } else {
          Move-Item -LiteralPath $configRestoreTemp -Destination $configPath
        }
      } finally {
        Remove-Item -Force $configRestoreTemp -ErrorAction SilentlyContinue
      }
    } elseif ($ConfigChanged -and -not $ConfigExisted -and (Test-Path $configPath)) {
      Remove-Item -Force $configPath -ErrorAction Stop
    }
  } catch {
    $configRestored = $false
    Write-ErrorMsg "Could not restore config.env: $($_.Exception.Message)"
  }

  # Restore any inactive release displaced during promotion. This is kept
  # separate from pointer/config restoration so one cleanup failure cannot
  # prevent the previous service from being restarted.
  if ($PreviousReleaseBackup) {
    $releaseBackupForRestore = $PreviousReleaseBackup
    try {
      if (-not (Test-Path $PreviousReleaseBackup)) {
        throw "release backup is missing: $PreviousReleaseBackup"
      }
      if (Test-Path $ReleaseDir) { Remove-Item -Recurse -Force $ReleaseDir -ErrorAction Stop }
      Move-Item -LiteralPath $PreviousReleaseBackup -Destination $ReleaseDir -ErrorAction Stop
      $script:PreviousReleaseBackup = ""
      if (Test-Path $UpdateTransactionPath) {
        # Checkpoint the now-idempotent state. If the old daemon later fails
        # health, the next recovery attempt must not look for a backup that
        # was already promoted back into place.
        try {
          Save-UpdateTransaction
        } catch {
          # Keep disk state consistent with the still-old transaction so a
          # later recovery can retry instead of referencing a consumed path.
          $script:PreviousReleaseBackup = $releaseBackupForRestore
          if ((Test-Path $ReleaseDir) -and -not (Test-Path $releaseBackupForRestore)) {
            Move-Item -LiteralPath $ReleaseDir -Destination $releaseBackupForRestore -ErrorAction Stop
          }
          throw
        }
      }
    } catch {
      $releaseRestored = $false
      Write-ErrorMsg "Could not fully restore/checkpoint displaced release: $($_.Exception.Message)"
    }
  }

  $oldDaemonHealthy = $false
  if ($PrevCurrent -and $pointerRestored) {
    try {
      Register-OdStartup
      Start-OdService
      $rollbackPort = Resolve-ExistingPort
      if (Wait-OdHealth -PortNum $rollbackPort -Timeout 30) {
        Write-Warn "Previous daemon is healthy after the rollback attempt."
        $oldDaemonHealthy = $true
      } else {
        Write-ErrorMsg "Rollback also failed the health check -- manual intervention required."
      }
    } catch {
      Write-ErrorMsg "Could not restart the previous release: $($_.Exception.Message)"
    }
  } elseif (-not $PrevCurrent) {
    try {
      Remove-ItemProperty -Path $StartupRegistryPath -Name $StartupValueName -Force -ErrorAction SilentlyContinue
    } catch {}
    Remove-Item -LiteralPath $MaintenancePath -Force -ErrorAction SilentlyContinue
    Write-ErrorMsg "No previous release to roll back to. Service stopped."
  }
  $rollbackSucceeded = $pointerRestored -and $configRestored -and $releaseRestored -and $oldDaemonHealthy
  if ($rollbackSucceeded) {
    # Remove the transaction first. If this fails, retain the config backup
    # so the still-present transaction remains retryable and self-consistent.
    if (Remove-UpdateTransaction) {
      if ($ConfigBackupPath -and (Test-Path $ConfigBackupPath)) {
        try { Remove-Item -Force $ConfigBackupPath -ErrorAction Stop } catch {
          Write-Warn "Rollback succeeded, but obsolete config backup cleanup failed: $($_.Exception.Message)"
        }
      }
      Write-Warn "Rolled back successfully. Release $Version was NOT activated."
      Remove-Item -LiteralPath $MaintenancePath -Force -ErrorAction SilentlyContinue
    } else {
      Write-ErrorMsg "Rollback data was restored, but durable transaction cleanup failed; recovery files were kept."
    }
  } else {
    Write-ErrorMsg "Rollback is incomplete; durable transaction kept at $UpdateTransactionPath for recovery."
  }
  Write-ErrorMsg "Install/update FAILED for version $Version. Logs: $OdHome\logs\"
}

function Complete-InstallationTransaction {
  $script:HealthSucceeded = $true
  $cleanupComplete = $true
  if ($ConfigBackupPath -and (Test-Path $ConfigBackupPath)) {
    try {
      Remove-Item -Force $ConfigBackupPath -ErrorAction Stop
      $script:ConfigBackupPath = ""
    } catch {
      $cleanupComplete = $false
      Write-Warn "healthy update committed, but config backup cleanup will be retried on next -Start: $($_.Exception.Message)"
    }
  }
  if ($PreviousReleaseBackup -and (Test-Path $PreviousReleaseBackup)) {
    try {
      Remove-Item -Recurse -Force $PreviousReleaseBackup -ErrorAction Stop
      $script:PreviousReleaseBackup = ""
    } catch {
      $cleanupComplete = $false
      Write-Warn "healthy update committed, but release backup cleanup will be retried on next -Start: $($_.Exception.Message)"
    }
  }
  if ($cleanupComplete) { [void](Remove-UpdateTransaction) }
  Remove-Item -LiteralPath $MaintenancePath -Force -ErrorAction SilentlyContinue
}

# After a HEALTHY install/update, remove every release under $OdHome\releases
# that is not the one `current` points at (asked 2026-08-18: the web "Cap
# nhat" button must leave the machine with only the new version -- old
# removed, new installed and started -- ordered install -> start -> remove
# so a failed health check can still roll back). Called ONLY after a
# confirmed healthy start: Step 5 on a direct install/-Update, and the
# launcher-owned -Start on a self-update (never on -NoStart, where nothing
# verified the new release). In both cases the old daemon is already
# gone. Never touches the running
# release, project data, tools\ (private Node) or logs. Best-effort.
function Remove-OldReleases {
  $releasesDir = Join-Path $OdHome "releases"
  if (-not (Test-Path $releasesDir)) { return }
  $currentItem = Get-Item -LiteralPath (Join-Path $OdHome "current") -Force -ErrorAction SilentlyContinue
  if (-not $currentItem) { return }
  $currentTarget = $currentItem.Target
  if ($currentTarget -is [array]) { $currentTarget = $currentTarget[0] }
  if (-not $currentTarget) { return }
  $currentFull = [System.IO.Path]::GetFullPath([string]$currentTarget).TrimEnd('\')
  $removed = 0
  foreach ($entry in (Get-ChildItem -LiteralPath $releasesDir -Force -ErrorAction SilentlyContinue)) {
    $entryFull = [System.IO.Path]::GetFullPath($entry.FullName).TrimEnd('\')
    if ($entryFull -ieq $currentFull) { continue }
    try {
      Remove-Item -LiteralPath $entry.FullName -Recurse -Force -ErrorAction Stop
      $removed++
    } catch {
      Write-Warn "could not remove old release: $($entry.FullName) -- $($_.Exception.Message)"
    }
  }
  if ($removed -gt 0) { Write-Ok "Removed $removed old release(s); only $(Split-Path $currentFull -Leaf) remains" }
}

function Step5-StartAndHealthCheck {
  Write-Phase "5/6 Khoi dong & kiem tra suc khoe"
  if ($NoStart) {
    Write-Step "-NoStart: skipping service start and health check"
    Complete-InstallationTransaction
    return
  }
  if ($Update -and $env:OD_SELF_UPDATE -eq "1") {
    # Persistence is mandatory even when launcher handoff is unavailable:
    # the next manual/logon start must be able to commit or roll back.
    # A persistence failure throws into the outer installer catch and rolls
    # the activation back instead of falsely reporting restart-required.
    Save-UpdateTransaction
    if (Request-LauncherUpdateRestart) {
      # The independent launcher invokes this script with -Start. Keep this
      # process alive until it stops the old daemon/process tree; otherwise
      # the old daemon would mistake a normal child exit for update failure.
      $script:RestartHandedOff = $true
      while ($true) { Start-Sleep -Seconds 5 }
    }
    # The archive and durable rollback state are already safely on disk, but
    # stopping the daemon here would also terminate this attached updater.
    # Keep the old daemon serving requests and report a non-error terminal
    # state to its parent. A later manual/launcher restart activates the new
    # release and completes or rolls back the transaction.
    $script:RestartHandedOff = $true
    $script:RestartRequired = $true
    throw [System.InvalidOperationException]::new(
      "update installed, but Open Design must be restarted to activate version $Version"
    )
  }
  Start-OdService
  Write-Step "Waiting for health check (up to $HealthTimeout s)..."
  if (Wait-OdHealth -PortNum $ResolvedPort -Timeout $HealthTimeout -ExpectedVersion $Version) {
    Write-Ok "Daemon $Version is healthy on port $ResolvedPort"
    Complete-InstallationTransaction
    Remove-OldReleases
    [void](Start-OdLauncher)
  } else {
    if ($LastHealthVersion -and $LastHealthVersion -ne $Version) {
      Write-ErrorMsg "Port $ResolvedPort answers as Open Design $LastHealthVersion, not the just-installed $Version -- another daemon is holding the port."
    }
    Invoke-Rollback -Reason "Health check failed"
    throw [System.InvalidOperationException]::new("daemon did not become healthy after activating version $Version")
  }
}

# ---------------------------------------------------------------------------
# Step 6/6 -- Claude CLI + login probe + final checklist
# (mirrors install.sh:623-707, minus the Darwin-only Keychain probe branch,
# which had nothing to replace it with on Windows)
# ---------------------------------------------------------------------------
function Test-ClaudeLogin {
  if ($env:ANTHROPIC_API_KEY -or $env:CLAUDE_CODE_USE_BEDROCK -or $env:CLAUDE_CODE_USE_VERTEX) {
    return $true
  }
  $configDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".claude" }
  $credFile = Join-Path $configDir ".credentials.json"
  if (Test-Path $credFile) {
    $content = Get-Content $credFile -Raw -ErrorAction SilentlyContinue
    if ($content -match '"accessToken"\s*:\s*"[^"]') { return $true }
  }
  $settingsFile = Join-Path $configDir "settings.json"
  if (Test-Path $settingsFile) {
    $content = Get-Content $settingsFile -Raw -ErrorAction SilentlyContinue
    if ($content -match '"apiKeyHelper"\s*:\s*"[^"]') { return $true }
  }
  return $false
}

# Mirrors probe_codex_login in install.sh -- same on-disk signal
# (<CODEX_HOME>/auth.json, default %USERPROFILE%\.codex), same flat-regex
# best-effort approach (not a real JSON parser).
function Test-CodexLogin {
  if ($env:OPENAI_API_KEY) { return $true }
  $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
  $authFile = Join-Path $codexHome "auth.json"
  if (Test-Path $authFile) {
    $content = Get-Content $authFile -Raw -ErrorAction SilentlyContinue
    if ($content -match '"(access_token|OPENAI_API_KEY)"\s*:\s*"[^"]') { return $true }
  }
  return $false
}

function Install-CodexCli {
  Write-Warn "codex CLI not found on PATH -- installing via the native Windows installer"
  # Verified at implementation time: chatgpt.com/codex/install.ps1 redirects
  # to releases.openai.com/codex/install.ps1 (fetched and inspected
  # directly). Version pin is $env:CODEX_RELEASE (not a positional arg, and
  # not implemented here yet -- no codex.version bundled by build-runtime.sh,
  # matches install.sh's own no-pin-yet scope decision). CODEX_NON_INTERACTIVE
  # skips prompts, same invariant as every other unattended step here.
  $tmpDir = New-TempDir
  $installerFile = Join-Path $tmpDir "codex-install.ps1"
  try {
    Invoke-DownloadFile -Url "https://chatgpt.com/codex/install.ps1" -Destination $installerFile -TimeoutSec 60
  } catch {
    Write-Warn "Codex CLI install failed -- install manually: irm https://chatgpt.com/codex/install.ps1 | iex"
    return
  }
  $shellExe = (Get-Process -Id $PID).Path
  $env:CODEX_NON_INTERACTIVE = "true"
  & $shellExe -NoProfile -ExecutionPolicy Bypass -File $installerFile
  if ($LASTEXITCODE -ne 0) {
    Write-Warn "Codex CLI install failed -- install manually: irm https://chatgpt.com/codex/install.ps1 | iex"
  }
}

function Install-ClaudeCli {
  Write-Warn "claude CLI not found on PATH -- installing via the native Windows installer"
  # Verified at implementation time: Anthropic DOES publish a native Windows
  # PowerShell installer at https://claude.ai/install.ps1 (fetched and
  # inspected directly -- not assumed). It takes one optional positional
  # argument: a version pin ("stable" | "latest" | "X.Y.Z[-suffix]").
  $pin = ""
  $pinFile = Join-Path $ReleaseDir "claude.version"
  if (Test-Path $pinFile) { $pin = (Get-Content $pinFile -Raw).Trim() }

  $tmpDir = New-TempDir
  $installerFile = Join-Path $tmpDir "claude-install.ps1"
  try {
    Invoke-DownloadFile -Url "https://claude.ai/install.ps1" -Destination $installerFile -TimeoutSec 60
  } catch {
    Write-Warn "Claude CLI install failed -- install manually: irm https://claude.ai/install.ps1 | iex"
    return
  }

  # Run in a SEPARATE PowerShell process. The downloaded installer calls
  # `exit` on failure -- running it in-process (Invoke-Expression) would
  # tear this installer down too. A child process isolates that, mirroring
  # how install.sh's `curl ... | bash -s -- "$pin"` only exits its own
  # subshell, never the parent install.sh.
  $shellExe = (Get-Process -Id $PID).Path
  $pinnedOk = $true
  if ($pin) {
    Write-Step "Attempting pinned install (claude.version=$pin)"
    & $shellExe -NoProfile -ExecutionPolicy Bypass -File $installerFile $pin
    if ($LASTEXITCODE -ne 0) { $pinnedOk = $false }
  }

  if ((-not $pin) -or (-not $pinnedOk)) {
    if ($pin -and -not $pinnedOk) {
      Write-Warn "Pinned Claude CLI install failed or is unsupported by the installer -- falling back to latest"
    }
    & $shellExe -NoProfile -ExecutionPolicy Bypass -File $installerFile
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "Claude CLI install failed -- install manually: irm https://claude.ai/install.ps1 | iex"
    }
  }
}

function Step6-ClaudeAndSummary {
  Write-Phase "6/6 Kiem tra Claude & Codex CLI & hoan tat"
  $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
  if ($claudeCmd) {
    Write-Ok "claude CLI found on PATH: $($claudeCmd.Source)"
  } else {
    Install-ClaudeCli
  }
  $codexCmd = Get-Command codex -ErrorAction SilentlyContinue
  if ($codexCmd) {
    Write-Ok "codex CLI found on PATH: $($codexCmd.Source)"
  } else {
    Install-CodexCli
  }

  $loginOk = Test-ClaudeLogin
  $codexLoginOk = Test-CodexLogin

  # Final checklist -- od sandbox status already reports Claude sandbox
  # image/auth-volume health (Docker sandbox specific); best-effort, never
  # fails the install.
  if (-not $NoStart) {
    $cliPath = Join-Path $OdHome "current\apps\daemon\dist\cli.js"
    # Mirrors install.sh: stderr suppressed, stdout shown (this prints the
    # actual checklist to the user), non-zero exit never fails the install.
    try { & $NodeBin $cliPath sandbox status --daemon-url "http://127.0.0.1:$ResolvedPort" 2>$null } catch {}
  }

  Write-Host ""
  Write-Host " -- Cai dat hoan tat ------------------------------" -ForegroundColor Green
  Write-Host ""
  if (-not $NoStart) {
    Write-Host "  URL:      http://127.0.0.1:$ResolvedPort"
  }
  Write-Host "  Version:  $Version"
  Write-Host "  Home:     $OdHome"
  Write-Host "  Config:   $(Join-Path $OdHome 'config.env')"
  Write-Host "  Controls: $(Join-Path $OdHome 'OpenDesign-Start.cmd') / OpenDesign-Stop.cmd / OpenDesign-Update.cmd"
  if ($StartupRegistered) {
    Write-Host "  Service:  per-user startup (HKCU Run\$StartupValueName)"
  } else {
    $cliPath = Join-Path $OdHome "current\apps\daemon\dist\cli.js"
    Write-Host "  Service:  NOT auto-starting -- start manually: `"$NodeBin`" `"$cliPath`" --no-open"
  }
  Write-Host ""
  if (-not $loginOk) {
    Write-Host '  con mot buoc: chay `claude /login` de dang nhap Claude Code.' -ForegroundColor Yellow
    Write-Host ""
  }
  if (-not $codexLoginOk) {
    Write-Host '  con mot buoc: chay `codex login` de dang nhap Codex CLI.' -ForegroundColor Yellow
    Write-Host ""
  }
  Write-Host "  Update:    powershell -File $(Join-Path $OdHome 'current\install.ps1') -Update"
  Write-Host "  Uninstall/rollback: see deploy/host/README.md"
  Write-Host ""
}

# ---------------------------------------------------------------------------
# -Update summary (mirrors install.sh's print_update_summary, install.sh:712-726)
# ---------------------------------------------------------------------------
function Show-UpdateSummary {
  if ($NoStart) {
    Write-Ok "Update installed (not started -- -NoStart)."
    return
  }
  $printed = "unknown"
  try {
    $versionJson = Invoke-RestMethod -Uri "http://127.0.0.1:$ResolvedPort/api/version" -TimeoutSec 5 -ErrorAction Stop
    $v = $versionJson.version
    if ($v -is [string]) {
      $printed = $v
    } elseif ($null -ne $v) {
      $printed = ($v | ConvertTo-Json -Compress)
    }
  } catch {
    # Leave $printed = "unknown" -- mirrors install.sh's `|| echo '{}'` +
    # catch-all in its inline node parser.
  }
  Write-Ok "Updated. Running /api/version: $printed"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
function Invoke-Main {
  Write-Host ""
  Write-Host "  Open Design -- Host Runtime (Windows)" -ForegroundColor White
  Write-Host "  One-command installer" -ForegroundColor DarkGray

  New-Item -ItemType Directory -Force -Path $OdHome | Out-Null

  if ($InsecureTls -or (Get-ExistingConfigValue "OD_INSECURE_TLS") -eq "1") {
    Enable-InsecureTls
    Write-Warn "TLS certificate validation is OFF for this installer run (-InsecureTls / OD_INSECURE_TLS=1)."
  }
  Resolve-ReleaseUrl
  Invoke-PreflightCheck
  Step1-VerifyPackage
  if (-not $Update) { Remove-ExistingInstallation }
  Step2-EnsureNode
  Step3-ExtractAndConfigure
  Step4-ConfigureService
  Step5-StartAndHealthCheck

  if ($Update) {
    Show-UpdateSummary
  } else {
    Step6-ClaudeAndSummary
  }
}

# deploy/tests/host-install.test.ts equivalents on Windows would source this
# script with OD_INSTALL_PS1_TEST_SOURCE=1 to unit-test individual functions
# (tar safety, checksum, config.env generation, rollback) without ever
# registering real auto-start state -- same seam as install.sh's
# OD_INSTALL_SH_TEST_SOURCE guard. Every real invocation (irm | iex,
# powershell -File install.ps1 ...) leaves this unset and runs normally.
try {
  if ($env:OD_INSTALL_PS1_TEST_SOURCE -ne "1") {
    Assert-Parameters
    if ($Stop) {
      Invoke-StopCommand
    } elseif ($Uninstall) {
      Invoke-UninstallCommand
    } elseif ($Start) {
      Invoke-StartCommand
    } else {
      Invoke-Main
    }
  }
} catch {
  $failure = $_
  if ($RestartRequired) {
    Write-Warn $failure.Exception.Message
    exit $RestartRequiredExitCode
  }
  if (-not $HealthSucceeded -and -not $RestartHandedOff -and
      ($Activated -or $ConfigChanged -or $PreviousReleaseBackup)) {
    try { Invoke-Rollback -Reason "Installer failed or was cancelled" } catch {
      Write-ErrorMsg "Rollback raised an additional error: $($_.Exception.Message)"
    }
  }
  Write-ErrorMsg $failure.Exception.Message
  exit 1
} finally {
  # PipelineStoppedException (Ctrl+C) is not consistently delivered through
  # catch on Windows PowerShell hosts. The finally guard covers that path.
  if (-not $HealthSucceeded -and -not $RestartHandedOff -and -not $RollbackStarted -and
      ($Activated -or $ConfigChanged -or $PreviousReleaseBackup)) {
    try { Invoke-Rollback -Reason "Installer interrupted before health confirmation" } catch {}
  }
  foreach ($d in $script:TempDirs) {
    Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
  }
}
