import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { DockerSetupResponse } from '@open-design/contracts';
import { resolveDockerCommand } from './agent-sandbox.js';

const execFileAsync = promisify(execFile);
const LOG_LIMIT = 160;

let state: DockerSetupResponse = {
  phase: 'idle',
  running: false,
  dockerOk: false,
  error: null,
  log: [],
};

function appendLog(value: string): void {
  for (const line of value.split(/\r?\n/)) {
    const clean = line.trimEnd();
    if (clean) state.log.push(clean);
  }
  if (state.log.length > LOG_LIMIT) state.log = state.log.slice(-LOG_LIMIT);
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function dockerReady(): Promise<boolean> {
  try {
    await execFileAsync(resolveDockerCommand(), ['info'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function spawnAndWait(command: string, args: string[]): Promise<void> {
  const logStart = state.log.length;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: false, env: process.env });
    child.stdout?.on('data', (chunk: Buffer) => appendLog(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => appendLog(chunk.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else {
        const detail = state.log.slice(logStart).slice(-8).join('\n');
        reject(new Error(
          `${path.basename(command)} kết thúc với mã ${code ?? 'không rõ'}.${detail ? `\n${detail}` : ''}`,
        ));
      }
    });
  });
}

async function firstAccessible(paths: string[]): Promise<string | null> {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known installation path.
    }
  }
  return null;
}

export function dockerDesktopMacDownload(nodeArch: string): { arch: 'arm64' | 'amd64'; url: string } {
  const arch = nodeArch === 'arm64' ? 'arm64' : 'amd64';
  return { arch, url: `https://desktop.docker.com/mac/main/${arch}/Docker.dmg` };
}

export function dockerDesktopWindowsDownload(nodeArch: string): { arch: 'arm64' | 'amd64'; url: string } {
  const arch = nodeArch === 'arm64' ? 'arm64' : 'amd64';
  return {
    arch,
    url: `https://desktop.docker.com/win/main/${arch}/Docker%20Desktop%20Installer.exe`,
  };
}

export function dockerDesktopWindowsInstallArgs(): string[] {
  return ['install', '--user', '--accept-license', '--backend=wsl-2'];
}

function powerShellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function dockerDesktopWindowsDownloadCommand(url: string, outputPath: string): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    `Invoke-WebRequest -UseBasicParsing -Uri ${powerShellSingleQuoted(url)} -OutFile ${powerShellSingleQuoted(outputPath)}`,
  ].join('; ');
}

export function dockerDesktopWindowsPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    `${env.LOCALAPPDATA ?? ''}\\Programs\\DockerDesktop\\Docker Desktop.exe`,
    `${env.ProgramFiles ?? 'C:\\Program Files'}\\Docker\\Docker\\Docker Desktop.exe`,
    `${env.LOCALAPPDATA ?? ''}\\Docker\\Docker Desktop.exe`,
  ];
}

export const MAC_DOCKER_INSTALLER_APPLESCRIPT = [
  'on run argv',
  '  set installerPath to item 1 of argv',
  '  set targetUser to item 2 of argv',
  '  do shell script quoted form of installerPath & " --user=" & quoted form of targetUser with administrator privileges',
  'end run',
].join('\n');

async function validMacDockerApp(): Promise<string | null> {
  const candidates = [
    '/Applications/Docker.app',
    path.join(homedir(), 'Applications', 'Docker.app'),
  ];
  for (const candidate of candidates) {
    if (!(await firstAccessible([candidate]))) continue;
    try {
      await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', candidate], { timeout: 30_000 });
      return candidate;
    } catch {
      appendLog(`Docker Desktop tại ${candidate} chưa hoàn chỉnh; app sẽ cài lại bản chính thức.`);
    }
  }
  return null;
}

