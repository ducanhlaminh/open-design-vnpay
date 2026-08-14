<#
.SYNOPSIS
  Open Design -- host runtime one-command installer for Windows.

.DESCRIPTION
  Installs the daemon + static web export directly on a 64-bit Windows 10
  (1803+) / Windows 11 host, no Docker required. This is a step-for-step
  mirror of deploy/host/install.sh (same 6 phases, same phase names/order,
  same config.env shape, same rollback behavior) -- NOT a syntax port, a
  logic port. Native Windows primitives replace the POSIX ones:

    - Task Scheduler ONLOGON task (schtasks.exe, /RL LIMITED, no admin)
      instead of a launchd LaunchAgent / systemd --user unit.
    - A directory Junction (New-Item -ItemType Junction, no admin/Developer
      Mode required -- unlike a real symlink) instead of `ln -sfn`.
    - tar.exe (bundled since Windows 10 1803 / Windows 11 -- this is the
      minimum supported Windows version) instead of GNU tar, for the same
      "list before extract" `..`-traversal + single-root-dir safety check.
    - Get-FileHash -Algorithm SHA256 (built into PowerShell 5.1+) instead
      of sha256sum/shasum.

  No sudo/admin is used anywhere -- everything lives under
  %USERPROFILE%\.open-design by default, exactly like install.sh keeps
  everything under $HOME.

.PARAMETER Archive
  Use a local tarball instead of downloading.

.PARAMETER ReleaseUrl
  A direct .tar.gz URL, or a release "asset base" URL (e.g. a GitHub
  releases/download/<tag> folder) containing a release.json manifest.
  Default: the latest GitHub release of this repo.

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

.PARAMETER Help
  Show this help and exit.

.EXAMPLE
  irm https://raw.githubusercontent.com/<repo>/<tag>/deploy/host/install.ps1 | iex

.EXAMPLE
  .\install.ps1 -Archive .\open-design-runtime-1.2.3-win32-x64.tar.gz -NoStart
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
  [switch]$Help
)

if ($Help) {
  if ($PSCommandPath) {
    Get-Help $PSCommandPath -Full
  } else {
    Write-Host "Open Design host runtime installer (Windows). See deploy/host/README.md for full docs."
    Write-Host "Flags: -Archive -ReleaseUrl -Sha256 -Port -DataDir -EnvFile -MediaUrl -MediaAppId -MediaUserId -MediaUserRole -IdentityUrl -GoogleClientId -GoogleClientSecret -SessionSecret -NoStart -Update"
  }
  exit 0
}

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# ---------------------------------------------------------------------------
# Configuration -- mirrors install.sh's "Configuration" block.
# ---------------------------------------------------------------------------
$DefaultGhRepo = "ducanhlaminh/open-design-vnpay"
$OdHome = Join-Path $env:USERPROFILE ".open-design"
$DefaultPort = 7456
$DefaultDataDir = Join-Path $env:USERPROFILE "od-data\open-design"
# Mirrors apps/daemon/package.json#engines ("~24") -- same cross-reference
# note as install.sh: checked at implementation time rather than parsed at
# install time, so step 1 never depends on a JSON parser being available.
$RequiredNodeMajor = 24
$HealthTimeout = 60
# Per-user Task Scheduler task name -- the Windows equivalent of install.sh's
# launchd SERVICE_LABEL / systemd unit name.
$TaskName = "OpenDesignDaemon"

