import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(import.meta.dirname, '../..');
const installScript = join(repoRoot, 'deploy/host/install.ps1');
const launcherScript = join(repoRoot, 'deploy/host/launcher.ps1');

async function source(): Promise<string> {
  return readFile(installScript, 'utf8');
}

test('Windows downloads use bounded retries, a STALL timeout (no total cap), Range resume, and partial-file promotion', async () => {
  const ps = await source();
  assert.match(ps, /\$DownloadMaxAttempts\s*=\s*3/);
  // 0.8.46 regression: a 180 s TOTAL timeout cancelled a 99 MB download at
  // 40% on a slow corporate link, three times, restarting from byte 0 each
  // time. The timeout is now per-stall and the transfer itself is uncapped.
  assert.match(ps, /\$DownloadTimeoutSec\s*=\s*60/);
  assert.match(ps, /\$client\.Timeout = \[System\.Threading\.Timeout\]::InfiniteTimeSpan/);
  assert.match(ps, /HttpCompletionOption\]::ResponseHeadersRead/);
  assert.match(ps, /ReadAsync\(\$buffer, 0, \$buffer\.Length, \$cts\.Token\)/);
  // The stall timer is re-armed after every successful read.
  const loop = ps.slice(ps.indexOf('while (($count = $input.ReadAsync('), ps.indexOf('$output.Write($buffer, 0, $count)'));
  assert.match(loop, /\$cts\.CancelAfter\(\[TimeSpan\]::FromSeconds\(\$TimeoutSec\)\)/);
  // Retries resume with a Range request instead of re-downloading.
  assert.match(ps, /\$request\.Headers\.Range = \[System\.Net\.Http\.Headers\.RangeHeaderValue\]::new\(\$resumeFrom, \$null\)/);
  assert.match(ps, /\[int\]\$response\.StatusCode -eq 206/);
  assert.match(ps, /\[System\.IO\.FileMode\]::Append/);
  assert.match(ps, /\$partial\s*=\s*"\$Destination\.partial"/);
  assert.match(ps, /Move-Item -LiteralPath \$partial -Destination \$Destination -Force/);
  // A stall mid-body (status 200/206 already received) must still be retried.
  assert.match(ps, /\$statusCode -eq 206 -or \$statusCode -eq 200/);
});

test('Windows download progress is interactive-only and logging is append-only/best-effort', async () => {
  const ps = await source();
  assert.match(ps, /return -not \[Console\]::IsOutputRedirected/);
  assert.match(ps, /\$ProgressBarWidth = 30/);
  assert.match(ps, /\$bar = \('=' \* \$filled\)\.PadRight\(\$ProgressBarWidth, '\.'\)/);
  assert.match(ps, /\$line = "`r\s+\[\{0\}\] \{1,3\}%[^\n]*" -f \$bar, \$percent/);
  assert.match(ps, /\[Console\]::Write\(\$line\)/);
  // A `-f` with commas INSIDE a method-call argument list splits into separate
  // arguments (PowerShell disables the comma operator there) -- the format
  // then throws and the swallowed error hid the whole progress display.
  const code = ps.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /\[Console\]::Write(Line)?\("[^"\n]*"\s+-f\s+[^)\n]*,/);
  assert.match(ps, /Add-Content -Path \$script:ProgressLogPath/);
  assert.match(ps, /Download telemetry is best-effort and must never affect installation/);
});

test('Windows persistent auto-start uses current-user HKCU Run without requiring Task Scheduler rights', async () => {
  const ps = await source();
  const register = ps.slice(ps.indexOf('function Register-OdStartup'), ps.indexOf('function Step3-ExtractAndConfigure'));
  assert.match(ps, /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run/);
  assert.match(register, /New-ItemProperty -Path \$StartupRegistryPath -Name \$StartupValueName/);
  assert.doesNotMatch(register, /Register-ScheduledTask/);
  assert.match(register, /Unregister-ScheduledTask -TaskName \$LegacyTaskName/);
  assert.doesNotMatch(ps, /Register-ScheduledTask|Start-ScheduledTask/);
});