async function installDockerDesktop(): Promise<void> {
  if (process.platform === 'darwin') {
    // Never run Homebrew in this background daemon: cask installation can
    // require an interactive administrator password and exits with code 1
    // when no TTY is available. Docker's signed installer is invoked through
    // AppleScript so macOS owns the native password dialog instead.
    const scratch = await mkdtemp(path.join(tmpdir(), 'open-design-docker-'));
    const dmg = path.join(scratch, 'Docker.dmg');
    const mount = path.join(scratch, 'mount');
    const download = dockerDesktopMacDownload(process.arch);
    let attached = false;
    try {
      await mkdir(mount);
      appendLog(`Đang tải Docker Desktop chính thức cho Mac ${download.arch === 'arm64' ? 'Apple Silicon' : 'Intel'}…`);
      await spawnAndWait('/usr/bin/curl', ['-fL', '--retry', '3', '-o', dmg, download.url]);
      await spawnAndWait('/usr/bin/hdiutil', ['attach', dmg, '-nobrowse', '-mountpoint', mount]);
      attached = true;
      const installer = path.join(mount, 'Docker.app', 'Contents', 'MacOS', 'install');
      await access(installer);
      appendLog('macOS sẽ yêu cầu mật khẩu quản trị để hoàn tất cài đặt Docker Desktop…');
      try {
        await spawnAndWait('/usr/bin/osascript', [
          '-e',
          MAC_DOCKER_INSTALLER_APPLESCRIPT,
          installer,
          userInfo().username,
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/canceled|cancelled|-128/i.test(message)) {
          throw new Error('Bạn đã hủy yêu cầu quyền quản trị. Docker Desktop chưa được cài.');
        }
        throw new Error(`Không thể cài Docker Desktop bằng quyền quản trị.\n${message}`);
      }
      if (!(await validMacDockerApp())) {
        throw new Error('Docker Desktop đã được chép nhưng chữ ký ứng dụng không hợp lệ hoặc bộ cài chưa hoàn tất.');
      }
      await spawnAndWait('/usr/bin/hdiutil', ['detach', mount]);
      attached = false;
    } finally {
      if (attached) await execFileAsync('/usr/bin/hdiutil', ['detach', mount], { timeout: 30_000 }).catch(() => {});
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
    return;
  }
  if (process.platform === 'win32') {
    if (await commandExists('winget')) {
      appendLog('Đang cài Docker Desktop qua WinGet…');
      try {
        await spawnAndWait('winget', [
          'install', '--id', 'Docker.DockerDesktop', '-e',
          '--accept-source-agreements', '--accept-package-agreements',
        ]);
        return;
      } catch {
        appendLog('WinGet không cài được Docker Desktop; chuyển sang bộ cài chính thức của Docker…');
      }
    }

    const scratch = await mkdtemp(path.join(tmpdir(), 'open-design-docker-'));
    const installer = path.join(scratch, 'Docker Desktop Installer.exe');
    const download = dockerDesktopWindowsDownload(process.arch);
    try {
      appendLog(`Đang tải bộ cài Docker Desktop chính thức cho Windows ${download.arch === 'arm64' ? 'ARM64' : 'x86_64'}…`);
      await spawnAndWait('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command',
        dockerDesktopWindowsDownloadCommand(download.url, installer),
      ]);
      appendLog('Đang cài Docker Desktop cho tài khoản Windows hiện tại…');
      await spawnAndWait(installer, dockerDesktopWindowsInstallArgs());
      if (!(await firstAccessible(dockerDesktopWindowsPaths()))) {
        throw new Error('Bộ cài đã chạy nhưng không tìm thấy Docker Desktop. Hãy kiểm tra yêu cầu WSL 2 rồi thử lại.');
      }
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
    return;
  }
  throw new Error('Cài Docker tự động hiện hỗ trợ macOS và Windows.');
}

async function startDockerDesktop(): Promise<void> {
  state.phase = 'starting';
  appendLog('Đang mở Docker Desktop…');
  if (process.platform === 'darwin') {
    const systemApp = '/Applications/Docker.app';
    const userApp = path.join(homedir(), 'Applications', 'Docker.app');
    const installedApp = await firstAccessible([systemApp, userApp]);
    if (installedApp) {
      await execFileAsync('/usr/bin/open', [installedApp], { timeout: 15_000 });
    } else {
      await execFileAsync('/usr/bin/open', ['-a', 'Docker'], { timeout: 15_000 });
    }
    return;
  }
  if (process.platform === 'win32') {
    const executable = await firstAccessible(dockerDesktopWindowsPaths());
    if (!executable) throw new Error('Đã cài nhưng không tìm thấy Docker Desktop để khởi động.');
    const child = spawn(executable, [], { detached: true, windowsHide: false, stdio: 'ignore' });
    child.unref();
    return;
  }
}

async function waitForDocker(): Promise<void> {
  state.phase = 'waiting';
  appendLog('Đang chờ Docker Engine sẵn sàng…');
  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    if (await dockerReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error('Docker Desktop chưa sẵn sàng sau 3 phút. Có thể máy cần khởi động lại.');
}

async function runSetup(): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      if (!(await dockerReady())) {
        if (!(await validMacDockerApp())) {
          state.phase = 'installing';
          await installDockerDesktop();
        }
        await startDockerDesktop();
        await waitForDocker();
      }
    } else {
      const resolvedDocker = resolveDockerCommand();
      if (resolvedDocker === 'docker' && !(await commandExists('docker'))) {
        state.phase = 'installing';
        await installDockerDesktop();
      }
      if (!(await dockerReady())) {
        await startDockerDesktop();
        await waitForDocker();
      }
    }
    state = { ...state, phase: 'ready', running: false, dockerOk: true, error: null };
    appendLog('Docker đã sẵn sàng.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state = { ...state, phase: 'error', running: false, dockerOk: false, error: message };
    appendLog(message);
  }
}

export async function getDockerSetupStatus(): Promise<DockerSetupResponse> {
  if (!state.running && await dockerReady()) {
    state = { ...state, phase: 'ready', dockerOk: true, error: null };
  }
  return { ...state, log: [...state.log] };
}

export function startDockerSetup(): DockerSetupResponse {
  if (!state.running) {
    state = { phase: 'installing', running: true, dockerOk: false, error: null, log: [] };
    void runSetup();
  }
  return { ...state, log: [...state.log] };
}