# ---------------------------------------------------------------------------
# Script-scope mutable state (set by the step functions below).
# ---------------------------------------------------------------------------
$script:ArchivePath = ""
$script:ArchiveShaHint = ""
$script:Platform = ""
$script:StageName = ""
$script:Version = ""
$script:NodeBin = ""
$script:ReleaseDir = ""
$script:PrevCurrent = ""
$script:ResolvedPort = ""
$script:EnvFileVars = @()
$script:TempDirs = @()

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
function Write-Phase($msg) { Write-Host ""; Write-Host $msg -ForegroundColor White }
function Write-Step($msg)  { Write-Host "  > $msg" -ForegroundColor DarkGray }
function Write-Ok($msg)    { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-ErrorMsg($msg) { Write-Host "  [x] $msg" -ForegroundColor Red }
function Write-Info($msg)  { Write-Host "  > $msg" -ForegroundColor Cyan }

function Fail($msg) {
  Write-ErrorMsg $msg
  exit 1
}

function New-TempDir {
  $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("od-install-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $script:TempDirs += $dir
  return $dir
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
  param([string]$Url, [string]$Sha256Url = "")
  $dlDir = New-TempDir
  $script:ArchivePath = Join-Path $dlDir (Split-Path $Url -Leaf)
  Write-Step "Downloading $(Split-Path $Url -Leaf)"
  try {
    Invoke-WebRequest -Uri $Url -OutFile $ArchivePath -UseBasicParsing
  } catch {
    Fail "download failed: $Url"
  }
  if ($Sha256Url) {
    try {
      $shaTmp = "$ArchivePath.sha256"
      Invoke-WebRequest -Uri $Sha256Url -OutFile $shaTmp -UseBasicParsing -ErrorAction Stop
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
    try {
      $apiJson = Invoke-RestMethod -Uri "https://api.github.com/repos/$DefaultGhRepo/releases/latest" `
        -Headers @{ Accept = "application/vnd.github+json" }
    } catch {
      Fail "could not reach the GitHub API -- pass -Archive or -ReleaseUrl for an offline/mirror install"
    }
    $releaseJsonAsset = $apiJson.assets | Where-Object { $_.browser_download_url -match 'release\.json$' } | Select-Object -First 1
    if (-not $releaseJsonAsset) { Fail "the latest GitHub release has no release.json asset" }
    $releaseJsonUrl = $releaseJsonAsset.browser_download_url
  }

  # release.json shape (see .github/workflows/release-host-runtime.yml):
  #   { "version": "...", "tag": "...",
  #     "<platform>.url": "https://.../open-design-runtime-<v>-<platform>.tar.gz",
  #     "<platform>.sha256": "<hex>", ... one pair per supported platform ... }
  try {
    $relJson = Invoke-RestMethod -Uri $releaseJsonUrl
  } catch {
    Fail "could not fetch release.json from $releaseJsonUrl"
  }
  $tarballUrl = Get-FlatJsonValue $relJson "$Platform.url"
  $tarballSha = Get-FlatJsonValue $relJson "$Platform.sha256"
  if (-not $tarballUrl) { Fail "release.json has no entry for platform $Platform" }

  Get-Archive -Url $tarballUrl
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
  $listing = & tar.exe -tzf $ArchivePath 2>$null
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

function Test-Checksum {
  $expected = if ($Sha256) { $Sha256 } else { $ArchiveShaHint }
  if (-not $expected) {
    Fail "no checksum to verify against -- pass -Sha256 or ensure a .sha256/release.json entry is available"
  }
  $actual = (Get-FileHash -Path $ArchivePath -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) {
    Fail "checksum mismatch for ${ArchivePath}: expected $expected, got $actual"
  }
  Write-Ok "Checksum verified (sha256)"
}

function Step1-VerifyPackage {
  Write-Phase "1/6 Kiểm tra gói cài đặt"
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
    $shasums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/latest-v$RequiredNodeMajor.x/SHASUMS256.txt" -UseBasicParsing).Content
  } catch {
    Fail "could not fetch Node.js $RequiredNodeMajor.x SHASUMS256.txt"
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
    Invoke-WebRequest -Uri "https://nodejs.org/dist/latest-v$RequiredNodeMajor.x/$filename" -OutFile $nodeZip -UseBasicParsing
  } catch {
    Fail "download failed: $filename"
  }
  $actualSha = (Get-FileHash -Path $nodeZip -Algorithm SHA256).Hash.ToLower()
  if ($actualSha -ne $expectedSha) { Fail "Node.js checksum mismatch (SHASUMS256.txt) for $filename" }

  $toolsDir = Join-Path $OdHome "tools"
  New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
  Expand-Archive -Path $nodeZip -DestinationPath $toolsDir -Force
  $nodeDirName = [System.IO.Path]::GetFileNameWithoutExtension($filename)
  $script:NodeBin = Join-Path $toolsDir "$nodeDirName\node.exe"
  if (-not (Test-Path $NodeBin)) { Fail "Node install did not produce an executable at $NodeBin" }
  Write-Ok "Private Node.js installed: $NodeBin"
}

function Step2-EnsureNode {
  Write-Phase "2/6 Kiểm tra Node.js"
  if (Test-NodeSatisfiesEngine) {
    $script:NodeBin = (Get-Command node).Source
    Write-Ok "System Node.js satisfies engines (~$RequiredNodeMajor): $NodeBin"
  } else {
    Write-Warn "System Node.js missing or not ~$RequiredNodeMajor -- installing a private copy under $OdHome\tools"
    Install-PrivateNode
  }
}

# ---------------------------------------------------------------------------
# Step 3/6 -- extract + config.env + `current` junction + scheduled task
# (mirrors install.sh:358-505)
# ---------------------------------------------------------------------------
function Expand-Release {
  $releasesDir = Join-Path $OdHome "releases"
  New-Item -ItemType Directory -Force -Path $releasesDir | Out-Null
  $script:ReleaseDir = Join-Path $releasesDir $Version
  if (Test-Path $ReleaseDir) { Remove-Item -Recurse -Force $ReleaseDir }
  New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null
  & tar.exe -xzf $ArchivePath -C $ReleaseDir --strip-components=1
  if ($LASTEXITCODE -ne 0) { Fail "failed to extract $ArchivePath" }
  Write-Ok "Extracted to $ReleaseDir"
}

# -EnvFile (url|path) -> whitelisted KEY=VALUE lines only, never invoked as
# arbitrary script -- same whitelist as install.sh's load_env_file().
$OdEnvFileAllowedKeys = @(
  'MEDIA_URL', 'MEDIA_APP_ID', 'MEDIA_USER_ID', 'MEDIA_USER_ROLE',
  'IDENTITY_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET',
  'OD_PORT', 'OD_DATA_DIR'
)

function Import-EnvFile {
  if (-not $EnvFile) { return }
  $efPath = $EnvFile
  if ($EnvFile -match '^https?://') {
    $efPath = Join-Path (New-TempDir) "env-file"
    try {
      Invoke-WebRequest -Uri $EnvFile -OutFile $efPath -UseBasicParsing
    } catch {
      Fail "could not fetch -EnvFile $EnvFile"
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
  [System.IO.File]::WriteAllLines($configPath, [string[]]$lines, [System.Text.UTF8Encoding]::new($false))
  # ACL-lock to the current user only -- the Windows equivalent of chmod 600.
  icacls $configPath /inheritance:r /grant:r "$env:USERDOMAIN\$($env:USERNAME):F" | Out-Null

  if ((-not $mediaUrl) -and (-not $identityUrl)) {
    Write-Warn "No Media/Identity endpoints configured — KG sync sẽ tắt (dùng -EnvFile hoặc -MediaUrl/.../-IdentityUrl để bật)."
  }
  if ((-not $googleClientId) -and (-not $googleClientSecret) -and (-not $sessionSecret)) {
    Write-Warn "No Google login configured — /login sẽ tắt (dùng -EnvFile hoặc -GoogleClientId/-GoogleClientSecret/-SessionSecret để bật). KG sync push/pull vẫn chạy được nhưng attribution rơi về anonymous/installation-id."
  } elseif ((-not $googleClientId) -or (-not $googleClientSecret) -or (-not $sessionSecret)) {
    Write-Warn "Google login config không đủ 3 biến (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/SESSION_SECRET) — /login sẽ tắt cho tới khi cả 3 đều có."
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
    cmd /c rmdir "$currentLink" 2>$null | Out-Null
  }
  New-Item -ItemType Junction -Path $currentLink -Target $ReleaseDir -Force | Out-Null
  Write-Ok "current -> releases\$Version"
}

function Register-OdTask {
  $cliPath = Join-Path $OdHome "current\apps\daemon\dist\cli.js"
  # Per-user, no admin required (/RL LIMITED), fires on next logon --
  # equivalent role to a LaunchAgent/systemd --user unit. Deliberately NOT
  # sc.exe create (needs admin) and NOT NSSM (extra dependency).
  & schtasks.exe /Create /SC ONLOGON /RL LIMITED /F /TN $TaskName /TR "`"$NodeBin`" `"$cliPath`" --no-open" | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "schtasks /Create failed for task $TaskName" }
}

function Step3-ExtractAndConfigure {
  Write-Phase "3/6 Giải nén & cài đặt"
  $currentLink = Join-Path $OdHome "current"
  $currentItem = Get-Item -LiteralPath $currentLink -Force -ErrorAction SilentlyContinue
  if ($currentItem -and $currentItem.LinkType) {
    $targetVal = $currentItem.Target
    if ($targetVal -is [array]) { $targetVal = $targetVal[0] }
    $script:PrevCurrent = $targetVal
  }
  Expand-Release
  Write-ConfigEnv
  New-Item -ItemType Directory -Force -Path (Join-Path $OdHome "logs") | Out-Null
  Set-CurrentPointer
  Register-OdTask
}

# ---------------------------------------------------------------------------
# Step 4/6 -- service registration status (mirrors install.sh:507-521)
# ---------------------------------------------------------------------------
function Step4-ConfigureService {
  Write-Phase "4/6 Cấu hình dịch vụ"
  if ($NoStart) {
    Write-Step "-NoStart: service files written but not enabled"
    return
  }
  Write-Ok "Scheduled Task registered: $TaskName (Task Scheduler, ONLOGON trigger, per-user)"
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
        & taskkill.exe /PID $savedPid /T /F 2>$null | Out-Null
      }
    }
  }
  Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
}

function Start-OdService {
  Stop-OdService
  Start-Sleep -Seconds 1
  $logsDir = Join-Path $OdHome "logs"
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
  $outLog = Join-Path $logsDir "open-design.out.log"
  $errLog = Join-Path $logsDir "open-design.err.log"
  $cliPath = Join-Path $OdHome "current\apps\daemon\dist\cli.js"
  $pidFile = Join-Path $OdHome "open-design.pid"
  $proc = Start-Process -FilePath $NodeBin -ArgumentList @($cliPath, "--no-open") `
    -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
  Set-Content -Path $pidFile -Value $proc.Id -NoNewline
}

function Wait-OdHealth {
  param([int]$PortNum, [int]$Timeout = $HealthTimeout)
  $elapsed = 0
  while ($elapsed -lt $Timeout) {
    try {
      $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$PortNum/api/health" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
      if ($resp.StatusCode -eq 200) { return $true }
    } catch {
      # Not up yet -- mirrors install.sh's `|| echo 000`.
    }
    Start-Sleep -Seconds 2
    $elapsed += 2
  }
  return $false
}

function Invoke-Rollback {
  if ($PrevCurrent -and ($PrevCurrent -ne $ReleaseDir)) {
    Write-Warn "Health check failed — rolling back to $(Split-Path $PrevCurrent -Leaf)"
    $currentLink = Join-Path $OdHome "current"
    if (Test-Path $currentLink) { cmd /c rmdir "$currentLink" 2>$null | Out-Null }
    New-Item -ItemType Junction -Path $currentLink -Target $PrevCurrent -Force | Out-Null
    Register-OdTask
    Start-OdService
    if (Wait-OdHealth -PortNum $ResolvedPort -Timeout 30) {
      Write-Warn "Rolled back successfully. Release $Version was NOT activated."
    } else {
      Write-ErrorMsg "Rollback also failed the health check — manual intervention required."
    }
  } else {
    Stop-OdService
    Write-ErrorMsg "No previous release to roll back to. Service stopped."
  }
  Write-ErrorMsg "Install/update FAILED for version $Version. Logs: $OdHome\logs\"
  exit 1
}

function Step5-StartAndHealthCheck {
  Write-Phase "5/6 Khởi động & kiểm tra sức khỏe"
  if ($NoStart) {
    Write-Step "-NoStart: skipping service start and health check"
    return
  }
  Start-OdService
  Write-Step "Waiting for health check (up to $HealthTimeout s)..."
  if (Wait-OdHealth -PortNum $ResolvedPort -Timeout $HealthTimeout) {
    Write-Ok "Daemon is healthy on port $ResolvedPort"
  } else {
    Invoke-Rollback
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

function Install-ClaudeCli {
  Write-Warn "claude CLI not found on PATH — installing via the native Windows installer"
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
    Invoke-WebRequest -Uri "https://claude.ai/install.ps1" -OutFile $installerFile -UseBasicParsing
  } catch {
    Write-Warn "Claude CLI install failed — install manually: irm https://claude.ai/install.ps1 | iex"
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
      Write-Warn "Pinned Claude CLI install failed or is unsupported by the installer — falling back to latest"
    }
    & $shellExe -NoProfile -ExecutionPolicy Bypass -File $installerFile
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "Claude CLI install failed — install manually: irm https://claude.ai/install.ps1 | iex"
    }
  }
}

function Step6-ClaudeAndSummary {
  Write-Phase "6/6 Kiểm tra Claude CLI & hoàn tất"
  $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
  if ($claudeCmd) {
    Write-Ok "claude CLI found on PATH: $($claudeCmd.Source)"
  } else {
    Install-ClaudeCli
  }

  $loginOk = Test-ClaudeLogin

  # Final checklist -- od sandbox status already reports Claude sandbox
  # image/auth-volume health (Docker sandbox specific); best-effort, never
  # fails the install.
  if (-not $NoStart) {
    $cliPath = Join-Path $OdHome "current\apps\daemon\dist\cli.js"
    # Mirrors install.sh: stderr suppressed, stdout shown (this prints the
    # actual checklist to the user), non-zero exit never fails the install.
    & $NodeBin $cliPath sandbox status --daemon-url "http://127.0.0.1:$ResolvedPort" 2>$null
  }

  Write-Host ""
  Write-Host "  ── Cài đặt hoàn tất ──────────────────────────────" -ForegroundColor Green
  Write-Host ""
  if (-not $NoStart) {
    Write-Host "  URL:      http://127.0.0.1:$ResolvedPort"
  }
  Write-Host "  Version:  $Version"
  Write-Host "  Home:     $OdHome"
  Write-Host "  Config:   $(Join-Path $OdHome 'config.env')"
  Write-Host "  Service:  Task Scheduler (task: $TaskName) -- schtasks /Query /TN $TaskName"
  Write-Host ""
  if (-not $loginOk) {
    Write-Host '  còn một bước: chạy `claude /login` để đăng nhập Claude Code.' -ForegroundColor Yellow
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

  Step1-VerifyPackage
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
# registering a real Scheduled Task -- same seam as install.sh's
# OD_INSTALL_SH_TEST_SOURCE guard. Every real invocation (irm | iex,
# powershell -File install.ps1 ...) leaves this unset and runs normally.
try {
  if ($env:OD_INSTALL_PS1_TEST_SOURCE -ne "1") {
    Invoke-Main
  }
} finally {
  foreach ($d in $script:TempDirs) {
    Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
  }
}
