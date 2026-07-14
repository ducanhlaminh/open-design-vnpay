# One-time machine setup for the Open Design (VNPAY) desktop app on Windows.
# BEFORE running: copy this file and setup-open-design-windows.bat into the
# SAME folder as "Open Design.exe" (the win-unpacked folder from the zip).
# Run this ONCE, before using pipeline steps for the first time. Prefer
# double-clicking setup-open-design-windows.bat, which launches this script.
#
# What it does:
#   1. Makes sure Docker Desktop is installed and running (pipeline steps
#      run the AI agent inside a sandboxed Docker container).
#   2. Builds the two Docker images the app needs, using the Dockerfiles
#      already bundled next to Open Design.exe (so the version always
#      matches whatever build you have - no download, no version drift).
#   3. Logs the sandbox in to your Claude account once (opens a browser).
# After this finishes, just open Open Design.exe and log in with Google.

$ErrorActionPreference = 'Stop'

$ImageName = 'od-agent-sandbox'
$AuthVolume = 'od-claude-auth'

function Say($msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "OK  $msg" -ForegroundColor Green }
function FailOut($msg) { Write-Host "X   $msg" -ForegroundColor Red; Read-Host 'Nhan Enter de dong cua so nay'; exit 1 }

Say 'Tim app Open Design da giai nen...'
$ScriptDir = $PSScriptRoot
$ExePath = Join-Path $ScriptDir 'Open Design.exe'
$BuilderDir = Join-Path $ScriptDir 'resources\open-design\skills\ui-react\builder'
if (-not (Test-Path $ExePath) -or -not (Test-Path (Join-Path $BuilderDir 'Dockerfile'))) {
  FailOut "Khong thay 'Open Design.exe' hoac cau hinh sandbox cung thu muc voi file setup nay ($ScriptDir). Copy 2 file setup-open-design-windows.bat va .ps1 vao ben trong thu muc win-unpacked (cung cho voi Open Design.exe) roi chay lai."
}
Ok "Tim thay app tai: $ExePath"

Say 'Kiem tra Docker Desktop...'
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCmd) {
  Say 'Chua co Docker - dang cai qua winget...'
  $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $wingetCmd) {
    FailOut 'May chua co winget. Tu cai Docker Desktop tai https://www.docker.com/products/docker-desktop roi chay lai file nay.'
  }
  winget install --id Docker.DockerDesktop -e --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) {
    FailOut 'Cai Docker Desktop qua winget that bai. Tu cai thu cong tai https://www.docker.com/products/docker-desktop roi chay lai file nay.'
  }
  Ok 'Da cai Docker Desktop. May co the can khoi dong lai truoc khi Docker chay duoc.'
}

Say 'Khoi dong Docker Desktop (neu chua chay)...'
$dockerDesktopExe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
if (Test-Path $dockerDesktopExe) {
  Start-Process $dockerDesktopExe -ErrorAction SilentlyContinue
}

Write-Host 'Dang cho Docker khoi dong' -NoNewline
$tries = 0
while ($true) {
  docker info *> $null
  if ($LASTEXITCODE -eq 0) { break }
  $tries++
  if ($tries -gt 60) {
    Write-Host ''
    FailOut 'Docker Desktop chua chay sau 3 phut. Mo app Docker Desktop bang tay, cho no chuyen sang trang thai chay, roi chay lai file nay.'
  }
  Write-Host '.' -NoNewline
  Start-Sleep -Seconds 3
}
Write-Host ''
Ok 'Docker dang chay.'

$Platform = 'linux/amd64'
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $Platform = 'linux/arm64' }

$ToolkitVersion = (Get-Content (Join-Path $BuilderDir 'base\toolkit.version') -Raw).Trim()
$SandboxVersion = (Get-Content (Join-Path $BuilderDir 'sandbox\sandbox.version') -Raw).Trim()
$ClaudeVersion = (Get-Content (Join-Path $BuilderDir 'sandbox\claude.version') -Raw).Trim()
$BaseImage = "uireact-base:$ToolkitVersion"
$SandboxImage = "${ImageName}:$SandboxVersion"

docker image inspect $BaseImage *> $null
if ($LASTEXITCODE -eq 0) {
  Ok "$BaseImage da co san - bo qua buoc build."
} else {
  Say "Dang build $BaseImage ($Platform) - lan dau mat vai phut..."
  docker build --platform $Platform -t $BaseImage -t uireact-base:latest -f (Join-Path $BuilderDir 'Dockerfile') $BuilderDir
  if ($LASTEXITCODE -ne 0) { FailOut "Build $BaseImage that bai." }
  Ok "Da build $BaseImage."
}

docker image inspect $SandboxImage *> $null
if ($LASTEXITCODE -eq 0) {
  Ok "$SandboxImage da co san - bo qua buoc build."
} else {
  Say "Dang build $SandboxImage ($Platform)..."
  $SandboxDir = Join-Path $BuilderDir 'sandbox'
  docker build --platform $Platform `
    --build-arg TOOLKIT_VERSION=$ToolkitVersion `
    --build-arg CLAUDE_CODE_VERSION=$ClaudeVersion `
    -t $SandboxImage -t "${ImageName}:latest" `
    -f (Join-Path $SandboxDir 'Dockerfile') $SandboxDir
  if ($LASTEXITCODE -ne 0) { FailOut "Build $SandboxImage that bai." }
  Ok "Da build $SandboxImage."
}

docker volume create $AuthVolume *> $null

Say 'Dang nhap Claude cho sandbox (trinh duyet se mo ra, chi can lam 1 lan)...'
docker run -it --rm -v "${AuthVolume}:/home/node/.claude" $SandboxImage claude /login
if ($LASTEXITCODE -ne 0) {
  FailOut "Dang nhap chua xong. Chay lai file nay, hoac tu chay: docker run -it --rm -v ${AuthVolume}:/home/node/.claude $SandboxImage claude /login"
}

Ok 'Xong! Gio mo Open Design.exe va dang nhap bang Google la dung duoc.'
Read-Host 'Nhan Enter de dong cua so nay'