test('Windows release extraction validates staging before promotion and preserves a live same-version path', async () => {
  const ps = await source();
  const staging = ps.indexOf('$stagingDir = Join-Path $releasesDir');
  const validation = ps.indexOf('staged release is incomplete');
  const promotion = ps.indexOf('Move-Item -LiteralPath $stagingDir -Destination $ReleaseDir');
  assert.ok(staging >= 0 && validation > staging && promotion > validation);
  assert.match(ps, /\$stagedInstaller = Join-Path \$stagingDir "install\.ps1"/);
  assert.match(ps, /required VERSION, daemon cli\.js, install\.ps1, and launcher\.ps1/);
  assert.match(ps, /Never replace the directory backing the live junction/);
  assert.match(ps, /\.backup-\$Version-/);
});

test('Windows bundles a stable single-instance launcher that supervises the daemon', async () => {
  const ps = await source();
  const launcher = await readFile(launcherScript, 'utf8');
  const build = await readFile(join(repoRoot, 'scripts/host-runtime/build-runtime.sh'), 'utf8');
  assert.match(ps, /function Install-OdLauncher/);
  assert.match(ps, /\[System\.IO\.File\]::Replace\(\$temporary, \$LauncherPath, \$null, \$true\)/);
  assert.match(ps, /function Start-OdLauncher/);
  assert.match(ps, /function Stop-OdLauncher/);
  assert.match(ps, /-ArgumentList @\("`"\$cliPath`"", "--no-open"\)/);
  assert.match(launcher, /Local\\OpenDesignLauncher-\$homeHash/);
  assert.match(launcher, /elseif \(-not \(Test-DaemonAlive\)\)/);
  assert.match(launcher, /function Test-MaintenanceActive/);
  assert.match(launcher, /\$maintenanceBlocksStart = \(Test-MaintenanceActive\) -and -not \(Test-Path \$transactionPath\)/);
  assert.match(launcher, /Invoke-InstalledStart/);
  assert.match(build, /deploy\/host\/launcher\.ps1.*STAGE_DIR.*launcher\.ps1/);
});

test('Windows ships double-click command files for install, update, start, and stop', async () => {
  const ps = await source();
  const build = await readFile(join(repoRoot, 'scripts/host-runtime/build-runtime.sh'), 'utf8');
  const commandFiles = await Promise.all(
    ['install.cmd', 'update.cmd', 'start.cmd', 'stop.cmd'].map(async (name) => ({
      name,
      body: await readFile(join(repoRoot, 'deploy/host', name), 'utf8'),
    })),
  );
  for (const { name, body } of commandFiles) {
    assert.match(body, /powershell\.exe -NoProfile/);
    assert.match(body, /--no-pause/);
    assert.match(body, /pause/);
    assert.doesNotMatch(body, /runas|Start-Process[^\r\n]+-Verb\s+RunAs/i);
    assert.match(build, new RegExp(`deploy/host/\\$\\{command_file\\}`));
    assert.match(ps, new RegExp(name.replace('.', '\\.')));
  }
  const installCmd = commandFiles.find(({ name }) => name === 'install.cmd')!.body;
  assert.match(installCmd, /Invoke-WebRequest/);
  // cmd expands %VAR% for a whole parenthesised block at parse time, so a
  // variable assigned inside a block must NOT be read via %VAR% inside the
  // same block (0.8.32: `powershell -File ''` on a fresh install because
  // OD_INSTALLER was copied from a just-set OD_BOOTSTRAP_INSTALLER). The temp
  // path is therefore computed BEFORE the block and only copied inside it.
  const candidateLine = installCmd.indexOf('set "OD_BOOTSTRAP_CANDIDATE=');
  const blockStart = installCmd.indexOf('if exist "%OD_HOME%\\current\\install.ps1" (');
  assert.ok(candidateLine > -1 && blockStart > -1 && candidateLine < blockStart, 'OD_BOOTSTRAP_CANDIDATE must be set before the if-block');
  assert.doesNotMatch(installCmd, /set "OD_INSTALLER=%OD_BOOTSTRAP_INSTALLER%"/);
  assert.match(installCmd, /set "OD_INSTALLER=%OD_BOOTSTRAP_CANDIDATE%"/);
  assert.match(installCmd, /-OutFile \$env:OD_BOOTSTRAP_CANDIDATE/);
  assert.match(commandFiles.find(({ name }) => name === 'update.cmd')!.body, /-Update/);
  assert.match(commandFiles.find(({ name }) => name === 'start.cmd')!.body, /-Start/);
  assert.match(commandFiles.find(({ name }) => name === 'stop.cmd')!.body, /-Stop/);
  assert.match(ps, /function Install-OdCommandFiles/);
  assert.match(build, /OpenDesign-Install\.cmd/);
  // Release page ships ONE Windows zip (counterpart of OpenDesign-macOS-Installer.zip),
  // no loose OpenDesign-*.cmd assets.
  assert.match(build, /OpenDesign-Windows-Installer\.zip/);
  assert.doesNotMatch(build, /"\$\{OUT_DIR\}\/OpenDesign-Install\.cmd"/);
  const workflow = await readFile(join(repoRoot, '.github/workflows/release-host-runtime.yml'), 'utf8');
  assert.doesNotMatch(workflow, /out\/\*\.cmd/);
  assert.match(workflow, /OpenDesign-Windows-Installer\.zip, unzip/);
});

test('Windows release.json lookup decodes octet-stream bodies (PowerShell 5.1 returns byte[])', async () => {
  const ps = await source();
  const web = ps.slice(ps.indexOf('function Invoke-WebText'), ps.indexOf('function Get-FlatJsonValue'));
  // 0.8.34: OpenDesign-Install.cmd (powershell.exe 5.1) -> "release.json has
  // no entry for platform win32-x64" because GitHub serves release assets as
  // application/octet-stream and 5.1 hands .Content back as byte[].
  assert.match(web, /if \(\$content -is \[byte\[\]\]\)/);
  assert.match(web, /\[System\.Text\.Encoding\]::UTF8\.GetString\(\$content\)/);
  assert.match(ps, /did not parse as a JSON object/);
});

test('Windows installer does not depend on PS 5.1 script-module cmdlets (Get-FileHash, Expand-Archive)', async () => {
  const ps = await source();
  // 0.8.35: powershell.exe spawned from a pwsh host could not auto-load
  // Get-FileHash ("not recognized"); both live in script modules on 5.1.
  const body = ps
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(body, /\bGet-FileHash\b/);
  assert.doesNotMatch(body, /\bExpand-Archive\b/);
  assert.match(ps, /\[System\.Security\.Cryptography\.SHA256\]::Create\(\)/);
  assert.match(ps, /\[System\.IO\.Compression\.ZipFile\]::OpenRead/);
  assert.match(ps, /zip entry escapes destination/);
});

test('Windows network preflight probes with HEAD, a 10s budget, and a retry', async () => {
  const ps = await source();
  const probe = ps.slice(ps.indexOf('function Test-PreflightProbe'), ps.indexOf('function Invoke-PreflightCheck'));
  // 0.8.35: GET of the github.com homepage timed out at 5s on a slow link
  // and blocked the install although GitHub was reachable.
  assert.match(probe, /Invoke-WebRequest -Uri \$Url -Method Head -TimeoutSec 10 -UseBasicParsing/);
  assert.match(probe, /\$attempt -le 2/);
  assert.match(probe, /if \(\$_\.Exception\.Response\) \{ return \$true \}/);
});

test('Windows installer auto-bypasses TLS trust only when github.com is proxy-re-signed', async () => {
  const ps = await source();
  assert.match(ps, /\[switch\]\$InsecureTls/);
  // 5.1: compiled C# callback (scriptblocks cannot run on the thread-pool
  // threads that async HttpClient validation fires on); pwsh 7: -SkipCertificateCheck.
  assert.match(ps, /public static class OdTrustAllCerts/);
  assert.match(ps, /ServicePointManager\.ServerCertificateValidationCallback = Validate/);
  assert.match(ps, /\$script:IwrExtra = @\{ SkipCertificateCheck = \$true \}/);
  assert.match(ps, /DangerousAcceptAnyServerCertificateValidator/);
  // Only offered on TrustFailure (not DNS/connect/timeout), interactive prompt, persisted for -Update.
  const preflight = ps.slice(ps.indexOf('function Invoke-PreflightCheck'), ps.indexOf('function Step1-VerifyPackage'));
  assert.match(preflight, /Test-TlsTrustFailure "https:\/\/github\.com"/);
  // Default: auto-bypass on TrustFailure (no prompt), validation stays on elsewhere.
  const trustBranch = preflight.slice(preflight.indexOf('Test-TlsTrustFailure "https://github.com"'), preflight.indexOf('if ($githubOk)'));
  assert.match(trustBranch, /Enable-InsecureTls/);
  assert.doesNotMatch(trustBranch, /Read-Host|Fail "/);
  assert.match(ps, /if \(\$InsecureTlsActive\) \{ \$lines\.Add\("OD_INSECURE_TLS=1"\) \}/);
  assert.match(ps, /\(Get-ExistingConfigValue "OD_INSECURE_TLS"\) -eq "1"/);
  // Every outbound Invoke-WebRequest honours the pwsh-7 splat.
  const detector = ps.slice(ps.indexOf('function Test-TlsTrustFailure'), ps.indexOf('function Invoke-DownloadFile'));
  const outbound = ps
    .replace(detector, '')
    .split('\n')
    .filter((l) => /Invoke-WebRequest -Uri/.test(l) && !/127\.0\.0\.1/.test(l) && !l.trimStart().startsWith('#'));
  assert.ok(outbound.length >= 2);
  for (const line of outbound) assert.match(line, /@IwrExtra/, line);
});

test('Windows start evicts a stale Open Design daemon on the port and health-checks the installed version', async () => {
  const ps = await source();
  // 2026-08-17: install "succeeded" against an old 0.8.25 daemon still
  // listening on 7456 (health 200, "/" 404); only a reboot fixed it.
  const start = ps.slice(ps.indexOf('function Start-OdService'), ps.indexOf('function Save-UpdateTransaction'));
  assert.match(start, /Stop-StalePortOwner -PortNum \$ResolvedPort/);
  assert.match(ps, /netstat\.exe -ano -p tcp/);
  const evict = ps.slice(ps.indexOf('function Stop-StalePortOwner'), ps.indexOf('function Start-OdService'));
  assert.match(evict, /\/api\/health/);
  assert.match(evict, /\$proc\.ProcessName -match '\^node'/);
  assert.match(evict, /Fail "Port \$PortNum is already in use by/);
  const healthStart = ps.indexOf('function Wait-OdHealth');
  const health = ps.slice(healthStart, ps.indexOf('\nfunction ', healthStart + 1));
  assert.match(health, /\[string\]\$ExpectedVersion = ""/);
  assert.match(health, /if \(\$seen -eq \$ExpectedVersion\) \{ return \$true \}/);
  const step5 = ps.slice(ps.indexOf('function Step5-StartAndHealthCheck'), ps.indexOf('# Step 6/6'));
  assert.match(step5, /Wait-OdHealth -PortNum \$ResolvedPort -Timeout \$HealthTimeout -ExpectedVersion \$Version/);
});

test('Windows fresh install removes an existing installation first (Install = clean install); .cmd never routes to -Update', async () => {
  const ps = await source();
  const remove = ps.slice(ps.indexOf('function Remove-ExistingInstallation'), ps.indexOf('function Invoke-UninstallCommand'));
  assert.match(remove, /Stop-OdLauncher/);
  assert.match(remove, /Stop-OdService/);
  assert.match(remove, /Remove-ItemProperty -Path \$StartupRegistryPath/);
  assert.match(remove, /cmd \/c rmdir "\$currentLink"/);
  assert.match(remove, /Remove-Item -Recurse -Force \$OdHome/);
  assert.match(remove, /project data is kept/);
  const main = ps.slice(ps.indexOf('function Invoke-Main'));
  assert.match(main, /Step1-VerifyPackage\s+if \(-not \$Update\) \{ Remove-ExistingInstallation \}\s+Step2-EnsureNode/);

  const installCmd = await readFile(join(repoRoot, 'deploy/host/install.cmd'), 'utf8');
  const installCmdCode = installCmd.split(/\r?\n/).filter((l) => !/^\s*rem\b/i.test(l)).join('\n');
  assert.doesNotMatch(installCmdCode, /-Update/);
  assert.match(installCmd, /Removing the previous version first/);
  // The tail runs inside one parenthesised block (this .cmd may be deleted
  // with the old install mid-run) and therefore uses delayed expansion.
  assert.match(installCmd, /setlocal EnableDelayedExpansion/);
  assert.match(installCmd, /\(\s*\r?\n\s*powershell\.exe -NoProfile -ExecutionPolicy Bypass -File "%OD_INSTALLER%"\s*\r?\n\s*set "OD_EXIT=!ERRORLEVEL!"/);
  assert.match(installCmd, /exit \/b !OD_EXIT!/);
});

test('Windows prunes old releases only after a confirmed healthy start, never on -NoStart or in rollback', async () => {
  const ps = await source();
  const complete = ps.slice(ps.indexOf('function Complete-InstallationTransaction'), ps.indexOf('function Remove-OldReleases'));
  assert.doesNotMatch(complete, /Remove-OldReleases/); // -NoStart also commits; no health = no prune
  const step5 = ps.slice(ps.indexOf('function Step5-StartAndHealthCheck'), ps.indexOf('# Step 6/6'));
  assert.match(step5, /Write-Ok "Daemon \$Version is healthy on port \$ResolvedPort"\s+Complete-InstallationTransaction\s+Remove-OldReleases/);
  const start = ps.slice(ps.indexOf('function Invoke-StartCommand'), ps.indexOf('function Remove-ExistingInstallation'));
  assert.match(start, /Pending update transaction committed\."\s+Remove-OldReleases/);
  const prune = ps.slice(ps.indexOf('function Remove-OldReleases'), ps.indexOf('function Step5-StartAndHealthCheck'));
  assert.match(prune, /if \(\$entryFull -ieq \$currentFull\) \{ continue \}/);
  assert.match(prune, /Remove-Item -LiteralPath \$entry\.FullName -Recurse -Force -ErrorAction Stop/);
  const rollback = ps.slice(ps.indexOf('function Invoke-Rollback'), ps.indexOf('function Complete-InstallationTransaction'));
  assert.doesNotMatch(rollback, /Remove-OldReleases/);
});

test('Windows config replacement and rollback are atomic and transaction guarded', async () => {
  const ps = await source();
  assert.match(ps, /\[System\.IO\.File\]::Replace\(\$configTemp, \$configPath, \$ConfigBackupPath, \$true\)/);
  assert.match(ps, /Copy-Item -LiteralPath \$ConfigBackupPath -Destination \$configRestoreTemp/);
  assert.match(ps, /\[System\.IO\.File\]::Replace\(\$configRestoreTemp, \$configPath, \$null, \$true\)/);
  assert.match(ps, /-not \$HealthSucceeded -and -not \$RestartHandedOff/);
  assert.match(ps, /PipelineStoppedException \(Ctrl\+C\)/);
  assert.match(ps, /\$rollbackSucceeded = \$pointerRestored -and \$configRestored -and \$releaseRestored -and \$oldDaemonHealthy/);
  assert.match(ps, /Rollback is incomplete; durable transaction kept/);
  assert.match(ps, /No previous release to roll back[\s\S]*Remove-ItemProperty|Remove-ItemProperty[\s\S]*No previous release to roll back/);
  assert.match(ps, /Set-Content -LiteralPath \$MaintenancePath/);
  assert.match(ps, /if \(\$Update\) \{ Save-UpdateTransaction \}\s+Set-CurrentPointer/);
  assert.match(ps, /Remove-Item -LiteralPath \$MaintenancePath -Force/);
});

test('Windows launcher handoff is durable and marked before publishing the restart request', async () => {
  const ps = await source();
  const delegate = ps.indexOf('function Request-LauncherUpdateRestart');
  const handoff = ps.indexOf('$script:RestartHandedOff = $true', delegate);
  const publish = ps.indexOf('Move-Item -LiteralPath $requestTemp -Destination $RestartRequestPath', handoff);
  assert.ok(handoff >= 0 && publish > handoff);
  assert.match(ps.slice(delegate, ps.indexOf('function Wait-OdHealth')), /Test-OdLauncherAlive/);
  const step5 = ps.slice(ps.indexOf('function Step5-StartAndHealthCheck'), ps.indexOf('# ---------------------------------------------------------------------------\n# Step 6/6'));
  assert.ok(step5.indexOf('Save-UpdateTransaction') < step5.indexOf('Request-LauncherUpdateRestart'));
});

test('Windows self-update degrades to restart-required without rolling back the installed release', async () => {
  const ps = await source();
  assert.match(ps, /\$RestartRequiredExitCode\s*=\s*75/);
  assert.match(ps, /\$script:RestartHandedOff = \$true\s+\$script:RestartRequired = \$true/);
  assert.match(ps, /if \(\$RestartRequired\) \{\s+Write-Warn \$failure\.Exception\.Message\s+exit \$RestartRequiredExitCode/);
});

test('launcher-owned Start imports durable state and commits or rolls back it based on health', async () => {
  const ps = await source();
  const saver = ps.slice(ps.indexOf('function Save-UpdateTransaction'), ps.indexOf('function Test-TransactionPathUnder'));
  assert.match(saver, /previousCurrent = \$PrevCurrent/);
  assert.match(saver, /configBackupPath = \$ConfigBackupPath/);
  assert.match(saver, /previousReleaseBackup = \$PreviousReleaseBackup/);
  assert.match(saver, /\[System\.IO\.File\]::Replace\(\$stateTemp, \$UpdateTransactionPath, \$null, \$true\)/);

  const start = ps.slice(ps.indexOf('function Invoke-StartCommand'), ps.indexOf('function Invoke-UninstallCommand'));
  assert.match(start, /\$transactionPending = Import-UpdateTransaction/);
  assert.match(start, /if \(\$transactionPending\)[\s\S]*Set-CurrentPointer/);
  assert.match(start, /if \(\$transactionPending\) \{\s+Complete-InstallationTransaction/);
  assert.match(start, /if \(\$transactionPending\) \{\s+Invoke-Rollback -Reason "Update restart failed its health check"/);

  const importer = ps.slice(ps.indexOf('function Import-UpdateTransaction'), ps.indexOf('function Remove-UpdateTransaction'));
  assert.match(importer, /\$script:PrevCurrent = \[string\]\$state\.previousCurrent/);
  assert.match(importer, /\$script:ConfigBackupPath = \[string\]\$state\.configBackupPath/);
  assert.match(importer, /Test-TransactionPathUnder/);

  const complete = ps.slice(ps.indexOf('function Complete-InstallationTransaction'), ps.indexOf('function Step5-StartAndHealthCheck'));
  assert.match(complete, /Remove-Item -Force \$ConfigBackupPath -ErrorAction Stop/);
  assert.match(complete, /Remove-Item -Recurse -Force \$PreviousReleaseBackup -ErrorAction Stop/);
  assert.match(complete, /if \(\$cleanupComplete\) \{ \[void\]\(Remove-UpdateTransaction\) \}/);
  assert.match(complete, /Remove-UpdateTransaction/);
});

test('Windows installer rejects invalid command combinations and ports', async () => {
  const ps = await source();
  assert.match(ps, /-Start, -Stop, and -Uninstall are mutually exclusive/);
  assert.match(ps, /-DeleteData is only valid with -Uninstall/);
  assert.match(ps, /-Port must be an integer from 1 to 65535/);
  assert.match(ps, /throw \[System\.InvalidOperationException\]::new\(\$msg\)/);
});

// 2026-08-18: OpenDesign-Install.cmd "downloads very slowly" at the VNPAY
// office. Root cause was the network, not the script: the corporate proxy
// TLS-inspects github.com (curl.exe: SEC_E_UNTRUSTED_ROOT) and caps a single
// connection at ~200-500 KB/s, while a non-inspected CDN (nodejs.org) ran at
// 11 MB/s from the same desk. Two mitigations are pinned here: a download
// mirror selectable via OD_RELEASE_URL, and throughput on the progress bar so
// the next report carries the diagnosis.
test('Windows installer can install from a mirror via OD_RELEASE_URL and persists it for -Update', async () => {
  const ps = await source();
  const cmd = await readFile(join(repoRoot, 'deploy/host/install.cmd'), 'utf8');
  assert.match(ps, /function Resolve-ReleaseUrl/);
  const resolve = ps.slice(ps.indexOf('function Resolve-ReleaseUrl'), ps.indexOf('function Invoke-PreflightCheck'));
  // Priority: -ReleaseUrl flag > env > config.env (so the daemon-spawned -Update keeps the mirror).
  assert.match(resolve, /if \(-not \$ReleaseUrl\) \{/);
  assert.match(resolve, /\$env:OD_RELEASE_URL/);
  assert.match(resolve, /Get-ExistingConfigValue "OD_RELEASE_URL"/);
  // Only a base URL (folder with release.json) is treated as a mirror; a
  // one-off direct .tar.gz URL must never be persisted.
  assert.match(resolve, /-notmatch '\\\.tar\\\.gz\$'/);
  assert.match(resolve, /\$script:ReleaseUrlIsMirrorBase = \$true/);
  const config = ps.slice(ps.indexOf('function Write-ConfigEnv'), ps.indexOf('function Set-CurrentPointer'));
  assert.match(config, /if \(\$ReleaseUrlIsMirrorBase\) \{ \$lines\.Add\("OD_RELEASE_URL=\$ReleaseUrl"\) \}/);
  // Resolve-ReleaseUrl runs before the preflight so the mirror host (not
  // github.com) is what gets probed.
  const main = ps.slice(ps.indexOf('function Invoke-Main'), ps.indexOf('Step1-VerifyPackage', ps.indexOf('function Invoke-Main')));
  assert.match(main, /Resolve-ReleaseUrl\s*\n\s*Invoke-PreflightCheck/);
  const preflight = ps.slice(ps.indexOf('function Invoke-PreflightCheck'), ps.indexOf('function Step1-VerifyPackage'));
  assert.match(preflight, /if \(-not \$Archive -and \$ReleaseUrl\) \{/);
  assert.match(preflight, /GetLeftPart\(\[System\.UriPartial\]::Authority\)/);
  // The double-click .cmd fetches its bootstrap install.ps1 from the mirror too.
  assert.match(cmd, /if defined OD_RELEASE_URL \(/);
  assert.match(cmd, /set "OD_BOOTSTRAP_URL=!OD_BOOTSTRAP_URL!\/install\.ps1"/);
  assert.match(cmd, /-Uri \$env:OD_BOOTSTRAP_URL/);
});

test('Windows download progress reports throughput (KB/s) on the bar and in the log', async () => {
  const ps = await source();
  const dl = ps.slice(ps.indexOf('function Invoke-DownloadFile'), ps.indexOf('function Invoke-WebText'));
  assert.match(dl, /\$stopwatch = \[System\.Diagnostics\.Stopwatch\]::StartNew\(\)/);
  assert.match(dl, /\$kbps = \[int\]\(\(\$received - \$resumeFrom\) \/ 1024 \/ \$elapsedSec\)/);
  assert.match(dl, /\{4,6:N0\} KB\/s" -f \$bar, \$percent, \(\$received \/ 1MB\), \(\$total \/ 1MB\), \$kbps/);
  assert.match(dl, /Write-DownloadLog "download \$milestone% \(\$received\/\$total bytes, \$kbps KB\/s\)"/);
  assert.match(dl, /download complete \(\$received bytes, avg \$kbps KB\/s over/);
});
